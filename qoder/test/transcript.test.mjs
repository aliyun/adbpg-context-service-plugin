import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLatestTranscriptTurn } from "../src/transcript.mjs";

async function transcript(lines) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-transcript-"));
  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, `${lines.map(JSON.stringify).join("\n")}\n`);
  return filePath;
}

test("reads the latest assistant and preceding real user while ignoring tool results", async () => {
  const filePath = await transcript([
    { type: "user", uuid: "u-1", message: { content: "first question" } },
    { type: "assistant", uuid: "a-1", message: { content: [{ type: "text", text: "tool call" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "secret output" }] } },
    { type: "assistant", uuid: "a-2", message: { content: [{ type: "text", text: "final answer" }] } },
  ]);

  const turn = await readLatestTranscriptTurn(filePath, { blockBytes: 32 });

  assert.equal(turn.userContent, "first question");
  assert.equal(turn.assistantContent, "final answer");
  assert.equal(turn.assistantUuid, "a-2");
  assert.match(turn.assistantCursor, /^\d+$/);
});

test("bounded tail scan rejects a turn outside the scan window", async () => {
  const filePath = await transcript([
    { type: "user", message: { content: "question" } },
    { type: "assistant", uuid: "a-1", message: { content: "answer" } },
    { type: "system", message: { content: "x".repeat(2048) } },
  ]);

  await assert.rejects(
    readLatestTranscriptTurn(filePath, { maxBytes: 256, blockBytes: 64 }),
    /within scan limit/,
  );
});

test("a malformed latest record fails instead of pairing the current answer with an old user", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-transcript-invalid-"));
  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, [
    JSON.stringify({ type: "user", message: { content: "old question" } }),
    JSON.stringify({ type: "assistant", uuid: "old-assistant", message: { content: "old answer" } }),
    "{invalid-current-record",
  ].join("\n"));

  await assert.rejects(
    readLatestTranscriptTurn(filePath),
    /invalid JSON record/,
  );
});
