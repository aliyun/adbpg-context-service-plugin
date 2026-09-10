import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commands = ["context-status", "context-setup", "context-test", "context-help"];

test("manifest and package expose the four Qoder commands", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".qoder-plugin", "plugin.json"), "utf8"),
  );
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  assert.equal(manifest.commands, "./commands/");
  assert.ok(packageJson.files.includes("commands/"));
});

for (const name of commands) {
  test(`${name} is a Chinese, credential-safe prompt command`, async () => {
    const source = await readFile(path.join(pluginRoot, "commands", `${name}.md`), "utf8");
    assert.match(source, new RegExp(`name: ${name}`));
    assert.match(source, /description: [^\x00-\x7F]+/u);
    assert.match(source, /context-service-cli/);
    assert.equal(source.includes(["context-service", "qoder"].join("-")), false);
    assert.match(source, /标准输出逐字作为最终回答/);
    assert.match(source, /不得添加标题、表格、解释、总结/);
    assert.doesNotMatch(source, /\.mjs\b|QODER_PLUGIN_ROOT|installPath|persona_get/);
    assert.doesNotMatch(source, /curl\s+-|Authorization:\s*Bearer|sk-[a-z0-9]+/i);
  });
}

test("setup command explicitly rejects credentials in chat", async () => {
  const source = await readFile(
    path.join(pluginRoot, "commands", "context-setup.md"),
    "utf8",
  );
  assert.match(source, /不得要求用户在聊天/);
  assert.match(source, /撤销该凭据/);
});

test("test command prohibits every Context Service write path", async () => {
  const source = await readFile(
    path.join(pluginRoot, "commands", "context-test.md"),
    "utf8",
  );
  assert.match(source, /不得自行发起网络请求/);
  assert.match(source, /任何其他写操作/);
});
