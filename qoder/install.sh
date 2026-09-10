#!/bin/sh
set -eu

MANIFEST_URL="${CONTEXT_SERVICE_QODER_RELEASE_MANIFEST_URL:-https://context-database-client.oss-cn-hangzhou.aliyuncs.com/qoder/stable/latest.json}"

expect_value=""
requested_version=""
base_url=""
api_key=""
seen_version=0
seen_base_url=0
seen_api_key=0
dry_run=0
json_output=0
for installer_argument in "$@"; do
  if [ -n "$expect_value" ]; then
    case "$installer_argument" in
      --*) echo "[context-service] --$expect_value 缺少参数值" >&2; exit 2 ;;
    esac
    case "$expect_value" in
      version) requested_version="$installer_argument" ;;
      base-url) base_url="$installer_argument" ;;
      api-key) api_key="$installer_argument" ;;
    esac
    expect_value=""
    continue
  fi
  case "$installer_argument" in
    --version)
      [ "$seen_version" -eq 0 ] || { echo "[context-service] --version 不得重复指定" >&2; exit 2; }
      seen_version=1
      expect_value="version"
      ;;
    --version=*)
      [ "$seen_version" -eq 0 ] || { echo "[context-service] --version 不得重复指定" >&2; exit 2; }
      seen_version=1
      requested_version=${installer_argument#--version=}
      ;;
    --base-url)
      [ "$seen_base_url" -eq 0 ] || { echo "[context-service] --base-url 不得重复指定" >&2; exit 2; }
      seen_base_url=1
      expect_value="base-url"
      ;;
    --base-url=*)
      [ "$seen_base_url" -eq 0 ] || { echo "[context-service] --base-url 不得重复指定" >&2; exit 2; }
      seen_base_url=1
      base_url=${installer_argument#--base-url=}
      ;;
    --api-key)
      [ "$seen_api_key" -eq 0 ] || { echo "[context-service] --api-key 不得重复指定" >&2; exit 2; }
      seen_api_key=1
      expect_value="api-key"
      ;;
    --api-key=*)
      [ "$seen_api_key" -eq 0 ] || { echo "[context-service] --api-key 不得重复指定" >&2; exit 2; }
      seen_api_key=1
      api_key=${installer_argument#--api-key=}
      ;;
    --dry-run) dry_run=1 ;;
    --json) json_output=1 ;;
  esac
done
if [ -n "$expect_value" ]; then
  echo "[context-service] --$expect_value 缺少参数值" >&2
  exit 2
fi
if [ -z "$base_url" ] || [ -z "$api_key" ]; then
  echo "[context-service] install 必须同时提供 --base-url 和 --api-key" >&2
  exit 2
fi
case "$api_key" in
  *[![:space:]]*) ;;
  *) echo "[context-service] --api-key 不得为空" >&2; exit 2 ;;
esac
if [ "$seen_version" -eq 1 ] && [ -z "$requested_version" ]; then
  echo "[context-service] --version 缺少版本号" >&2
  exit 2
fi

for command_name in node curl unzip qodercli; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[context-service] 缺少依赖：$command_name" >&2
    exit 3
  fi
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "[context-service] 首版安装器仅支持 macOS 和 Linux" >&2
    exit 3
    ;;
esac

node - "$base_url" <<'NODE'
const value = process.argv[2];
const url = new URL(value);
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址必须使用 HTTP 或 HTTPS');
const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
if (url.protocol !== 'https:' && !loopback) throw new Error('非本机服务地址必须使用 HTTPS');
NODE

node <<'NODE'
function semver(value) {
  const match = String(value).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}
function lessThan(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}
const nodeVersion = semver(process.versions.node);
if (!nodeVersion || lessThan(nodeVersion, [18, 0, 0])) throw new Error('Node.js 版本不足，需要 18.0.0 或更高版本');
NODE

