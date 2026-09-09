import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(pluginRoot, "skills", "context-service-tools", "SKILL.md");
const toolNames = [
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

test("Context Service Skill has valid discovery metadata and covers every tool", async () => {
  const source = await readFile(skillPath, "utf8");
  assert.match(source, /^---\nname: context-service-tools\n/);
  assert.match(source, /\ndescription: .+\n---\n/);
  for (const toolName of toolNames) assert.match(source, new RegExp(`\\b${toolName}\\b`));
  assert.doesNotMatch(source, /\bpersona_get\b/);
});

test("Context Service Skill protects writes and credentials", async () => {
  const source = await readFile(skillPath, "utf8");
  assert.match(source, /explicitly (asks|requests|authorizes)/);
  assert.match(source, /Never save secrets, API keys, access tokens/);
  assert.match(source, /Do not interpret permission to read Context Service as permission to write it/);
  assert.match(source, /rules_check.*first/s);
});
