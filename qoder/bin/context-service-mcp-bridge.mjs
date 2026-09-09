#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../src/config.mjs";
import { runMcpBridge } from "../src/mcp-bridge.mjs";

try {
  const config = await loadConfig();
  await runMcpBridge(config);
} catch (error) {
  process.stderr.write("[context-service] 工具服务启动失败，请运行 /context-status 检查配置\n");
  process.exitCode = 1;
}
