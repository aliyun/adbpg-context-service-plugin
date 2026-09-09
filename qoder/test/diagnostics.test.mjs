import assert from "node:assert/strict";
import test from "node:test";
import {
  collectStatus,
  PLUGIN_VERSION,
  renderDiagnostics,
  renderHelp,
  renderSetupHelp,
  renderStatus,
  runReadOnlyDiagnostics,
} from "../src/diagnostics.mjs";
import { EXPOSED_MCP_TOOLS } from "../src/mcp-bridge.mjs";

const config = Object.freeze({
  baseUrl: "https://context.example.com",
  apiKey: "diagnostic-secret-key",
  timeoutMs: 8000,
  sessionStartEnabled: true,
  userPromptSubmitEnabled: true,
  stopSyncEnabled: true,
  stopMemoryExtractionEnabled: false,
  configPath: "/tmp/context-service-test.json",
});

test("status renders local and remote state without exposing the API key", async () => {
  const result = await collectStatus({
    loadConfig: async () => config,
    createClient: () => ({
      health: async () => ({ status: "ok", memory: { backend: "mem0" } }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.pluginVersion, PLUGIN_VERSION);
  const output = renderStatus(result);
  assert.match(output, /API Key：已配置/);
  assert.match(output, /长期记忆：可用/);
  assert.match(output, /每轮结束后同步对话：开启/);
  assert.match(output, /预期可用 12 个工具/);
  assert.doesNotMatch(output, /persona_get|\.mjs\b|QODER_PLUGIN_ROOT|system_prompt_block/);
  assert.doesNotMatch(output, /diagnostic-secret-key|Bearer|Authorization/i);
});

test("status keeps local state and returns a redacted remote failure", async () => {
  const secretResponse = "remote-body-with-diagnostic-secret-key";
  const result = await collectStatus({
    loadConfig: async () => config,
    createClient: () => ({
      health: async () => {
        const error = new Error(secretResponse);
        error.status = 403;
        throw error;
      },
    }),
  });

  assert.equal(result.ok, false);
  const output = renderStatus(result);
  assert.match(output, /异常（HTTP 403）/);
  assert.doesNotMatch(output, new RegExp(secretResponse));
  assert.doesNotMatch(output, /diagnostic-secret-key/);
});

test("read-only diagnostics checks health, isolated assemble, and exactly 12 MCP tools", async () => {
  const calls = [];
  const forwardCalls = [];
  const result = await runReadOnlyDiagnostics({
    loadConfig: async () => config,
    stat: async () => ({ mode: 0o100600 }),
    platform: "darwin",
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    createClient: () => ({
      health: async () => {
        calls.push({ method: "health" });
        return { status: "ok" };
      },
      assemble: async (input) => {
        calls.push({ method: "assemble", input });
        return { system_prompt_block: "", token_estimate: 0 };
      },
    }),
    createForwarder: () => async (message) => {
      forwardCalls.push(message);
      if (message.method === "initialize") {
        return [{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }];
      }
      if (message.method === "tools/list") {
        return [{
          jsonrpc: "2.0",
          id: 2,
          result: { tools: EXPOSED_MCP_TOOLS.map((name) => ({ name })) },
        }];
      }
      return [];
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.method), ["health", "assemble"]);
  assert.deepEqual(calls[1].input, {
    sessionId: "context-service-diagnostic-00000000-0000-4000-8000-000000000001",
    query: "",
    extra: {
      disable_rules: true,
      disable_knowledge: true,
      disable_state: true,
      disable_session_state: true,
    },
  });
  assert.deepEqual(forwardCalls.map((message) => message.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.ok(!forwardCalls.some((message) => message.method === "tools/call"));
  assert.match(renderDiagnostics(result), /全部检查通过/);
});

test("read-only diagnostics rejects an MCP tool-set drift without exposing payloads", async () => {
  const result = await runReadOnlyDiagnostics({
    loadConfig: async () => config,
    stat: async () => ({ mode: 0o100600 }),
    createClient: () => ({
      health: async () => ({ status: "ok" }),
      assemble: async () => ({ system_prompt_block: "", token_estimate: 0 }),
    }),
    createForwarder: () => async (message) => {
      if (message.method === "initialize") {
        return [{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }];
      }
      if (message.method === "tools/list") {
        return [{
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "persona_get" }, ...EXPOSED_MCP_TOOLS.map((name) => ({ name }))] },
        }];
      }
      return [];
    },
  });

  assert.equal(result.ok, false);
  const output = renderDiagnostics(result);
  assert.match(output, /工具能力：工具集不符合预期/);
  assert.match(output, /预期 12，实际 13/);
  assert.doesNotMatch(output, /persona_get/);
  assert.doesNotMatch(output, /diagnostic-secret-key/);
});

test("read-only diagnostics fails before network when POSIX permissions are broad", async () => {
  let networkCalled = false;
  const result = await runReadOnlyDiagnostics({
    loadConfig: async () => config,
    stat: async () => ({ mode: 0o100644 }),
    platform: "darwin",
    createClient: () => {
      networkCalled = true;
      return {};
    },
  });

  assert.equal(result.ok, false);
  assert.equal(networkCalled, false);
  assert.match(renderDiagnostics(result), /权限过宽（644）/);
});

test("setup help and general help are local, Chinese, and credential-free", () => {
  const setup = renderSetupHelp();
  const help = renderHelp();
  assert.match(setup, /不要在 Qoder 聊天/);
  assert.match(setup, /read -s CONTEXT_SERVICE_SETUP_KEY/);
  assert.match(help, /推荐顺序/);
  assert.match(help, /context-status/);
  assert.doesNotMatch(`${setup}${help}`, /\.mjs\b|QODER_PLUGIN_ROOT|installPath|persona_get|system_prompt_block/);
  assert.doesNotMatch(`${setup}${help}`, /sk-[a-z0-9]+|Bearer /i);
});
