import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "bin", "context-service-qoder.mjs");
const publicCliPath = path.join(pluginRoot, "bin", "context-service-qoder");

test("public product command runs without exposing the internal entry", () => {
  const result = spawnSync(publicCliPath, ["help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Context Service 命令帮助/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\.mjs\b|QODER_PLUGIN_ROOT|persona_get/);
});

test("setup accepts --api-key and persists it in the private config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "context-service-qoder-cli-"));
  const configPath = path.join(directory, "qoder.json");
  const result = spawnSync(process.execPath, [
    cliPath,
    "setup",
    "--base-url",
    "https://context.example.com",
    "--api-key",
    "cli-test-key",
    "--enable-stop-sync",
    "--enable-stop-memory-extraction",
  ], {
    encoding: "utf8",
    env: { ...process.env, CONTEXT_SERVICE_CONFIG: configPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /配置已写入/);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.apiKey, "cli-test-key");
  assert.equal(config.stopSyncEnabled, true);
  assert.equal(config.stopMemoryExtractionEnabled, true);
});

test("setup rejects the removed --api-key-file option", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "setup",
    "--base-url",
    "https://context.example.com",
    "--api-key-file",
    "/tmp/key",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--api-key <API Key>/);
});

test("setup --help is credential-safe and does not require configuration", () => {
  const result = spawnSync(process.execPath, [cliPath, "setup", "--help"], {
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不要在 Qoder 聊天/);
  assert.match(result.stdout, /read -s CONTEXT_SERVICE_SETUP_KEY/);
  assert.doesNotMatch(result.stdout, /sk-[a-z0-9]+|Bearer /i);
});

test("help is available without configuration or network", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], {
    encoding: "utf8",
    env: {},
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Context Service 命令帮助/);
  assert.match(result.stdout, /context-status/);
});

test("status fails safely when configuration is absent", () => {
  const result = spawnSync(process.execPath, [cliPath, "status"], {
    encoding: "utf8",
    env: { CONTEXT_SERVICE_CONFIG: path.join(os.tmpdir(), `missing-${Date.now()}.json`) },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /配置：无效或缺失/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Authorization|Bearer|sk-/i);
});

test("Stop file failures are fail-open and do not expose conversation text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "context-service-qoder-stop-"));
  const configPath = path.join(directory, "qoder.json");
  const setupResult = spawnSync(process.execPath, [
    cliPath,
    "setup",
    "--base-url",
    "https://context.example.com",
    "--api-key",
    "cli-test-key",
    "--enable-stop-sync",
  ], {
    encoding: "utf8",
    env: { ...process.env, CONTEXT_SERVICE_CONFIG: configPath },
  });
  assert.equal(setupResult.status, 0, setupResult.stderr);

  const secretText = "private-conversation-text";
  const result = spawnSync(process.execPath, [cliPath, "hook", "Stop"], {
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "s-1",
      transcript_path: path.join(directory, "missing.jsonl"),
      last_assistant_message: secretText,
    }),
    env: { ...process.env, CONTEXT_SERVICE_CONFIG: configPath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "{}");
  assert.doesNotMatch(result.stderr, new RegExp(secretText));
  assert.doesNotMatch(result.stderr, /cli-test-key/);
});
