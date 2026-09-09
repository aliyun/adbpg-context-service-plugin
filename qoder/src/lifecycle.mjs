import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PLUGIN_VERSION } from "./version.mjs";

export const LIFECYCLE_SCHEMA_VERSION = 1;
export const DEFAULT_CHANNEL = "stable";
export const DEFAULT_MANIFEST_URL =
  "https://context-database-client.oss-cn-hangzhou.aliyuncs.com/qoder/stable/latest.json";
export const EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID_INPUT: 2,
  PREREQUISITE: 3,
  DOWNLOAD_OR_INTEGRITY: 4,
  QODER_REGISTRATION: 5,
  ROLLED_BACK: 6,
  ROLLBACK_FAILED: 7,
  LOCAL_STATE: 8,
});

const PLUGIN_NAME = "context-service";
const MCP_NAME = "context-service";
const MCP_BRIDGE_RELATIVE_PATH = path.join("bin", "context-service-mcp-bridge.mjs");
const STATE_FILE_NAME = "install.json";
const TRANSACTION_FILE_NAME = "transaction.json";
const LOCK_DIRECTORY_NAME = "lifecycle.lock";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export class LifecycleError extends Error {
  constructor(message, exitCode, errorType = "lifecycle_error", options = {}) {
    super(message, options);
    this.name = "LifecycleError";
    this.exitCode = exitCode;
    this.errorType = errorType;
  }
}

function fail(message, exitCode, errorType, cause) {
  throw new LifecycleError(message, exitCode, errorType, cause ? { cause } : {});
}

