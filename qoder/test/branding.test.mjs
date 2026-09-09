import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set(["node_modules"]);
const forbiddenIdentities = [
  ["旧展示名称", ["Man", "aged", " Context"].join("")],
  ["旧规范名称", ["man", "aged", "-context"].join("")],
  ["旧环境变量前缀", ["MAN", "AGED", "_CONTEXT_"].join("")],
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

test("plugin source contains no legacy product identity", async () => {
  const matches = [];
  for (const file of await sourceFiles(pluginRoot)) {
    const source = await readFile(file, "utf8");
    for (const [label, value] of forbiddenIdentities) {
      if (source.includes(value)) {
        matches.push(`${label}: ${path.relative(pluginRoot, file)}`);
      }
    }
  }
  assert.deepEqual(matches, []);
});
