#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requireSemver(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("--version 必须是严格 SemVer");
  }
  return value;
}

function requireHttpsBase(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("--base-url 必须使用 HTTPS");
  return value.replace(/\/+$/, "");
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function updateVersion(pluginDirectory, version) {
  for (const relativePath of ["package.json", ".qoder-plugin/plugin.json"]) {
    const filePath = path.join(pluginDirectory, relativePath);
    const value = JSON.parse(await readFile(filePath, "utf8"));
    value.version = version;
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }
  await writeFile(
    path.join(pluginDirectory, "src", "version.mjs"),
    `export const PLUGIN_VERSION = ${JSON.stringify(version)};\n`,
  );
}

async function normalizeTimestamps(root) {
  const { readdir } = await import("node:fs/promises");
  const timestamp = new Date("2000-01-01T00:00:00Z");
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      await utimes(fullPath, timestamp, timestamp);
    }
  }
  await walk(root);
  await utimes(root, timestamp, timestamp);
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const version = requireSemver(argument("--version", packageJson.version));
  const baseUrl = requireHttpsBase(argument(
    "--base-url",
    "https://context-database-client.oss-cn-hangzhou.aliyuncs.com/qoder",
  ));
  const outputRoot = path.resolve(argument("--out-dir", path.join(pluginRoot, "dist")));
  const releaseDirectory = path.join(outputRoot, "releases", version);
  const artifactName = `context-service-qoder-${version}.zip`;
  const artifactPath = path.join(releaseDirectory, artifactName);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "context-service-release-"));
  const stagedPlugin = path.join(temporaryRoot, "plugin");
  try {
    await mkdir(stagedPlugin, { recursive: true });
    const releaseEntries = [
      ".qoder-plugin",
      "bin",
      "commands",
      "hooks",
      "skills",
      "src",
      "install.sh",
      "package.json",
      "README.md",
      "PRIVACY.md",
      "SECURITY.md",
    ];
    for (const entry of releaseEntries) {
      await cp(path.join(pluginRoot, entry), path.join(stagedPlugin, entry), { recursive: true });
    }
    await updateVersion(stagedPlugin, version);
    await normalizeTimestamps(stagedPlugin);
    await mkdir(releaseDirectory, { recursive: true });
    execFileSync("zip", ["-X", "-q", "-r", artifactPath, "plugin"], { cwd: temporaryRoot });
    const metadata = await stat(artifactPath);
    const digest = await sha256(artifactPath);
    const manifest = {
      schema_version: 1,
      channel: "stable",
      version,
      released_at: new Date().toISOString(),
      artifact_url: `${baseUrl}/releases/${version}/${artifactName}`,
      artifact_sha256: digest,
      artifact_size: metadata.size,
      min_node_version: "18.0.0",
      min_qodercli_version: "1.1.30",
    };
    const stableDirectory = path.join(outputRoot, "stable");
    await mkdir(stableDirectory, { recursive: true });
    await writeFile(path.join(stableDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await cp(path.join(pluginRoot, "install.sh"), path.join(outputRoot, "install.sh"));
    process.stdout.write(`${JSON.stringify({ artifactPath, manifest }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[context-service-release] ${error.message}\n`);
  process.exitCode = 1;
});
