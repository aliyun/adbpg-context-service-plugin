import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareSemver,
  EXIT_CODES,
  lifecyclePaths,
  parseSemver,
  readInstallState,
  renderLifecycleError,
  runLifecycleCommand,
  validateReleaseManifest,
  validateZipEntries,
} from "../src/lifecycle.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function manifest(version) {
  return {
    schema_version: 1,
    channel: "stable",
    version,
    released_at: "2026-08-27T00:00:00Z",
    artifact_url: `https://context.example.com/qoder/${version}.zip`,
    artifact_sha256: "0".repeat(64),
    artifact_size: 1,
    min_node_version: "18.0.0",
    min_qodercli_version: "1.1.30",
  };
}

async function createPluginSource(root, version) {
  const source = path.join(root, `source-${version}`);
  await mkdir(path.join(source, ".qoder-plugin"), { recursive: true });
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, ".qoder-plugin", "plugin.json"), JSON.stringify({
    name: "context-service",
    version,
  }));
  await writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "@context-service/qoder-plugin",
    version,
  }));
  await writeFile(path.join(source, "bin", "context-service-mcp-bridge.mjs"), "// test\n");
  await writeFile(path.join(source, "bin", "context-service-qoder.mjs"), "// test\n");
  return source;
}

function createQoderMock() {
  const state = {
    plugin: null,
    mcp: null,
    calls: [],
    failMcpAdds: 0,
  };
  const runner = (command, args) => {
    state.calls.push([command, ...args]);
    assert.equal(command, "qodercli");
    if (args[0] === "--version") return "1.1.30";
    if (args[0] === "plugins" && args[1] === "list") {
      return JSON.stringify(state.plugin ? [state.plugin] : []);
    }
    if (args[0] === "plugins" && args[1] === "validate") return "valid";
    if (args[0] === "plugins" && args[1] === "install") {
      const source = args[2];
      const packageJson = JSON.parse(spawnSync(process.execPath, [
        "-e",
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        path.join(source, "package.json"),
      ], { encoding: "utf8" }).stdout);
      state.plugin = {
        id: "context-service@local",
        name: "context-service",
        version: packageJson.version,
        scope: "user",
        installPath: `/mock/qoder/context-service/${packageJson.version}`,
        installedAt: new Date().toISOString(),
      };
      return JSON.stringify({ ok: true, pluginId: state.plugin.id, installPath: state.plugin.installPath });
    }
    if (args[0] === "plugins" && args[1] === "uninstall") {
      state.plugin = null;
      return JSON.stringify({ ok: true });
    }
    if (args[0] === "mcp" && args[1] === "get") {
      if (!state.mcp) return "Server \"context-service\" not found in user settings.";
      return `user settings (/mock/settings.json):\n${JSON.stringify({ "context-service": state.mcp })}`;
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      state.mcp = null;
      return "removed";
    }
    if (args[0] === "mcp" && args[1] === "add") {
      if (state.failMcpAdds > 0) {
        state.failMcpAdds -= 1;
        throw new Error("injected MCP add failure");
      }
      state.mcp = { command: args[5], args: args.slice(6) };
      return "added";
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { state, runner };
}

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-service-lifecycle-test-"));
  const env = {
    XDG_BIN_HOME: path.join(home, "bin"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CONFIG_HOME: path.join(home, "config"),
  };
  const paths = lifecyclePaths(env, home);
  const qoder = createQoderMock();
  return {
    home,
    env,
    paths,
    qoder,
    dependencies: {
      env,
      homeDirectory: home,
      platform: "darwin",
      commandRunner: qoder.runner,
    },
  };
}

test("strict SemVer comparison supports releases and prereleases", () => {
  assert.ok(parseSemver("1.2.3"));
  assert.equal(parseSemver("01.2.3"), null);
  assert.equal(compareSemver("1.2.3", "1.2.2"), 1);
  assert.equal(compareSemver("1.2.3-beta.1", "1.2.3"), -1);
});

test("release manifest rejects insecure artifact URLs and malformed hashes", () => {
  const insecure = manifest("1.0.0");
  insecure.artifact_url = "http://context.example.com/plugin.zip";
  assert.throws(() => validateReleaseManifest(insecure), { exitCode: EXIT_CODES.INVALID_INPUT });
  const badHash = manifest("1.0.0");
  badHash.artifact_sha256 = "abcd";
  assert.throws(() => validateReleaseManifest(badHash), { exitCode: EXIT_CODES.INVALID_INPUT });
});

test("ZIP entry validation rejects absolute and traversal paths", () => {
  assert.throws(() => validateZipEntries("/etc/passwd\n"), {
    exitCode: EXIT_CODES.DOWNLOAD_OR_INTEGRITY,
    errorType: "unsafe_archive_path",
  });
  assert.throws(() => validateZipEntries("plugin/../../escape\n"), {
    exitCode: EXIT_CODES.DOWNLOAD_OR_INTEGRITY,
    errorType: "unsafe_archive_path",
  });
});

test("a malicious install state cannot redirect lifecycle paths", async () => {
  const current = await fixture();
  await mkdir(current.paths.stateRoot, { recursive: true });
  await writeFile(current.paths.statePath, JSON.stringify({
    schemaVersion: 1,
    version: "1.0.0",
    channel: "stable",
    versionDirectory: "/",
    pluginId: "context-service@local",
    pluginScope: "user",
    installPath: "/mock/qoder/context-service/1.0.0",
    mcpName: "context-service",
    mcp: {
      type: "stdio",
      command: "node",
      args: ["/mock/qoder/context-service/1.0.0/bin/context-service-mcp-bridge.mjs"],
    },
    artifactUrl: "https://context.example.com/qoder/1.0.0.zip",
    artifactSha256: "0".repeat(64),
  }));
  await assert.rejects(readInstallState(current.paths), {
    exitCode: EXIT_CODES.LOCAL_STATE,
    errorType: "invalid_install_state",
  });
});

test("formal install registers the user plugin and IDE MCP idempotently", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  const options = { sourceDir: source, manifest: manifest("1.0.0"), paths: current.paths };

  const installed = await runLifecycleCommand("install", options, current.dependencies);
  assert.equal(installed.status, "installed");
  assert.ok(!Object.hasOwn(installed, "installPath"));
  assert.equal(current.qoder.state.plugin.scope, "user");
  assert.deepEqual(current.qoder.state.mcp, {
    command: "node",
    args: ["/mock/qoder/context-service/1.0.0/bin/context-service-mcp-bridge.mjs"],
  });
  const state = await readInstallState(current.paths);
  assert.equal(state.version, "1.0.0");
  assert.doesNotMatch(JSON.stringify(state), /apiKey|Authorization|Bearer|sk-/i);
  assert.equal((await stat(current.paths.commandPath)).mode & 0o777, 0o755);

  const second = await runLifecycleCommand("install", options, current.dependencies);
  assert.equal(second.status, "already_installed");
  assert.equal(current.qoder.state.calls.filter((call) => call[1] === "plugins" && call[2] === "install").length, 1);
});

test("formal install refuses an externally owned Context Service plugin", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  current.qoder.state.plugin = {
    id: "context-service@manual",
    name: "context-service",
    version: "9.9.9",
    scope: "user",
    installPath: "/user/manual/context-service",
  };
  await assert.rejects(
    runLifecycleCommand("install", {
      sourceDir: source,
      manifest: manifest("1.0.0"),
      paths: current.paths,
    }, current.dependencies),
    { exitCode: EXIT_CODES.QODER_REGISTRATION, errorType: "plugin_conflict" },
  );
  assert.equal(current.qoder.state.plugin.version, "9.9.9");
});

