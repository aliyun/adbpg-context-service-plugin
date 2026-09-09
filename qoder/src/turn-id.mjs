import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const TURN_ID_NAMESPACE = "b4ef0f2e-5180-5f74-9709-33904c7d90df";

function uuidBytes(value) {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("invalid UUID namespace");
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidv5(name, namespace = TURN_ID_NAMESPACE) {
  const digest = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(String(name), "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

export function defaultTurnStatePath(config, env = process.env) {
  const dataDirectory = env.QODER_PLUGIN_DATA?.trim();
  if (dataDirectory) return path.join(dataDirectory, "context-service-turn-state.json");
  return path.join(path.dirname(config.configPath), "context-service-turn-state.json");
}

async function acquireFileLock(lockPath, options = {}) {
  const attempts = options.lockAttempts ?? 100;
  const delayMs = options.lockDelayMs ?? 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("cannot acquire local turn state lock");
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    return value && typeof value === "object" ? value : { sessions: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { sessions: {} };
    throw new Error("cannot read local turn state");
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  } finally {
    await file.close();
  }
  await rename(temporaryPath, statePath);
  if (process.platform !== "win32") await chmod(statePath, 0o600);
}

async function fromPersistentTurnIndex(input, options) {
  const statePath = options.statePath ?? defaultTurnStatePath(options.config, options.env);
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const lock = await acquireFileLock(lockPath, options);
  try {
    const state = await readState(statePath);
    state.sessions ??= {};
    const previous = state.sessions[input.sessionId];
    if (previous?.assistantCursor === input.assistantCursor && previous.turnId) {
      return previous.turnId;
    }
    const turnIndex = Number.isSafeInteger(previous?.turnIndex)
      ? previous.turnIndex + 1
      : 1;
    const turnId = uuidv5(`qoder:${input.sessionId}:turn-index:${turnIndex}`);
    state.sessions[input.sessionId] = {
      assistantCursor: input.assistantCursor,
      turnIndex,
      turnId,
    };
    await writeState(statePath, state);
    return turnId;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function resolveStableTurnId(input, options = {}) {
  const assistantUuid = String(input.assistantUuid || "").trim();
  if (assistantUuid) {
    return uuidv5(`qoder:${input.sessionId}:assistant-uuid:${assistantUuid}`);
  }
  const requestSetId = String(input.requestSetId || "").trim();
  if (requestSetId) {
    return uuidv5(`qoder:${input.sessionId}:request-set-id:${requestSetId}`);
  }
  const assistantCursor = String(input.assistantCursor || "").trim();
  if (!assistantCursor) throw new Error("Transcript assistant record has no stable cursor");
  return fromPersistentTurnIndex({ ...input, assistantCursor }, options);
}
