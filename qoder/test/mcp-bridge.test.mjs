import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpUrl,
  createMcpForwarder,
  EXPOSED_MCP_TOOLS,
  parseMcpHttpResponse,
} from "../src/mcp-bridge.mjs";

const expectedTools = [
  "save_memory",
  "recall_memory",
  "list_memories",
  "delete_memory",
  "search_knowledge",
  "list_knowledge",
  "rules_get",
  "rules_check",
  "session_history",
  "session_search",
  "event_emit",
  "event_query",
];
const readOnlyTools = expectedTools.filter((name) => ![
  "save_memory",
  "delete_memory",
  "event_emit",
].includes(name));

test("managed MCP bridge exposes 12 context tools and excludes persona_get", () => {
  assert.deepEqual(EXPOSED_MCP_TOOLS, expectedTools);
  assert.equal(new Set(EXPOSED_MCP_TOOLS).size, 12);
  assert.ok(!EXPOSED_MCP_TOOLS.includes("persona_get"));
  assert.equal(readOnlyTools.length, 9);
});

test("bridge always targets the public MCP path with a trailing slash", () => {
  assert.equal(
    buildMcpUrl("https://context.example.com/"),
    "https://context.example.com/mcp/",
  );
});

test("bridge parses every JSON-RPC message from an SSE response", () => {
  const messages = parseMcpHttpResponse([
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
    "",
  ].join("\n"), "text/event-stream");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[1].method, "notifications/progress");
});

test("bridge forwards Bearer auth without scope headers and rejects redirects", async () => {
  let captured;
  const forward = createMcpForwarder({
    baseUrl: "https://context.example.com",
    apiKey: "test-key",
    timeoutMs: 1000,
  }, {
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const result = await forward({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });

  assert.equal(captured.url, "https://context.example.com/mcp/");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.headers.authorization, "Bearer test-key");
  assert.deepEqual(Object.keys(captured.init.headers).sort(), [
    "accept",
    "authorization",
    "content-type",
    "mcp-protocol-version",
  ]);
  assert.equal(result[0].result.protocolVersion, "2025-06-18");
});

test("bridge filters tools/list even when the Qoder client ignores includeTools", async () => {
  const forward = createMcpForwarder({
    baseUrl: "https://context.example.com",
    apiKey: "test-key",
    timeoutMs: 1000,
  }, {
    fetch: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: {
        tools: [
          ...EXPOSED_MCP_TOOLS.map((name) => ({ name })),
          { name: "persona_get" },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const result = await forward({ jsonrpc: "2.0", id: 7, method: "tools/list" });

  assert.deepEqual(
    result[0].result.tools.map((tool) => tool.name),
    EXPOSED_MCP_TOOLS,
  );
});

test("bridge rejects calls to tools that the plugin does not expose", async () => {
  let fetchCalled = false;
  const forward = createMcpForwarder({
    baseUrl: "https://context.example.com",
    apiKey: "test-key",
    timeoutMs: 1000,
  }, {
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}");
    },
  });

  await assert.rejects(
    forward({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "persona_get", arguments: {} },
    }),
    /该工具不可用/,
  );
  assert.equal(fetchCalled, false);
});
