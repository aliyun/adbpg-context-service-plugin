import { open } from "node:fs/promises";

export const DEFAULT_TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_BLOCK_BYTES = 256 * 1024;

function roleOf(record) {
  return record?.message?.role || record?.role || record?.type;
}

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => typeof item.text === "string" ? item.text.trim() : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function contentOf(record) {
  return record?.message?.content ?? record?.content;
}

function isToolResultUser(record) {
  const content = contentOf(record);
  if (!Array.isArray(content) || content.length === 0) return false;
  const meaningful = content.filter(Boolean);
  return meaningful.length > 0 && meaningful.every((item) =>
    ["tool_result", "tool_use_result"].includes(item?.type));
}

function parseCompleteTurn(buffer, startOffset, fileStartsHere) {
  let text = buffer.toString("utf8");
  let baseOffset = startOffset;
  if (!fileStartsHere) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return null;
    baseOffset += Buffer.byteLength(text.slice(0, firstNewline + 1));
    text = text.slice(firstNewline + 1);
  }

  const lines = text.split("\n");
  const parsed = [];
  let byteOffset = 0;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const absoluteOffset = baseOffset + byteOffset;
    byteOffset += Buffer.byteLength(rawLine) + 1;
    if (!line.trim()) continue;
    try {
      parsed.push({ record: JSON.parse(line), offset: absoluteOffset });
    } catch (error) {
      throw new Error("Transcript contains an invalid JSON record", { cause: error });
    }
  }

  let assistant;
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const candidate = parsed[index];
    if (roleOf(candidate.record) !== "assistant") continue;
    assistant = { ...candidate, index };
    break;
  }
  if (!assistant) return null;

  for (let index = assistant.index - 1; index >= 0; index -= 1) {
    const candidate = parsed[index];
    if (roleOf(candidate.record) !== "user" || isToolResultUser(candidate.record)) continue;
    const userContent = textOf(contentOf(candidate.record));
    if (!userContent) continue;
    return {
      userContent,
      assistantContent: textOf(contentOf(assistant.record)),
      assistantUuid: typeof assistant.record.uuid === "string"
        ? assistant.record.uuid.trim()
        : "",
      assistantCursor: String(assistant.offset),
    };
  }
  return null;
}

export async function readLatestTranscriptTurn(transcriptPath, options = {}) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    throw new Error("Stop hook input is missing transcript_path");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_SCAN_BYTES;
  const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES;
  const openFile = options.openFile ?? open;
  const file = await openFile(transcriptPath, "r");
  try {
    const { size } = await file.stat();
    const lowerBound = Math.max(0, size - maxBytes);
    let position = size;
    let accumulated = Buffer.alloc(0);

    while (position > lowerBound) {
      const start = Math.max(lowerBound, position - blockBytes);
      const chunk = Buffer.alloc(position - start);
      await file.read(chunk, 0, chunk.length, start);
      accumulated = Buffer.concat([chunk, accumulated]);
      position = start;
      const turn = parseCompleteTurn(accumulated, start, start === 0);
      if (turn) return turn;
    }
    throw new Error("Transcript does not contain a complete text turn within scan limit");
  } finally {
    await file.close();
  }
}
