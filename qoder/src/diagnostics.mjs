import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ContextServiceClient } from "./context-client.mjs";
import { defaultConfigPath, loadConfig } from "./config.mjs";
import { createMcpForwarder, EXPOSED_MCP_TOOLS } from "./mcp-bridge.mjs";
import { PLUGIN_VERSION } from "./version.mjs";

export { PLUGIN_VERSION } from "./version.mjs";

function enabled(value) {
  return value ? "开启" : "关闭";
}

export function publicError(error) {
  if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
  if (/timed out|timeout|超时/i.test(error?.message ?? "")) return "请求超时";
  return "服务不可用";
}

export async function checkConfigFileSecurity(configPath, options = {}) {
  if ((options.platform ?? process.platform) === "win32") {
    return { ok: true, detail: "Windows 平台不检查 POSIX 权限" };
  }
  const statImpl = options.stat ?? stat;
  try {
    const metadata = await statImpl(configPath);
    const mode = metadata.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return { ok: false, detail: `配置文件权限过宽（${mode.toString(8).padStart(3, "0")}）` };
    }
    return { ok: true, detail: `配置文件权限安全（${mode.toString(8).padStart(3, "0")}）` };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, detail: "未使用本地配置文件，配置来自环境变量" };
    }
    return { ok: false, detail: "无法检查配置文件权限" };
  }
}

