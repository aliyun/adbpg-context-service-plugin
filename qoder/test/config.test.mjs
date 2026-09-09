import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfigPath, loadConfig, saveConfig } from "../src/config.mjs";

test("saveConfig creates a reusable private config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "context-service-qoder-"));
  const configPath = path.join(directory, "nested", "qoder.json");

  await saveConfig({
    baseUrl: "https://context.example.com/",
    apiKey: "test-key",
    timeoutMs: 1500,
    sessionStartEnabled: true,
    userPromptSubmitEnabled: false,
    stopSyncEnabled: true,
    stopMemoryExtractionEnabled: true,
  }, { configPath });

  const config = await loadConfig({ configPath, env: {} });
  assert.equal(config.baseUrl, "https://context.example.com");
  assert.equal(config.apiKey, "test-key");
  assert.equal(config.timeoutMs, 1500);
  assert.equal(config.sessionStartEnabled, true);
  assert.equal(config.userPromptSubmitEnabled, false);
  assert.equal(config.stopSyncEnabled, true);
  assert.equal(config.stopMemoryExtractionEnabled, true);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /X-Scope/i);

  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
});

test("loadConfig accepts environment-only configuration", async () => {
  const config = await loadConfig({
    configPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
    env: {
      CONTEXT_SERVICE_BASE_URL: "http://127.0.0.1:8000",
      CONTEXT_SERVICE_API_KEY: "env-key",
      CONTEXT_SERVICE_USER_PROMPT_SUBMIT: "true",
      CONTEXT_SERVICE_STOP_SYNC: "true",
      CONTEXT_SERVICE_STOP_MEMORY_EXTRACTION: "true",
    },
  });
  assert.equal(config.apiKey, "env-key");
  assert.equal(config.userPromptSubmitEnabled, true);
  assert.equal(config.stopSyncEnabled, true);
  assert.equal(config.stopMemoryExtractionEnabled, true);
});

test("remote plaintext HTTP is rejected", async () => {
  await assert.rejects(
    loadConfig({
      configPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      env: {
        CONTEXT_SERVICE_BASE_URL: "http://context.example.com",
        CONTEXT_SERVICE_API_KEY: "test-key",
      },
    }),
    /必须使用 HTTPS/,
  );
});

test("default configuration path uses the context-service directory", () => {
  assert.equal(
    defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/config-root" }, "darwin"),
    path.join("/tmp/config-root", "context-service", "qoder.json"),
  );
});

test("legacy environment variables are ignored", async () => {
  await assert.rejects(
    loadConfig({
      configPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      env: {
        [["MAN", "AGED_CONTEXT_BASE_URL"].join("")]: "https://context.example.com",
        [["MAN", "AGED_CONTEXT_API_KEY"].join("")]: "legacy-key",
      },
    }),
    /缺少服务地址/,
  );
});