export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  return {
    value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null;
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber < rightNumber ? -1 : 1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) fail("版本号必须是严格 SemVer", EXIT_CODES.INVALID_INPUT, "invalid_semver");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function requireHttps(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${field} 不是合法 URL`, EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (parsed.protocol !== "https:") {
    fail(`${field} 必须使用 HTTPS`, EXIT_CODES.INVALID_INPUT, "insecure_url");
  }
  return parsed.toString();
}

export function validateReleaseManifest(input, expectedChannel = DEFAULT_CHANNEL) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("发布清单必须是对象", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (input.schema_version !== LIFECYCLE_SCHEMA_VERSION) {
    fail("不支持的发布清单版本", EXIT_CODES.INVALID_INPUT, "unsupported_manifest_schema");
  }
  if (input.channel !== expectedChannel) {
    fail("发布通道与请求不一致", EXIT_CODES.INVALID_INPUT, "channel_mismatch");
  }
  if (!parseSemver(input.version)) {
    fail("发布版本必须是严格 SemVer", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (!parseSemver(input.min_node_version) || !parseSemver(input.min_qodercli_version)) {
    fail("最低运行版本必须是严格 SemVer", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (!Number.isSafeInteger(input.artifact_size) || input.artifact_size <= 0
      || input.artifact_size > MAX_ARTIFACT_BYTES) {
    fail("发布制品大小无效", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (!/^[0-9a-f]{64}$/.test(input.artifact_sha256 ?? "")) {
    fail("发布制品 SHA-256 无效", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  if (Number.isNaN(Date.parse(input.released_at))) {
    fail("发布时间无效", EXIT_CODES.INVALID_INPUT, "invalid_manifest");
  }
  return Object.freeze({
    schemaVersion: input.schema_version,
    channel: input.channel,
    version: input.version,
    releasedAt: input.released_at,
    artifactUrl: requireHttps(input.artifact_url, "artifact_url"),
    artifactSha256: input.artifact_sha256,
    artifactSize: input.artifact_size,
    minNodeVersion: input.min_node_version,
    minQodercliVersion: input.min_qodercli_version,
  });
}

export function lifecyclePaths(env = process.env, homeDirectory = os.homedir()) {
  const binHome = env.XDG_BIN_HOME || path.join(homeDirectory, ".local", "bin");
  const dataHome = env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share");
  const stateHome = env.XDG_STATE_HOME || path.join(homeDirectory, ".local", "state");
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  const root = path.join(dataHome, "context-service", "qoder");
  const stateRoot = path.join(stateHome, "context-service", "qoder");
  return Object.freeze({
    binHome,
    commandPath: path.join(binHome, "context-service-qoder"),
    root,
    versionsRoot: path.join(root, "versions"),
    currentPath: path.join(root, "current"),
    stateRoot,
    statePath: path.join(stateRoot, STATE_FILE_NAME),
    transactionPath: path.join(stateRoot, TRANSACTION_FILE_NAME),
    lockPath: path.join(stateRoot, LOCK_DIRECTORY_NAME),
    configPath: path.join(configHome, "context-service", "qoder.json"),
    turnStatePath: path.join(configHome, "context-service", "context-service-turn-state.json"),
  });
}

async function readJsonFile(filePath, options = {}) {
  try {
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text) > (options.maxBytes ?? MAX_MANIFEST_BYTES)) {
      fail("JSON 文件超过大小限制", options.exitCode ?? EXIT_CODES.INVALID_INPUT, "oversized_json");
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if (error?.code === "ENOENT" && options.allowMissing) return null;
    fail("无法读取生命周期状态", options.exitCode ?? EXIT_CODES.LOCAL_STATE, "invalid_json", error);
  }
}

async function atomicWriteJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, filePath);
}

export async function readInstallState(paths = lifecyclePaths()) {
  const state = await readJsonFile(paths.statePath, { allowMissing: true });
  if (!state) return null;
  return validateInstallState(state, paths);
}

function validateInstallState(state, paths) {
  const expectedVersionDirectory = parseSemver(state?.version)
    ? path.join(paths.versionsRoot, state.version)
    : null;
  const valid = state?.schemaVersion === LIFECYCLE_SCHEMA_VERSION
    && expectedVersionDirectory
    && path.resolve(state.versionDirectory ?? "") === path.resolve(expectedVersionDirectory)
    && state.pluginScope === "user"
    && typeof state.pluginId === "string"
    && state.pluginId.startsWith(`${PLUGIN_NAME}@`)
    && typeof state.installPath === "string"
    && path.isAbsolute(state.installPath)
    && state.mcpName === MCP_NAME
    && sameMcpConfig(state.mcp, expectedMcpConfig(state.installPath))
    && typeof state.artifactUrl === "string"
    && /^https:\/\//.test(state.artifactUrl)
    && /^[0-9a-f]{64}$/.test(state.artifactSha256 ?? "");
  if (!valid) {
    fail("安装状态格式无效", EXIT_CODES.LOCAL_STATE, "invalid_install_state");
  }
  return state;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireLock(paths) {
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(paths.lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail("无法获取生命周期锁", EXIT_CODES.LOCAL_STATE, "lock_error", error);
    }
    const metadata = await readJsonFile(path.join(paths.lockPath, "owner.json"), {
      allowMissing: true,
      exitCode: EXIT_CODES.LOCAL_STATE,
    });
    if (metadata && isProcessAlive(metadata.pid)) {
      fail("另一个安装、升级或卸载操作正在运行", EXIT_CODES.LOCAL_STATE, "lock_busy");
    }
    await rm(paths.lockPath, { recursive: true, force: true });
    await mkdir(paths.lockPath, { mode: 0o700 });
  }
  await atomicWriteJson(path.join(paths.lockPath, "owner.json"), {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  return async () => rm(paths.lockPath, { recursive: true, force: true });
}

function defaultCommandRunner(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const wrapped = new Error(stderr || stdout || `${command} 执行失败`);
    wrapped.status = error?.status;
    throw wrapped;
  }
}

function normalizeVersionOutput(value) {
  const match = String(value).match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function redactMessage(value) {
  return String(value ?? "操作失败")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/("?apiKey"?\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
}

function findInstallRecord(records) {
  if (!Array.isArray(records)) return null;
  return records
    .filter((record) => record?.name === PLUGIN_NAME && record?.scope === "user")
    .sort((left, right) => String(right.installedAt ?? "").localeCompare(String(left.installedAt ?? "")))[0] ?? null;
}

function parseJsonOutput(output, description) {
  try {
    const text = String(output).trim();
    const objectStart = text.indexOf("{");
    const arrayStart = text.indexOf("[");
    const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
    if (start < 0) throw new Error("JSON start not found");
    const opening = text[start];
    const end = text.lastIndexOf(opening === "[" ? "]" : "}");
    if (end < start) throw new Error("JSON end not found");
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    fail(`${description} 返回了无效 JSON`, EXIT_CODES.QODER_REGISTRATION, "invalid_qoder_output", error);
  }
}

function expectedMcpConfig(installPath) {
  return {
    type: "stdio",
    command: "node",
    args: [path.join(installPath, MCP_BRIDGE_RELATIVE_PATH)],
  };
}

function sameMcpConfig(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return (actual.type ?? "stdio") === expected.type
    && actual.command === expected.command
    && Array.isArray(actual.args)
    && actual.args.length === expected.args.length
    && actual.args.every((value, index) => value === expected.args[index]);
}

async function getMcpConfig(commandRunner) {
  try {
    const output = commandRunner("qodercli", ["mcp", "get", "-s", "user", MCP_NAME, "--json"]);
    if (/not found|does not exist|未找到|不存在/i.test(output)) return null;
    const parsed = parseJsonOutput(output, "Qoder MCP 查询");
    return parsed?.[MCP_NAME] ?? parsed;
  } catch (error) {
    if (/not found|does not exist|未找到|不存在/i.test(error?.message ?? "")) return null;
    throw error;
  }
}

async function getPluginRecord(commandRunner) {
  const output = commandRunner("qodercli", ["plugins", "list", "--json"]);
  return findInstallRecord(parseJsonOutput(output, "Qoder 插件列表"));
}

function checkPlatformAndTools(manifest, commandRunner, platform = process.platform) {
  if (!["darwin", "linux"].includes(platform)) {
    fail("首版安装器仅支持 macOS 和 Linux", EXIT_CODES.PREREQUISITE, "unsupported_platform");
  }
  const nodeVersion = process.versions.node;
  if (compareSemver(nodeVersion, manifest.minNodeVersion) < 0) {
    fail(`Node.js 版本不足，需要 ${manifest.minNodeVersion} 或更高版本`, EXIT_CODES.PREREQUISITE, "node_version_too_old");
  }
  let qoderVersion;
  try {
    qoderVersion = normalizeVersionOutput(commandRunner("qodercli", ["--version"]));
  } catch (error) {
    fail("未找到可执行的 qodercli", EXIT_CODES.PREREQUISITE, "qodercli_missing", error);
  }
  if (!qoderVersion || compareSemver(qoderVersion, manifest.minQodercliVersion) < 0) {
    fail(`Qoder CLI 版本不足，需要 ${manifest.minQodercliVersion} 或更高版本`, EXIT_CODES.PREREQUISITE, "qodercli_version_too_old");
  }
  return { nodeVersion, qoderVersion };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function downloadToFile(url, destination, expectedSize, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    fail("下载发布制品失败", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "download_failed", error);
  }
  if (!response.ok) {
    fail(`下载发布制品失败（HTTP ${response.status}）`, EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "download_failed");
  }
  requireHttps(response.url || url, "重定向后的 artifact_url");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength !== expectedSize) {
    fail("发布制品 Content-Length 与清单不一致", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "artifact_size_mismatch");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedSize || bytes.length > MAX_ARTIFACT_BYTES) {
    fail("发布制品大小与清单不一致", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "artifact_size_mismatch");
  }
  await writeFile(destination, bytes, { mode: 0o600 });
}

async function fetchManifest(url, channel, fetchImpl = fetch) {
  requireHttps(url, "发布清单地址");
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    fail("下载发布清单失败", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "manifest_download_failed", error);
  }
  if (!response.ok) {
    fail(`下载发布清单失败（HTTP ${response.status}）`, EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "manifest_download_failed");
  }
  requireHttps(response.url || url, "重定向后的发布清单地址");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    fail("发布清单超过大小限制", EXIT_CODES.INVALID_INPUT, "oversized_manifest");
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    fail("发布清单不是合法 JSON", EXIT_CODES.INVALID_INPUT, "invalid_manifest", error);
  }
  return validateReleaseManifest(input, channel);
}

export function validateZipEntries(output) {
  const entries = String(output).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) {
    fail("发布制品为空", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "empty_artifact");
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
      fail("发布制品包含绝对路径", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "unsafe_archive_path");
    }
    const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    const parts = withoutTrailingSlash.split("/");
    if (parts.includes("..") || parts.includes("") || normalized.includes("//")) {
      fail("发布制品包含目录穿越路径", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "unsafe_archive_path");
    }
  }
  return entries;
}

async function assertNoEscapingSymlinks(root) {
  async function walk(directory) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolved = path.resolve(directory, target);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          fail("发布制品包含逃逸符号链接", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "unsafe_archive_symlink");
        }
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }
  await walk(root);
}

async function extractArtifact(artifactPath, destination, commandRunner) {
  let entries;
  try {
    entries = commandRunner("unzip", ["-Z1", artifactPath]);
  } catch (error) {
    fail("缺少 unzip 或无法读取发布制品", EXIT_CODES.PREREQUISITE, "unzip_unavailable", error);
  }
  validateZipEntries(entries);
  try {
    const detailedEntries = commandRunner("unzip", ["-Z", "-l", artifactPath]);
    if (/^l[^\s]*\s/m.test(detailedEntries)) {
      fail("发布制品不得包含符号链接", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "unsafe_archive_symlink");
    }
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    fail("无法检查发布制品符号链接", EXIT_CODES.PREREQUISITE, "unzip_unavailable", error);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    commandRunner("unzip", ["-q", artifactPath, "-d", destination]);
  } catch (error) {
    fail("解压发布制品失败", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "extract_failed", error);
  }
  await assertNoEscapingSymlinks(destination);
  const pluginDir = path.join(destination, "plugin");
  try {
    const metadata = await stat(path.join(pluginDir, ".qoder-plugin", "plugin.json"));
    if (!metadata.isFile()) throw new Error("manifest is not a file");
  } catch (error) {
    fail("发布内容结构无效", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "invalid_artifact_layout", error);
  }
  return pluginDir;
}

async function validatePackageVersions(pluginDir, expectedVersion) {
  const pluginManifest = await readJsonFile(path.join(pluginDir, ".qoder-plugin", "plugin.json"), {
    exitCode: EXIT_CODES.DOWNLOAD_OR_INTEGRITY,
  });
  const packageManifest = await readJsonFile(path.join(pluginDir, "package.json"), {
    exitCode: EXIT_CODES.DOWNLOAD_OR_INTEGRITY,
  });
  if (pluginManifest?.name !== PLUGIN_NAME
      || pluginManifest?.version !== expectedVersion
      || packageManifest?.version !== expectedVersion) {
    fail("发布清单与插件包版本或身份不一致", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "package_version_mismatch");
  }
}

async function installQoderPlugin(pluginDir, commandRunner) {
  try {
    commandRunner("qodercli", ["plugins", "validate", pluginDir, "--strict"]);
    const output = commandRunner("qodercli", ["plugins", "install", pluginDir, "--scope", "user", "--json"]);
    const installed = parseJsonOutput(output, "Qoder 插件安装");
    const record = await getPluginRecord(commandRunner);
    const installPath = installed.installPath ?? record?.installPath;
    const pluginId = installed.pluginId ?? installed.id ?? record?.id;
    if (!installPath || !pluginId) {
      fail("Qoder 返回的插件安装结果无效", EXIT_CODES.QODER_REGISTRATION, "plugin_install_path_missing");
    }
    return { installPath: path.resolve(installPath), pluginId };
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    fail("Qoder 插件安装失败", EXIT_CODES.QODER_REGISTRATION, "plugin_install_failed", error);
  }
}

function uninstallQoderPlugin(pluginId, commandRunner) {
  if (!pluginId) return;
  try {
    commandRunner("qodercli", ["plugins", "uninstall", "--scope", "user", pluginId, "--json"]);
  } catch (error) {
    if (!/not installed|not found|不存在|未安装/i.test(error?.message ?? "")) throw error;
  }
}

async function removeManagedMcp(state, commandRunner, options = {}) {
  const actual = await getMcpConfig(commandRunner);
  if (!actual) return { removed: false, missing: true };
  const expected = state?.mcp;
  if (!expected || !sameMcpConfig(actual, expected)) {
    if (options.requireOwnership) return { removed: false, modified: true };
    fail("已存在不属于安装器的 context-service MCP 配置", EXIT_CODES.QODER_REGISTRATION, "mcp_conflict");
  }
  commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
  return { removed: true };
}

async function registerMcp(installPath, oldState, commandRunner) {
  const actual = await getMcpConfig(commandRunner);
  if (actual) {
    if (!oldState?.mcp || !sameMcpConfig(actual, oldState.mcp)) {
      fail("已存在不属于安装器的 context-service MCP 配置", EXIT_CODES.QODER_REGISTRATION, "mcp_conflict");
    }
    commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
  }
  const expected = expectedMcpConfig(installPath);
  commandRunner("qodercli", [
    "mcp", "add", "--scope", "user", MCP_NAME, expected.command, ...expected.args,
  ]);
  const registered = await getMcpConfig(commandRunner);
  if (!sameMcpConfig(registered, expected)) {
    fail("Qoder IDE MCP 注册后校验失败", EXIT_CODES.QODER_REGISTRATION, "mcp_verification_failed");
  }
  return expected;
}

async function installCommandWrapper(paths) {
  await mkdir(paths.binHome, { recursive: true, mode: 0o700 });
  const shellPath = path.join(paths.currentPath, "plugin", "bin", "context-service-qoder.mjs")
    .replaceAll("'", "'\"'\"'");
  const wrapper = [
    "#!/bin/sh",
    `exec node '${shellPath}' "$@"`,
    "",
  ].join("\n");
  const temporaryPath = `${paths.commandPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, wrapper, { mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, paths.commandPath);
}

async function switchCurrent(paths, versionDirectory) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporaryLink = `${paths.currentPath}.${process.pid}.${randomUUID()}.tmp`;
  await symlink(versionDirectory, temporaryLink, "dir");
  await rename(temporaryLink, paths.currentPath);
}

