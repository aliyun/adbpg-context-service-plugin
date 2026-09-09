import { createInterface } from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const EXPOSED_MCP_TOOLS = Object.freeze([
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
]);

export function buildMcpUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/mcp/`;
}

export function parseMcpHttpResponse(text, contentType = "") {
  if (!text.trim()) return [];
  if (!contentType.includes("text/event-stream")) return [JSON.parse(text)];

  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

export function createMcpForwarder(config, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const mcpUrl = buildMcpUrl(config.baseUrl);
  const exposedTools = new Set(options.exposedTools ?? EXPOSED_MCP_TOOLS);
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;

  return async function forward(message) {
    if (
      message?.method === "tools/call"
      && !exposedTools.has(message.params?.name)
    ) {
      throw new Error("该工具不可用");
    }

    if (message?.method === "initialize" && message.params?.protocolVersion) {
      protocolVersion = message.params.protocolVersion;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(mcpUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "mcp-protocol-version": protocolVersion,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`remote MCP request failed with HTTP ${response.status}`);
      }
      const messages = parseMcpHttpResponse(
        text,
        response.headers.get("content-type") || "",
      );
      if (message?.method === "tools/list") {
        for (const item of messages) {
          if (item?.id === message?.id && Array.isArray(item?.result?.tools)) {
            item.result.tools = item.result.tools.filter(
              (tool) => exposedTools.has(tool?.name),
            );
          }
        }
      }
      const initializeResult = messages.find(
        (item) => item?.id === message?.id && item?.result?.protocolVersion,
      );
      if (initializeResult) protocolVersion = initializeResult.result.protocolVersion;
      return messages;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`remote MCP request timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function errorResponse(message, error) {
  if (message?.id === undefined || message?.id === null) return null;
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32000,
      message: error.message,
    },
  };
}

function publicToolError(error) {
  if (error?.message === "该工具不可用") return error.message;
  const status = /HTTP\s+(\d{3})/i.exec(error?.message ?? "")?.[1];
  if (status) return `工具服务请求失败（HTTP ${status}）`;
  if (/timed out|timeout|超时/i.test(error?.message ?? "")) return "工具服务请求超时";
  return "工具服务暂时不可用";
}

export async function runMcpBridge(config, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const forward = options.forward ?? createMcpForwarder(config, options);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      const responses = await forward(message);
      for (const response of responses) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      const publicError = new Error(publicToolError(error));
      diagnostics.write(`[context-service] ${publicError.message}\n`);
      const response = errorResponse(message, publicError);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
