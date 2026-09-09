#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { saveConfig, loadConfig } from "../src/config.mjs";
import { ContextServiceClient } from "../src/context-client.mjs";
import {
  collectStatus,
  renderDiagnostics,
  renderHelp,
  renderSetupHelp,
  renderStatus,
  runReadOnlyDiagnostics,
} from "../src/diagnostics.mjs";
import { handleHook } from "../src/hook-handler.mjs";
import {
  EXIT_CODES,
  lifecycleDoctor,
  renderLifecycleError,
  renderLifecycleResult,
  runLifecycleCommand,
} from "../src/lifecycle.mjs";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin exceeds 2 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function lifecycleOptions() {
  return {
    channel: argument("--channel"),
    manifestUrl: argument("--manifest-url"),
    manifestFile: argument("--manifest-file"),
    sourceDir: argument("--source-dir"),
    targetVersion: argument("--version"),
    allowDowngrade: process.argv.includes("--allow-downgrade"),
    dryRun: process.argv.includes("--dry-run"),
    json: process.argv.includes("--json"),
    purgeData: process.argv.includes("--purge-data"),
    yes: process.argv.includes("--yes"),
  };
}

async function runHook(eventName) {
  try {
    const input = JSON.parse(await readStdin());
    const result = await handleHook(eventName, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Hooks are intentionally fail-open: an unavailable context service must not
    // block Qoder. Diagnostics go to stderr and no context is injected.
    const labels = {
      SessionStart: "会话上下文加载",
      UserPromptSubmit: "相关内容召回",
      Stop: "本轮对话处理",
    };
    const label = labels[eventName] ?? "自动上下文处理";
    const suffix = Number.isInteger(error?.status)
      ? `（HTTP ${error.status}）`
      : /timed out|timeout|超时/i.test(error?.message ?? "")
        ? "（请求超时）"
        : "";
    process.stderr.write(`[context-service] ${label}失败${suffix}\n`);
    process.stdout.write("{}\n");
  }
}

async function setup() {
  if (process.argv.includes("--help")) {
    process.stdout.write(renderSetupHelp());
    return;
  }
  const baseUrl = argument("--base-url");
  const apiKey = argument("--api-key");
  if (!baseUrl || !apiKey) {
    throw new Error("用法：context-service-qoder setup --base-url <服务地址> --api-key <API Key>");
  }
  const configPath = await saveConfig({
    baseUrl,
    apiKey,
    timeoutMs: argument("--timeout-ms"),
    sessionStartEnabled: true,
    userPromptSubmitEnabled: process.argv.includes("--enable-prompt-hook"),
    stopSyncEnabled: process.argv.includes("--enable-stop-sync"),
    stopMemoryExtractionEnabled: process.argv.includes("--enable-stop-memory-extraction"),
  });
  process.stdout.write(`配置已写入 ${configPath}\n`);
}

async function doctor() {
  const local = await lifecycleDoctor();
  const lines = [
    "Context Service 安装诊断",
    "",
    `正式安装状态：${local.installed ? "已安装" : "未安装"}`,
    `插件注册：${local.pluginRegistered ? "正常" : "未确认"}`,
    `工具连接：${local.mcpRegistered ? "正常" : "未确认"}`,
    `业务配置：${local.configExists ? "已配置" : "未配置"}`,
  ];
  if (local.version) lines.push(`插件版本：${local.version}`);
  if (local.qoderVersion) lines.push(`Qoder CLI：${local.qoderVersion}`);
  if (!local.configExists) {
    lines.push("远端服务：未检查（尚未执行 setup）", "");
    process.stdout.write(`${lines.join("\n")}\n`);
    if (local.installed && !local.ok) process.exitCode = 1;
    return;
  }
  const config = await loadConfig();
  const health = await new ContextServiceClient(config).health();
  if (config.stopMemoryExtractionEnabled && health.memory?.backend !== "mem0") {
    throw new Error("当前服务不支持自动长期记忆保存，请关闭该功能后重试");
  }
  lines.push(`远端服务：正常（${config.baseUrl}）`, "");
  process.stdout.write(`${lines.join("\n")}\n`);
  if (local.installed && !local.ok) process.exitCode = 1;
}

async function lifecycle(command) {
  const options = lifecycleOptions();
  try {
    if (command === "uninstall" && options.purgeData && !options.yes && !options.dryRun
        && process.stdin.isTTY && process.stdout.isTTY) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await readline.question("将删除 Context Service 的 API Key 配置和运行状态。输入 DELETE 继续：");
        options.confirmed = answer.trim() === "DELETE";
      } finally {
        readline.close();
      }
    }
    const result = await runLifecycleCommand(command, options);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : renderLifecycleResult(result));
  } catch (error) {
    process.stderr.write(renderLifecycleError(error, command, options.json));
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : EXIT_CODES.LOCAL_STATE;
  }
}

async function status() {
  const result = await collectStatus();
  process.stdout.write(renderStatus(result));
  if (!result.ok) process.exitCode = 1;
}

async function testConnection() {
  const result = await runReadOnlyDiagnostics();
  process.stdout.write(renderDiagnostics(result));
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === "hook" && value) return runHook(value);
  if (command === "setup") return setup();
  if (command === "status") return status();
  if (command === "test") return testConnection();
  if (["install", "upgrade", "uninstall", "version"].includes(command)) {
    return lifecycle(command);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(renderHelp());
    return;
  }
  if (command === "doctor") return doctor();
  throw new Error("用法：context-service-qoder <install|upgrade|uninstall|version|setup|status|test|help|doctor>");
}

main().catch((error) => {
  process.stderr.write(`[context-service] ${error.message}\n`);
  process.exitCode = 1;
});