export async function collectStatus(options = {}) {
  const load = options.loadConfig ?? loadConfig;
  const configPath = options.configPath ?? defaultConfigPath(options.env);
  let config;
  try {
    config = await load({
      ...(options.env ? { env: options.env } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  } catch {
    return {
      ok: false,
      pluginVersion: PLUGIN_VERSION,
      config: { ok: false, path: configPath },
      service: { ok: false, detail: "未检查（配置无效）" },
      mcpToolCount: EXPOSED_MCP_TOOLS.length,
    };
  }

  const result = {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    config: {
      ok: true,
      path: config.configPath,
      baseUrl: config.baseUrl,
      apiKeyConfigured: true,
      timeoutMs: config.timeoutMs,
      hooks: {
        sessionStart: config.sessionStartEnabled,
        userPromptSubmit: config.userPromptSubmitEnabled,
        stopSync: config.stopSyncEnabled,
        stopMemoryExtraction: config.stopMemoryExtractionEnabled,
      },
    },
    service: { ok: false },
    mcpToolCount: EXPOSED_MCP_TOOLS.length,
  };

  try {
    const createClient = options.createClient ?? ((value) => new ContextServiceClient(value));
    const health = await createClient(config).health();
    result.service = {
      ok: true,
      status: typeof health?.status === "string" ? health.status : "ok",
      memoryBackend: health?.memory?.backend ?? "未报告",
    };
  } catch (error) {
    result.ok = false;
    result.service = { ok: false, detail: publicError(error) };
  }
  return result;
}

export function renderStatus(result) {
  const lines = [
    "Context Service 状态",
    "",
    `插件版本：${result.pluginVersion}`,
    `配置路径：${result.config.path}`,
  ];
  if (!result.config.ok) {
    lines.push("配置：无效或缺失", "API Key：未确认", `服务：${result.service.detail}`);
  } else {
    lines.push(
      `服务地址：${result.config.baseUrl}`,
      "API Key：已配置",
      `请求超时：${result.config.timeoutMs} 毫秒`,
      `服务：${result.service.ok ? "正常" : `异常（${result.service.detail}）`}`,
    );
    if (result.service.ok) {
      lines.push(`长期记忆：${result.service.memoryBackend === "未报告" ? "未确认" : "可用"}`);
    }
    lines.push(
      "",
      "自动能力：",
      `- 会话开始时加载上下文：${enabled(result.config.hooks.sessionStart)}`,
      `- 根据当前问题召回相关内容：${enabled(result.config.hooks.userPromptSubmit)}`,
      `- 每轮结束后同步对话：${enabled(result.config.hooks.stopSync)}`,
      `- 每轮结束后保存长期记忆：${enabled(result.config.hooks.stopMemoryExtraction)}`,
    );
  }
  lines.push("", `工具能力：预期可用 ${result.mcpToolCount} 个工具`);
  return `${lines.join("\n")}\n`;
}

function step(name, ok, detail) {
  return { name, ok, detail };
}

function findResponse(messages, id) {
  return messages.find((message) => message?.id === id);
}

export async function runReadOnlyDiagnostics(options = {}) {
  const steps = [];
  const load = options.loadConfig ?? loadConfig;
  let config;
  try {
    config = await load({
      ...(options.env ? { env: options.env } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
    const security = await checkConfigFileSecurity(config.configPath, options);
    steps.push(step("配置与权限", security.ok, security.detail));
    if (!security.ok) return { ok: false, steps };
  } catch {
    steps.push(step("配置与权限", false, "配置无效或缺失"));
    return { ok: false, steps };
  }

  const createClient = options.createClient ?? ((value) => new ContextServiceClient(value));
  const client = createClient(config);
  try {
    await client.health();
    steps.push(step("服务健康与鉴权", true, "请求成功"));
  } catch (error) {
    steps.push(step("服务健康与鉴权", false, publicError(error)));
  }

  try {
    await client.assemble({
      sessionId: `context-service-diagnostic-${(options.randomUUID ?? randomUUID)()}`,
      query: "",
      extra: {
        disable_rules: true,
        disable_knowledge: true,
        disable_state: true,
        disable_session_state: true,
      },
    });
    steps.push(step("上下文服务", true, "只读检查成功"));
  } catch (error) {
    steps.push(step("上下文服务", false, publicError(error)));
  }

  try {
    const forward = options.createForwarder
      ? options.createForwarder(config)
      : createMcpForwarder(config);
    const initializeMessages = await forward({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "context-service-cli-diagnostic", version: PLUGIN_VERSION },
      },
    });
    const initialize = findResponse(initializeMessages, 1);
    if (!initialize?.result?.protocolVersion || initialize?.error) {
      throw new Error("MCP initialize failed");
    }
    await forward({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listMessages = await forward({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listed = findResponse(listMessages, 2);
    if (!Array.isArray(listed?.result?.tools) || listed?.error) {
      throw new Error("MCP tools/list failed");
    }
    const actual = listed.result.tools.map((tool) => tool?.name).filter(Boolean);
    const expected = new Set(EXPOSED_MCP_TOOLS);
    const exact = actual.length === expected.size
      && new Set(actual).size === expected.size
      && actual.every((name) => expected.has(name));
    if (!exact || actual.includes("persona_get")) {
      steps.push(step(
        "工具能力",
        false,
        `工具集不符合预期（预期 ${expected.size}，实际 ${actual.length}）`,
      ));
    } else {
      steps.push(step("工具能力", true, `可用工具 ${actual.length} 个`));
    }
  } catch (error) {
    steps.push(step("工具能力", false, publicError(error)));
  }

  return { ok: steps.every((item) => item.ok), steps };
}

export function renderDiagnostics(result) {
  const lines = ["Context Service 只读测试", ""];
  for (const item of result.steps) {
    lines.push(`${item.ok ? "✓" : "✗"} ${item.name}：${item.detail}`);
  }
  lines.push("", result.ok ? "结论：全部检查通过" : "结论：存在检查失败");
  return `${lines.join("\n")}\n`;
}

export function renderSetupHelp() {
  return [
    "Context Service 配置",
    "",
    "安全提醒：不要在 Qoder 聊天或斜杠命令参数中粘贴 API Key。请在本机终端执行：",
    "",
    "read -s CONTEXT_SERVICE_SETUP_KEY",
    "context-service-cli setup \\",
    "  --base-url <服务地址> \\",
    "  --api-key \"$CONTEXT_SERVICE_SETUP_KEY\" \\",
    "  [--timeout-ms <毫秒>] \\",
    "  [--enable-prompt-hook] \\",
    "  [--enable-stop-sync] \\",
    "  [--enable-stop-memory-extraction]",
    "unset CONTEXT_SERVICE_SETUP_KEY",
    "",
    "配置文件在 POSIX 系统上使用 0600 权限。配置后运行 /context-status 和 /context-test。",
    "",
  ].join("\n");
}

export function renderHelp() {
  return [
    "Context Service 命令帮助",
    "",
    "/context-setup   显示安全配置流程，不在聊天中收集 API Key",
    "/context-status  查看脱敏配置、自动能力和服务状态",
    "/context-test    在不写业务数据的前提下检查服务是否可用",
    "/context-help    显示本帮助",
    "",
    "推荐顺序：/context-setup → /context-status → /context-test",
    "",
    "插件支持自动加载上下文、召回相关内容和处理每轮对话，并提供 12 个按需工具。",
    "管理命令：context-service-cli <install|upgrade|uninstall|version|doctor>",
    "管理参数：--dry-run、--json；卸载数据使用 --purge-data --yes",
    "安装时可以分别启用或关闭会话开始、问题召回、对话同步和自动记忆抽取。",
    "安全提醒：不要在聊天消息中粘贴 API Key。",
    "",
  ].join("\n");
}