async function recoverTransaction(paths, commandRunner) {
  const transaction = await readJsonFile(paths.transactionPath, { allowMissing: true });
  if (!transaction) return;
  if (!parseSemver(transaction.targetVersion)) {
    fail("事务状态格式无效", EXIT_CODES.LOCAL_STATE, "invalid_transaction_state");
  }
  const previous = transaction.previousState
    ? validateInstallState(transaction.previousState, paths)
    : null;
  const committed = await readInstallState(paths);
  if (committed?.version === transaction.targetVersion) {
    const plugin = await getPluginRecord(commandRunner);
    const mcp = await getMcpConfig(commandRunner);
    if (plugin?.id === committed.pluginId && sameMcpConfig(mcp, committed.mcp)) {
      await rm(paths.transactionPath, { force: true });
      return;
    }
  }
  if (!previous) {
    const plugin = await getPluginRecord(commandRunner);
    const mcp = await getMcpConfig(commandRunner);
    if (mcp) commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
    if (plugin?.id) uninstallQoderPlugin(plugin.id, commandRunner);
    await rm(path.join(paths.versionsRoot, transaction.targetVersion), { recursive: true, force: true });
    await rm(paths.transactionPath, { force: true });
    return;
  }
  try {
    const record = await getPluginRecord(commandRunner);
    if (record?.id && record.id !== previous.pluginId) uninstallQoderPlugin(record.id, commandRunner);
    const restored = await installQoderPlugin(path.join(previous.versionDirectory, "plugin"), commandRunner);
    const actual = await getMcpConfig(commandRunner);
    if (actual) commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
    const mcp = await registerMcp(restored.installPath, null, commandRunner);
    const restoredState = { ...previous, pluginId: restored.pluginId, installPath: restored.installPath, mcp };
    await switchCurrent(paths, previous.versionDirectory);
    await atomicWriteJson(paths.statePath, restoredState);
    await rm(paths.transactionPath, { force: true });
  } catch (error) {
    fail("上次生命周期操作未完成且自动恢复失败", EXIT_CODES.ROLLBACK_FAILED, "transaction_recovery_failed", error);
  }
}