if [ "$dry_run" -eq 1 ]; then
  config_target="${XDG_CONFIG_HOME:-${HOME:?}}/context-service/qoder.json"
  if [ "$json_output" -eq 1 ]; then
    node - "$requested_version" "$config_target" <<'NODE'
const version = process.argv[2] || 'stable/latest';
const configPath = process.argv[3];
process.stdout.write(`${JSON.stringify({
  ok: true,
  operation: 'install',
  status: 'dry_run',
  targetVersion: version,
  configPath,
  configurationWillBeUpdated: true,
})}\n`);
NODE
  else
    echo "Dry-run 检查完成，未下载制品、请求服务或修改本地状态"
    echo "目标版本：${requested_version:-stable/latest}"
    echo "配置目标：$config_target"
    echo "将安装 Qoder 插件、注册 MCP 并写入 Context Service 配置"
  fi
  exit 0
fi

if [ -n "$requested_version" ]; then
  MANIFEST_URL="$(node - "$MANIFEST_URL" "$requested_version" <<'NODE'
const latest = new URL(process.argv[2]);
const version = process.argv[3];
if (latest.protocol !== 'https:') throw new Error('发布清单必须使用 HTTPS');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('--version 必须是严格 SemVer');
}
process.stdout.write(new URL(`../releases/${version}/manifest.json`, latest).toString());
NODE
)"
fi

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/context-service-cli.XXXXXX")"
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM
manifest_path="$temporary_root/latest.json"
artifact_path="$temporary_root/artifact.zip"
extract_path="$temporary_root/extracted"

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --output "$manifest_path" "$MANIFEST_URL"

manifest_fields="$(node - "$manifest_path" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
if (manifest.schema_version !== 1 || manifest.channel !== 'stable' || !semver.test(manifest.version)) {
  throw new Error('发布清单格式无效');
}
const url = new URL(manifest.artifact_url);
if (url.protocol !== 'https:') throw new Error('发布制品必须使用 HTTPS');
if (!/^[0-9a-f]{64}$/.test(manifest.artifact_sha256)) throw new Error('SHA-256 无效');
if (!Number.isSafeInteger(manifest.artifact_size) || manifest.artifact_size <= 0 || manifest.artifact_size > 134217728) {
  throw new Error('发布制品大小无效');
}
process.stdout.write([url.toString(), manifest.artifact_sha256, manifest.artifact_size].join('\t'));
NODE
)" || {
  echo "[context-service] 无法解析发布清单" >&2
  exit 2
}

tab="$(printf '\t')"
old_ifs="$IFS"
IFS="$tab"
set -- $manifest_fields "$@"
IFS="$old_ifs"
artifact_url="$1"
artifact_sha256="$2"
artifact_size="$3"
shift 3

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --output "$artifact_path" "$artifact_url"

node - "$artifact_path" "$artifact_sha256" "$artifact_size" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [file, expectedHash, expectedSize] = process.argv.slice(2);
const bytes = fs.readFileSync(file);
if (bytes.length !== Number(expectedSize)) throw new Error('发布制品大小与清单不一致');
const actual = crypto.createHash('sha256').update(bytes).digest('hex');
if (actual !== expectedHash) throw new Error('发布制品 SHA-256 与清单不一致');
NODE

node - "$artifact_path" <<'NODE'
const childProcess = require('node:child_process');
const output = childProcess.execFileSync('unzip', ['-Z1', process.argv[2]], { encoding: 'utf8' });
const entries = output.split(/\r?\n/).filter(Boolean);
if (entries.length === 0) throw new Error('发布制品为空');
for (const raw of entries) {
  const entry = raw.replaceAll('\\', '/');
  if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry) || entry.split('/').includes('..')) {
    throw new Error('发布制品包含不安全路径');
  }
}
NODE

mkdir -m 700 "$extract_path"
unzip -q "$artifact_path" -d "$extract_path"
node "$extract_path/plugin/bin/context-service-cli.mjs" install \
  --source-dir "$extract_path/plugin" \
  --manifest-file "$manifest_path" \
  "$@"
