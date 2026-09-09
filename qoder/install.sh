#!/bin/sh
set -eu

MANIFEST_URL="${CONTEXT_SERVICE_QODER_RELEASE_MANIFEST_URL:-https://context-database-client.oss-cn-hangzhou.aliyuncs.com/qoder/stable/latest.json}"

expect_version=0
requested_version=""
for installer_argument in "$@"; do
  if [ "$expect_version" -eq 1 ]; then
    requested_version="$installer_argument"
    expect_version=0
  elif [ "$installer_argument" = "--version" ]; then
    expect_version=1
  fi
done
if [ "$expect_version" -eq 1 ]; then
  echo "[context-service] --version 缺少版本号" >&2
  exit 2
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

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/context-service-qoder.XXXXXX")"
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
node "$extract_path/plugin/bin/context-service-qoder.mjs" install \
  --source-dir "$extract_path/plugin" \
  --manifest-file "$manifest_path" \
  "$@"