function makeResult(operation, status, details = {}) {
  return { ok: true, operation, status, ...details };
}

function sourceManifestFromOptions(options) {
  if (!options.manifest) return null;
  return validateReleaseManifest(options.manifest, options.channel ?? DEFAULT_CHANNEL);
}

async function prepareSource(options, dependencies, paths) {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  if (options.targetVersion && !parseSemver(options.targetVersion)) {
    fail("--version 必须是严格 SemVer", EXIT_CODES.INVALID_INPUT, "invalid_semver");
  }
  let manifest = sourceManifestFromOptions(options);
  if (!manifest && options.manifestFile) {
    const rawManifest = await readJsonFile(path.resolve(options.manifestFile), {
      exitCode: EXIT_CODES.INVALID_INPUT,
    });
    manifest = validateReleaseManifest(rawManifest, channel);
  }
  if (manifest && options.targetVersion && manifest.version !== options.targetVersion) {
    fail("指定版本与发布清单版本不一致", EXIT_CODES.INVALID_INPUT, "target_version_mismatch");
  }
  if (options.sourceDir) {
    if (!manifest) fail("--source-dir 必须同时提供发布清单", EXIT_CODES.INVALID_INPUT, "manifest_required");
    const pluginDir = path.resolve(options.sourceDir);
    await validatePackageVersions(pluginDir, manifest.version);
    return { manifest, pluginDir, temporaryRoot: null };
  }
  const latestManifestUrl = options.manifestUrl
    ?? dependencies.env.CONTEXT_SERVICE_QODER_RELEASE_MANIFEST_URL
    ?? DEFAULT_MANIFEST_URL;
  const manifestUrl = options.targetVersion
    ? new URL(`../releases/${options.targetVersion}/manifest.json`, requireHttps(latestManifestUrl, "发布清单地址")).toString()
    : latestManifestUrl;
  manifest ??= await fetchManifest(
    manifestUrl,
    channel,
    dependencies.fetch,
  );
  if (options.targetVersion && manifest.version !== options.targetVersion) {
    fail("指定版本与发布清单版本不一致", EXIT_CODES.INVALID_INPUT, "target_version_mismatch");
  }
  checkPlatformAndTools(manifest, dependencies.commandRunner, dependencies.platform);
  if (options.dryRun) return { manifest, pluginDir: null, temporaryRoot: null };
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "context-service-qoder-"));
  const artifactPath = path.join(temporaryRoot, "artifact.zip");
  await downloadToFile(manifest.artifactUrl, artifactPath, manifest.artifactSize, dependencies.fetch);
  const digest = await sha256File(artifactPath);
  if (digest !== manifest.artifactSha256) {
    await rm(artifactPath, { force: true });
    fail("发布制品 SHA-256 与清单不一致", EXIT_CODES.DOWNLOAD_OR_INTEGRITY, "artifact_sha256_mismatch");
  }
  const extractedRoot = path.join(temporaryRoot, "extracted");
  const pluginDir = await extractArtifact(artifactPath, extractedRoot, dependencies.commandRunner);
  await validatePackageVersions(pluginDir, manifest.version);
  return { manifest, pluginDir, temporaryRoot };
}

