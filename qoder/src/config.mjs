import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 8_000;

export function defaultConfigPath(env = process.env, platform = process.platform) {
  if (env.CONTEXT_SERVICE_CONFIG) {
    return path.resolve(env.CONTEXT_SERVICE_CONFIG);
  }

  const base = platform === "win32"
    ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "context-service", "qoder.json");
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  throw new Error("功能开关值无效");
}

function parseTimeout(value) {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 30_000) {
    throw new Error("请求超时必须是 100 到 30000 之间的整数毫秒值");
  }
  return parsed;
}

function validateBaseUrl(value) {
  if (!value) throw new Error("缺少服务地址");
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("服务地址必须使用 HTTP 或 HTTPS");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("非本机服务地址必须使用 HTTPS");
  }
  return value.replace(/\/+$/, "");
}

export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(env, options.platform);
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("无法读取本地配置");
  }

  const config = {
    baseUrl: validateBaseUrl(env.CONTEXT_SERVICE_BASE_URL || fileConfig.baseUrl),
    apiKey: env.CONTEXT_SERVICE_API_KEY || fileConfig.apiKey,
    timeoutMs: parseTimeout(env.CONTEXT_SERVICE_TIMEOUT_MS || fileConfig.timeoutMs),
    sessionStartEnabled: parseBoolean(
      env.CONTEXT_SERVICE_SESSION_START,
      fileConfig.sessionStartEnabled ?? true,
    ),
    userPromptSubmitEnabled: parseBoolean(
      env.CONTEXT_SERVICE_USER_PROMPT_SUBMIT,
      fileConfig.userPromptSubmitEnabled ?? false,
    ),
    stopSyncEnabled: parseBoolean(
      env.CONTEXT_SERVICE_STOP_SYNC,
      fileConfig.stopSyncEnabled ?? false,
    ),
    stopMemoryExtractionEnabled: parseBoolean(
      env.CONTEXT_SERVICE_STOP_MEMORY_EXTRACTION,
      fileConfig.stopMemoryExtractionEnabled ?? false,
    ),
    configPath,
  };

  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("缺少 API Key");
  }
  return Object.freeze(config);
}

export async function saveConfig(input, options = {}) {
  const configPath = options.configPath ?? defaultConfigPath(options.env, options.platform);
  const serializable = {
    baseUrl: validateBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    timeoutMs: parseTimeout(input.timeoutMs),
    sessionStartEnabled: parseBoolean(input.sessionStartEnabled, true),
    userPromptSubmitEnabled: parseBoolean(input.userPromptSubmitEnabled, false),
    stopSyncEnabled: parseBoolean(input.stopSyncEnabled, false),
    stopMemoryExtractionEnabled: parseBoolean(input.stopMemoryExtractionEnabled, false),
  };
  if (!serializable.apiKey || typeof serializable.apiKey !== "string") {
    throw new Error("缺少 API Key");
  }

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(serializable, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  return configPath;
}
