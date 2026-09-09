import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicFiles = [
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "commands/context-help.md",
  "commands/context-setup.md",
  "commands/context-status.md",
  "commands/context-test.md",
  ".qoder-plugin/plugin.json",
  "skills/context-service-tools/SKILL.md",
];

const internalMarkers = [
  /context-service-(?:qoder|mcp-bridge)\.mjs/,
  /\bpersona_get\b/,
  /\bQODER_PLUGIN_ROOT\b/,
  /\binstallPath\b/,
  /\bsystem_prompt_block\b/,
  /\bJSON-RPC\b/i,
  /\bstdio\b/i,
];

test("published user content does not expose internal implementation markers", async () => {
  for (const relativePath of publicFiles) {
    const source = await readFile(path.join(pluginRoot, relativePath), "utf8");
    for (const marker of internalMarkers) {
      assert.doesNotMatch(source, marker, `${relativePath} exposes ${marker}`);
    }
  }
});

test("developer documentation is not included in the published package", async () => {
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  assert.ok(!packageJson.files.includes("DEVELOPMENT.md"));
});