async function stageVersion(pluginDir, manifest, paths) {
  const versionDirectory = path.join(paths.versionsRoot, manifest.version);
  const stagedDirectory = `${versionDirectory}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(stagedDirectory, { recursive: true, mode: 0o700 });
  await cp(pluginDir, path.join(stagedDirectory, "plugin"), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
  });
  await mkdir(paths.versionsRoot, { recursive: true, mode: 0o700 });
  await rm(versionDirectory, { recursive: true, force: true });
  await rename(stagedDirectory, versionDirectory);
  return versionDirectory;
}

async function rollback(previousState, newPluginId, paths, commandRunner) {
  try {
    const actualMcp = await getMcpConfig(commandRunner);
    if (actualMcp) commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
    if (newPluginId) uninstallQoderPlugin(newPluginId, commandRunner);
    if (!previousState) {
      const transaction = await readJsonFile(paths.transactionPath, { allowMissing: true });
      if (transaction?.targetVersion) {
        await rm(path.join(paths.versionsRoot, transaction.targetVersion), { recursive: true, force: true });
      }
      await rm(paths.transactionPath, { force: true });
      return;
    }
    const restored = await installQoderPlugin(path.join(previousState.versionDirectory, "plugin"), commandRunner);
    const mcp = await registerMcp(restored.installPath, null, commandRunner);
    const state = { ...previousState, pluginId: restored.pluginId, installPath: restored.installPath, mcp };
    await switchCurrent(paths, previousState.versionDirectory);
    await atomicWriteJson(paths.statePath, state);
    await installCommandWrapper(paths);
    await rm(paths.transactionPath, { force: true });
  } catch (error) {
    fail("升级失败且自动回滚失败", EXIT_CODES.ROLLBACK_FAILED, "rollback_failed", error);
  }
}

async function cleanupOldVersions(paths, keepVersions) {
  let entries;
  try {
    entries = await readdir(paths.versionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || keepVersions.has(entry.name)) continue;
    if (!parseSemver(entry.name)) continue;
    await rm(path.join(paths.versionsRoot, entry.name), { recursive: true, force: true });
  }
}

async function installOrUpgrade(operation, options, dependencies, paths) {
  if (options.dryRun) {
    const previousState = await readInstallState(paths);
    const prepared = await prepareSource(options, dependencies, paths);
    const prerequisites = checkPlatformAndTools(prepared.manifest, dependencies.commandRunner, dependencies.platform);
    if (operation === "upgrade" && !previousState) {
      fail("尚未通过正式安装器安装，请先执行 install", EXIT_CODES.LOCAL_STATE, "not_installed");
    }
    if (previousState && compareSemver(prepared.manifest.version, previousState.version) < 0 && !options.allowDowngrade) {
      fail("目标版本低于当前版本；降级必须指定 --allow-downgrade", EXIT_CODES.INVALID_INPUT, "downgrade_not_allowed");
    }
    return makeResult(operation, "dry_run", {
      targetVersion: prepared.manifest.version,
      currentVersion: previousState?.version ?? null,
      prerequisites,
    });
  }
  const releaseLock = await acquireLock(paths);
  let prepared;
  let newPluginId;
  let previousState;
  try {
    await recoverTransaction(paths, dependencies.commandRunner);
    previousState = await readInstallState(paths);
    prepared = await prepareSource(options, dependencies, paths);
    const { manifest } = prepared;
    checkPlatformAndTools(manifest, dependencies.commandRunner, dependencies.platform);
    if (previousState) {
      const comparison = compareSemver(manifest.version, previousState.version);
      if (operation === "install" && comparison === 0 && !options.dryRun) {
        const plugin = await getPluginRecord(dependencies.commandRunner);
        const mcp = await getMcpConfig(dependencies.commandRunner);
        if (plugin?.id === previousState.pluginId && sameMcpConfig(mcp, previousState.mcp)) {
          return makeResult(operation, "already_installed", {
            version: previousState.version,
            restartRequired: false,
          });
        }
      }
      if (operation === "upgrade" && comparison === 0) {
        return makeResult(operation, "up_to_date", {
          version: previousState.version,
          restartRequired: false,
        });
      }
      if (comparison < 0 && !options.allowDowngrade) {
        fail("目标版本低于当前版本；降级必须指定 --allow-downgrade", EXIT_CODES.INVALID_INPUT, "downgrade_not_allowed");
      }
    } else if (operation === "upgrade") {
      fail("尚未通过正式安装器安装，请先执行 install", EXIT_CODES.LOCAL_STATE, "not_installed");
    }
    const existingPlugin = await getPluginRecord(dependencies.commandRunner);
    if (existingPlugin && (!previousState || existingPlugin.id !== previousState.pluginId)) {
      fail("已存在不属于正式安装器的 Context Service 用户级插件", EXIT_CODES.QODER_REGISTRATION, "plugin_conflict");
    }
    const existingMcp = await getMcpConfig(dependencies.commandRunner);
    if (existingMcp && (!previousState?.mcp || !sameMcpConfig(existingMcp, previousState.mcp))) {
      fail("已存在不属于正式安装器的 context-service MCP 配置", EXIT_CODES.QODER_REGISTRATION, "mcp_conflict");
    }

    const versionDirectory = await stageVersion(prepared.pluginDir, manifest, paths);
    await atomicWriteJson(paths.transactionPath, {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      operation,
      targetVersion: manifest.version,
      previousState,
      startedAt: new Date().toISOString(),
    });

    if (existingMcp) dependencies.commandRunner("qodercli", ["mcp", "remove", "--scope", "user", MCP_NAME]);
    if (existingPlugin) uninstallQoderPlugin(existingPlugin.id, dependencies.commandRunner);

    let installed;
    try {
      installed = await installQoderPlugin(path.join(versionDirectory, "plugin"), dependencies.commandRunner);
      newPluginId = installed.pluginId;
      const mcp = await registerMcp(installed.installPath, null, dependencies.commandRunner);
      const state = {
        schemaVersion: LIFECYCLE_SCHEMA_VERSION,
        version: manifest.version,
        channel: manifest.channel,
        versionDirectory,
        pluginId: installed.pluginId,
        pluginScope: "user",
        installPath: installed.installPath,
        mcpName: MCP_NAME,
        mcp,
        artifactUrl: manifest.artifactUrl,
        artifactSha256: manifest.artifactSha256,
        installedAt: new Date().toISOString(),
        previousVersion: previousState?.version ?? null,
      };
      await switchCurrent(paths, versionDirectory);
      await installCommandWrapper(paths);
      await atomicWriteJson(paths.statePath, state);
      await rm(paths.transactionPath, { force: true });
      await cleanupOldVersions(paths, new Set([
        manifest.version,
        ...(previousState?.version ? [previousState.version] : []),
      ]));
      return makeResult(operation, operation === "install" ? "installed" : "upgraded", {
        version: manifest.version,
        previousVersion: previousState?.version ?? null,
        restartRequired: true,
      });
    } catch (error) {
      await rollback(previousState, newPluginId, paths, dependencies.commandRunner);
      if (previousState) {
        throw new LifecycleError(
          `升级失败，已恢复 ${previousState.version}`,
          EXIT_CODES.ROLLED_BACK,
          "upgrade_rolled_back",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    if (prepared?.temporaryRoot) await rm(prepared.temporaryRoot, { recursive: true, force: true });
    await releaseLock();
  }
}

async function purgeKnownData(paths) {
  const candidates = [paths.configPath, paths.turnStatePath];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const home = path.resolve(os.homedir());
    if (resolved === home || resolved === path.parse(resolved).root || !resolved.includes(`${path.sep}context-service${path.sep}`)) {
      fail("拒绝清理不安全的数据路径", EXIT_CODES.LOCAL_STATE, "unsafe_purge_path");
    }
    await rm(resolved, { force: true });
  }
}

async function uninstall(options, dependencies, paths) {
  if (options.dryRun) {
    const state = await readInstallState(paths);
    return makeResult("uninstall", "dry_run", {
      version: state?.version ?? null,
      purgeData: Boolean(options.purgeData),
    });
  }
  const releaseLock = await acquireLock(paths);
  try {
    await recoverTransaction(paths, dependencies.commandRunner);
    const state = await readInstallState(paths);
    if (!state) {
      if (options.purgeData) {
        if (!options.yes && !options.confirmed) {
          fail("彻底清理必须确认；非交互环境请同时指定 --yes", EXIT_CODES.INVALID_INPUT, "purge_confirmation_required");
        }
        await purgeKnownData(paths);
      }
      return makeResult("uninstall", "already_uninstalled", { dataPreserved: !options.purgeData });
    }
    if (options.purgeData && !options.yes && !options.confirmed) {
      fail("彻底清理必须确认；非交互环境请同时指定 --yes", EXIT_CODES.INVALID_INPUT, "purge_confirmation_required");
    }
    const mcpResult = await removeManagedMcp(state, dependencies.commandRunner, { requireOwnership: true });
    const plugin = await getPluginRecord(dependencies.commandRunner);
    if (plugin?.id === state.pluginId) uninstallQoderPlugin(state.pluginId, dependencies.commandRunner);
    await rm(paths.currentPath, { recursive: true, force: true });
    await rm(paths.versionsRoot, { recursive: true, force: true });
    await rm(paths.commandPath, { force: true });
    await rm(paths.transactionPath, { force: true });
    await rm(paths.statePath, { force: true });
    if (options.purgeData) await purgeKnownData(paths);
    return makeResult("uninstall", "uninstalled", {
      version: state.version,
      dataPreserved: !options.purgeData,
      modifiedMcpPreserved: Boolean(mcpResult.modified),
      restartRequired: true,
    });
  } finally {
    await releaseLock();
  }
}

export async function lifecycleDoctor(options = {}, dependencies = {}) {
  const deps = lifecycleDependencies(dependencies);
  const paths = options.paths ?? lifecyclePaths(deps.env, deps.homeDirectory);
  const state = await readInstallState(paths);
  let plugin = null;
  let mcp = null;
  let qoderVersion = null;
  try {
    qoderVersion = normalizeVersionOutput(deps.commandRunner("qodercli", ["--version"]));
    plugin = await getPluginRecord(deps.commandRunner);
    mcp = await getMcpConfig(deps.commandRunner);
  } catch {
    // Doctor reports component state instead of exposing raw command errors.
  }
  return {
    ok: Boolean(state && plugin?.id === state.pluginId && sameMcpConfig(mcp, state.mcp)),
    installed: Boolean(state),
    version: state?.version ?? null,
    channel: state?.channel ?? null,
    qoderVersion,
    pluginRegistered: Boolean(state && plugin?.id === state.pluginId),
    mcpRegistered: Boolean(state && sameMcpConfig(mcp, state.mcp)),
    configExists: await stat(paths.configPath).then(() => true, () => false),
  };
}

export function lifecycleDependencies(overrides = {}) {
  return {
    commandRunner: overrides.commandRunner ?? defaultCommandRunner,
    fetch: overrides.fetch ?? globalThis.fetch,
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    homeDirectory: overrides.homeDirectory ?? os.homedir(),
  };
}

export async function runLifecycleCommand(operation, options = {}, dependencyOverrides = {}) {
  const dependencies = lifecycleDependencies(dependencyOverrides);
  const paths = options.paths ?? lifecyclePaths(dependencies.env, dependencies.homeDirectory);
  if (operation === "install" || operation === "upgrade") {
    return installOrUpgrade(operation, options, dependencies, paths);
  }
  if (operation === "uninstall") return uninstall(options, dependencies, paths);
  if (operation === "version") {
    const state = await readInstallState(paths);
    let qoderVersion = null;
    try {
      qoderVersion = normalizeVersionOutput(dependencies.commandRunner("qodercli", ["--version"]));
    } catch {
      // A missing Qoder CLI is represented as null in version output.
    }
    return makeResult("version", "reported", {
      lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
      lifecycleVersion: PLUGIN_VERSION,
      pluginVersion: state?.version ?? null,
      channel: state?.channel ?? null,
      qoderVersion,
    });
  }
  fail("未知生命周期操作", EXIT_CODES.INVALID_INPUT, "unknown_operation");
}

export function renderLifecycleResult(result) {
  const labels = {
    installed: "安装完成",
    already_installed: "当前版本已经安装",
    upgraded: "升级完成",
    up_to_date: "当前已是最新版本",
    uninstalled: "卸载完成",
    already_uninstalled: "插件已经处于卸载状态",
    dry_run: "Dry-run 检查完成，未修改任何状态",
    reported: "版本信息",
  };
  const lines = [labels[result.status] ?? "操作完成"];
  if (result.version) lines.push(`版本：${result.version}`);
  if (result.previousVersion) lines.push(`上一版本：${result.previousVersion}`);
  if (result.pluginVersion) lines.push(`插件版本：${result.pluginVersion}`);
  if (result.lifecycleVersion) lines.push(`生命周期工具版本：${result.lifecycleVersion}`);
  if (result.channel) lines.push(`通道：${result.channel}`);
  if (result.qoderVersion) lines.push(`Qoder CLI：${result.qoderVersion}`);
  if (result.dataPreserved) lines.push("业务配置和运行数据：已保留");
  if (result.modifiedMcpPreserved) lines.push("提示：MCP 配置已被用户修改，因此未删除");
  if (result.restartRequired) lines.push("请完整重启 Qoder IDE 使变更生效。");
  return `${lines.join("\n")}\n`;
}

export function renderLifecycleError(error, operation, json = false) {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : EXIT_CODES.LOCAL_STATE;
  const errorType = error?.errorType ?? "unexpected_error";
  const message = redactMessage(error?.message);
  if (json) {
    return `${JSON.stringify({ ok: false, operation, stage: errorType, exitCode, errorType, message })}\n`;
  }
  return `[context-service] ${message}\n`;
}
