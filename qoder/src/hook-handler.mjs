import { loadConfig } from "./config.mjs";
import { ContextServiceClient } from "./context-client.mjs";
import { readLatestTranscriptTurn } from "./transcript.mjs";
import { resolveStableTurnId } from "./turn-id.mjs";

function output(eventName, additionalContext) {
  if (!additionalContext) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

export async function handleHook(eventName, input, options = {}) {
  const config = options.config ?? await loadConfig(options);
  const sessionId = String(input.session_id || "").trim();
  if (!sessionId) throw new Error("hook input is missing session_id");

  if (eventName === "SessionStart") {
    if (!config.sessionStartEnabled) return {};
    const client = options.client ?? new ContextServiceClient(config, options);
    const result = await client.assemble({
      sessionId,
      query: "",
      extra: { disable_knowledge: true },
    });
    return output(eventName, result.system_prompt_block);
  }

  if (eventName === "UserPromptSubmit") {
    if (!config.userPromptSubmitEnabled) return {};
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return {};
    const client = options.client ?? new ContextServiceClient(config, options);
    const result = await client.assemble({
      sessionId,
      query: prompt,
      extra: {
        disable_rules: true,
        disable_session_state: true,
      },
    });
    return output(eventName, result.system_prompt_block);
  }

  if (eventName === "Stop") {
    const syncEnabled = config.stopSyncEnabled === true;
    const extractionEnabled = config.stopMemoryExtractionEnabled === true;
    if (!syncEnabled && !extractionEnabled) return {};

    let turn;
    let assistantContent;
    let turnId;
    try {
      const readTurn = options.readLatestTranscriptTurn ?? readLatestTranscriptTurn;
      const resolveTurnId = options.resolveStableTurnId ?? resolveStableTurnId;
      turn = await readTurn(input.transcript_path, options);
      assistantContent = typeof input.last_assistant_message === "string"
        ? input.last_assistant_message.trim()
        : turn.assistantContent;
      if (!turn.userContent || !assistantContent) {
        throw new Error("Transcript does not contain the current text turn");
      }
      turnId = await resolveTurnId({
        sessionId,
        assistantUuid: turn.assistantUuid,
        requestSetId: input.request_set_id,
        assistantCursor: turn.assistantCursor,
      }, { ...options, config });
    } catch (error) {
      throw new Error("Stop preparation failed", { cause: error });
    }

    const client = options.client ?? new ContextServiceClient(config, options);
    const request = {
      sessionId,
      turnId,
      userContent: turn.userContent,
      assistantContent,
    };
    const actions = [];
    if (syncEnabled) {
      actions.push({
        name: "对话同步",
        promise: client.syncTurn(request),
      });
    }
    if (extractionEnabled) {
      actions.push({
        name: "长期记忆保存",
        promise: client.extractTurnMemory(request),
      });
    }

    const results = await Promise.allSettled(actions.map(({ promise }) => promise));
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const status = Number.isInteger(result.reason?.status)
        ? ` (HTTP ${result.reason.status})`
        : "";
      return [`${actions[index].name}${status}`];
    });
    if (failures.length > 0) {
      throw new Error(`Stop actions failed: ${failures.join(", ")}`);
    }

    return {};
  }

  throw new Error(`unsupported hook event: ${eventName}`);
}