test("a live lifecycle lock rejects a concurrent mutation", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  await mkdir(current.paths.lockPath, { recursive: true });
  await writeFile(path.join(current.paths.lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(
    runLifecycleCommand("install", {
      sourceDir: source,
      manifest: manifest("1.0.0"),
      paths: current.paths,
    }, current.dependencies),
    { exitCode: EXIT_CODES.LOCAL_STATE, errorType: "lock_busy" },
  );
});

test("an explicit target version resolves its immutable manifest", async () => {
  const current = await fixture();
  let requestedUrl;
  const result = await runLifecycleCommand("install", {
    targetVersion: "1.4.0",
    manifestUrl: "https://downloads.example.com/qoder/stable/latest.json",
    paths: current.paths,
    dryRun: true,
  }, {
    ...current.dependencies,
    fetch: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify(manifest("1.4.0")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.status, "dry_run");
  assert.equal(requestedUrl, "https://downloads.example.com/qoder/releases/1.4.0/manifest.json");
});

test("upgrade switches the plugin and MCP path only after validation", async () => {
  const current = await fixture();
  const firstSource = await createPluginSource(current.home, "1.0.0");
  const secondSource = await createPluginSource(current.home, "1.1.0");
  await runLifecycleCommand("install", {
    sourceDir: firstSource,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);

  const upgraded = await runLifecycleCommand("upgrade", {
    sourceDir: secondSource,
    manifest: manifest("1.1.0"),
    paths: current.paths,
  }, current.dependencies);
  assert.equal(upgraded.status, "upgraded");
  assert.equal(upgraded.previousVersion, "1.0.0");
  assert.equal((await readInstallState(current.paths)).version, "1.1.0");
  assert.match(current.qoder.state.mcp.args[0], /\/1\.1\.0\/bin\/context-service-mcp-bridge\.mjs$/);
});

test("successful upgrades retain only the current and previous versions", async () => {
  const current = await fixture();
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
    const source = await createPluginSource(current.home, version);
    await runLifecycleCommand(version === "1.0.0" ? "install" : "upgrade", {
      sourceDir: source,
      manifest: manifest(version),
      paths: current.paths,
    }, current.dependencies);
  }
  assert.deepEqual((await readdir(current.paths.versionsRoot)).sort(), ["1.1.0", "1.2.0"]);
});

test("upgrade restores the committed plugin and MCP when registration fails", async () => {
  const current = await fixture();
  const firstSource = await createPluginSource(current.home, "1.0.0");
  const secondSource = await createPluginSource(current.home, "2.0.0");
  await runLifecycleCommand("install", {
    sourceDir: firstSource,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);
  current.qoder.state.failMcpAdds = 1;

  await assert.rejects(
    runLifecycleCommand("upgrade", {
      sourceDir: secondSource,
      manifest: manifest("2.0.0"),
      paths: current.paths,
    }, current.dependencies),
    { exitCode: EXIT_CODES.ROLLED_BACK, errorType: "upgrade_rolled_back" },
  );
  assert.equal((await readInstallState(current.paths)).version, "1.0.0");
  assert.equal(current.qoder.state.plugin.version, "1.0.0");
  assert.match(current.qoder.state.mcp.args[0], /\/1\.0\.0\/bin\/context-service-mcp-bridge\.mjs$/);
});

test("upgrade refuses downgrade unless it is explicit", async () => {
  const current = await fixture();
  const firstSource = await createPluginSource(current.home, "2.0.0");
  const oldSource = await createPluginSource(current.home, "1.0.0");
  await runLifecycleCommand("install", {
    sourceDir: firstSource,
    manifest: manifest("2.0.0"),
    paths: current.paths,
  }, current.dependencies);
  await assert.rejects(
    runLifecycleCommand("upgrade", {
      sourceDir: oldSource,
      manifest: manifest("1.0.0"),
      paths: current.paths,
    }, current.dependencies),
    { exitCode: EXIT_CODES.INVALID_INPUT, errorType: "downgrade_not_allowed" },
  );
});

test("default uninstall preserves data and a user-modified MCP registration", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  await mkdir(path.dirname(current.paths.configPath), { recursive: true });
  await writeFile(current.paths.configPath, JSON.stringify({ apiKey: "secret-test-value" }));
  await runLifecycleCommand("install", {
    sourceDir: source,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);
  current.qoder.state.mcp.args = ["/user/modified/bridge.mjs"];

  const result = await runLifecycleCommand("uninstall", { paths: current.paths }, current.dependencies);
  assert.equal(result.status, "uninstalled");
  assert.equal(result.dataPreserved, true);
  assert.equal(result.modifiedMcpPreserved, true);
  await access(current.paths.configPath);
  assert.equal(current.qoder.state.plugin, null);
  assert.deepEqual(current.qoder.state.mcp.args, ["/user/modified/bridge.mjs"]);
});

test("purge requires confirmation and removes only known Context Service data", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  await mkdir(path.dirname(current.paths.configPath), { recursive: true });
  await writeFile(current.paths.configPath, "{}\n");
  await writeFile(current.paths.turnStatePath, "{}\n");
  await runLifecycleCommand("install", {
    sourceDir: source,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);
  await assert.rejects(
    runLifecycleCommand("uninstall", { paths: current.paths, purgeData: true }, current.dependencies),
    { exitCode: EXIT_CODES.INVALID_INPUT },
  );
  const result = await runLifecycleCommand("uninstall", {
    paths: current.paths,
    purgeData: true,
    yes: true,
  }, current.dependencies);
  assert.equal(result.dataPreserved, false);
  await assert.rejects(access(current.paths.configPath));
  await assert.rejects(access(current.paths.turnStatePath));
});

test("dry-run performs no Qoder registration or filesystem commit", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  const result = await runLifecycleCommand("install", {
    sourceDir: source,
    manifest: manifest("1.0.0"),
    paths: current.paths,
    dryRun: true,
  }, current.dependencies);
  assert.equal(result.status, "dry_run");
  assert.equal(current.qoder.state.plugin, null);
  assert.equal(await readInstallState(current.paths), null);
  await assert.rejects(access(current.paths.stateRoot));
});

test("an interrupted upgrade is recovered before the next operation", async () => {
  const current = await fixture();
  const source = await createPluginSource(current.home, "1.0.0");
  await runLifecycleCommand("install", {
    sourceDir: source,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);
  const committed = await readInstallState(current.paths);
  await writeFile(current.paths.transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "upgrade",
    targetVersion: "2.0.0",
    previousState: committed,
  })}\n`);
  current.qoder.state.plugin = null;
  current.qoder.state.mcp = null;

  const result = await runLifecycleCommand("install", {
    sourceDir: source,
    manifest: manifest("1.0.0"),
    paths: current.paths,
  }, current.dependencies);
  assert.equal(result.status, "already_installed");
  assert.equal(current.qoder.state.plugin.version, "1.0.0");
  assert.match(current.qoder.state.mcp.args[0], /\/1\.0\.0\/bin\/context-service-mcp-bridge\.mjs$/);
  await assert.rejects(access(current.paths.transactionPath));
});

test("machine-readable errors redact credentials", () => {
  const output = renderLifecycleError(
    new Error("Bearer abc123 sk-sensitive apiKey=top-secret"),
    "install",
    true,
  );
  assert.doesNotMatch(output, /abc123|sk-sensitive|top-secret/);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, EXIT_CODES.LOCAL_STATE);
});

test("release builder produces a manifest whose size and digest match the ZIP", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "context-service-release-test-"));
  const result = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts", "build-release.mjs"),
    "--version", "1.2.3",
    "--base-url", "https://downloads.example.com/qoder",
    "--out-dir", outputRoot,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(result.stdout);
  const artifact = await readFile(release.artifactPath);
  assert.equal(artifact.length, release.manifest.artifact_size);
  assert.equal(createHash("sha256").update(artifact).digest("hex"), release.manifest.artifact_sha256);
  assert.equal(release.manifest.version, "1.2.3");
  const immutableManifest = JSON.parse(await readFile(
    path.join(outputRoot, "releases", "1.2.3", "manifest.json"),
    "utf8",
  ));
  assert.deepEqual(immutableManifest, release.manifest);
  const archiveEntries = execFileSync("unzip", ["-Z1", release.artifactPath], {
    encoding: "utf8",
  });
  assert.doesNotMatch(archiveEntries, /DEVELOPMENT\.md/);
  for (const relativePath of [
    "README.md",
    "PRIVACY.md",
    "SECURITY.md",
    "commands/context-help.md",
    "commands/context-setup.md",
    "commands/context-status.md",
    "commands/context-test.md",
  ]) {
    const content = execFileSync(
      "unzip",
      ["-p", release.artifactPath, `plugin/${relativePath}`],
      { encoding: "utf8" },
    );
    assert.doesNotMatch(
      content,
      /context-service-(?:qoder|mcp-bridge)\.mjs|persona_get|QODER_PLUGIN_ROOT|installPath|system_prompt_block|JSON-RPC|\bstdio\b/i,
      `${relativePath} exposes internal implementation details`,
    );
  }
});

test("a built ZIP passes the real safe extraction path", async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "context-service-release-install-test-"));
  const build = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts", "build-release.mjs"),
    "--version", "1.3.0",
    "--base-url", "https://downloads.example.com/qoder",
    "--out-dir", outputRoot,
  ], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const release = JSON.parse(build.stdout);
  const artifact = await readFile(release.artifactPath);
  const current = await fixture();
  const commandRunner = (command, args) => command === "unzip"
    ? execFileSync(command, args, { encoding: "utf8" }).trim()
    : current.qoder.runner(command, args);
  const result = await runLifecycleCommand("install", {
    manifest: release.manifest,
    paths: current.paths,
  }, {
    ...current.dependencies,
    commandRunner,
    fetch: async () => new Response(artifact, {
      status: 200,
      headers: { "content-length": String(artifact.length) },
    }),
  });
  assert.equal(result.status, "installed");
  assert.equal((await readInstallState(current.paths)).version, "1.3.0");
});

test("ZIP symbolic links are rejected before extraction", async () => {
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "context-service-unsafe-zip-"));
  const plugin = await createPluginSource(archiveRoot, "1.0.0");
  await symlink("/tmp/outside-context-service", path.join(plugin, "escape"));
  const artifactPath = path.join(archiveRoot, "unsafe.zip");
  execFileSync("zip", ["-y", "-q", "-r", artifactPath, path.basename(plugin)], {
    cwd: path.dirname(plugin),
  });
  const artifact = await readFile(artifactPath);
  const unsafeManifest = manifest("1.0.0");
  unsafeManifest.artifact_size = artifact.length;
  unsafeManifest.artifact_sha256 = createHash("sha256").update(artifact).digest("hex");
  const current = await fixture();
  const commandRunner = (command, args) => command === "unzip"
    ? execFileSync(command, args, { encoding: "utf8" }).trim()
    : current.qoder.runner(command, args);
  await assert.rejects(
    runLifecycleCommand("install", { manifest: unsafeManifest, paths: current.paths }, {
      ...current.dependencies,
      commandRunner,
      fetch: async () => new Response(artifact, {
        status: 200,
        headers: { "content-length": String(artifact.length) },
      }),
    }),
    { exitCode: EXIT_CODES.DOWNLOAD_OR_INTEGRITY, errorType: "unsafe_archive_symlink" },
  );
});

test("POSIX installer is syntactically valid and never accepts an API key", async () => {
  const installerPath = path.join(pluginRoot, "install.sh");
  const result = spawnSync("sh", ["-n", installerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const source = await readFile(installerPath, "utf8");
  assert.doesNotMatch(source, /--api-key|CONTEXT_SERVICE_API_KEY/);
});
