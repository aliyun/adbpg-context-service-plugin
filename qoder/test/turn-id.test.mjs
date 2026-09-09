import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultTurnStatePath, resolveStableTurnId, uuidv5 } from "../src/turn-id.mjs";

test("default turn state path uses the context-service identity", () => {
  const config = { configPath: path.join("tmp", "context-service", "qoder.json") };
  assert.equal(
    defaultTurnStatePath(config, {}),
    path.join("tmp", "context-service", "context-service-turn-state.json"),
  );
  assert.equal(
    defaultTurnStatePath(config, { QODER_PLUGIN_DATA: path.join("tmp", "plugin-data") }),
    path.join("tmp", "plugin-data", "context-service-turn-state.json"),
  );
});

test("uuidv5 is deterministic and has RFC version and variant bits", () => {
  const first = uuidv5("same-name");
  assert.equal(first, uuidv5("same-name"));
  assert.notEqual(first, uuidv5("other-name"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("assistant uuid has priority over request_set_id", async () => {
  const common = { sessionId: "s-1", requestSetId: "request-1", assistantCursor: "10" };
  const first = await resolveStableTurnId({ ...common, assistantUuid: "assistant-1" });
  const second = await resolveStableTurnId({ ...common, assistantUuid: "assistant-1", requestSetId: "changed" });
  const next = await resolveStableTurnId({ ...common, assistantUuid: "assistant-2" });
  assert.equal(first, second);
  assert.notEqual(first, next);
});

test("request_set_id is the fallback when assistant uuid is absent", async () => {
  const first = await resolveStableTurnId({
    sessionId: "s-1", requestSetId: "request-1", assistantCursor: "10",
  });
  const second = await resolveStableTurnId({
    sessionId: "s-1", requestSetId: "request-1", assistantCursor: "999",
  });
  assert.equal(first, second);
});

test("persistent turn index reuses the same cursor and advances for a new assistant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-turn-state-"));
  const statePath = path.join(directory, "state.json");
  const options = { statePath, config: { configPath: path.join(directory, "config.json") } };
  const first = await resolveStableTurnId({ sessionId: "s-1", assistantCursor: "10" }, options);
  const repeated = await resolveStableTurnId({ sessionId: "s-1", assistantCursor: "10" }, options);
  const next = await resolveStableTurnId({ sessionId: "s-1", assistantCursor: "20" }, options);

  assert.equal(first, repeated);
  assert.notEqual(first, next);
  const stored = await readFile(statePath, "utf8");
  assert.doesNotMatch(stored, /question|answer|content/);
  assert.equal(JSON.parse(stored).sessions["s-1"].turnIndex, 2);
  if (process.platform !== "win32") {
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  }
});
