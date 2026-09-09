import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../src/hook-handler.mjs";

const baseConfig = {
  sessionStartEnabled: true,
  userPromptSubmitEnabled: false,
  stopSyncEnabled: false,
  stopMemoryExtractionEnabled: false,
};

test("SessionStart injects stable context without knowledge search", async () => {
  let request;
  const result = await handleHook("SessionStart", { session_id: "s-1", type: "startup" }, {
    config: baseConfig,
    client: {
      async assemble(value) {
        request = value;
        return { system_prompt_block: "stable context" };
      },
    },
  });

  assert.deepEqual(request, {
    sessionId: "s-1",
    query: "",
    extra: { disable_knowledge: true },
  });
  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "stable context",
    },
  });
});

test("Stop is disabled by default without reading Transcript or using network", async () => {
  const result = await handleHook("Stop", {
    session_id: "s-1",
    transcript_path: "/not/read",
  }, {
    config: baseConfig,
    readLatestTranscriptTurn: () => assert.fail("Transcript must not be read"),
    client: { syncTurn: () => assert.fail("network must not be used") },
  });
  assert.deepEqual(result, {});
});

test("Stop sends the current turn with a stable id", async () => {
  let idInput;
  let request;
  const result = await handleHook("Stop", {
    session_id: "s-1",
    transcript_path: "/local/transcript.jsonl",
    request_set_id: "request-1",
    last_assistant_message: "  final answer  ",
  }, {
    config: { ...baseConfig, stopSyncEnabled: true },
    readLatestTranscriptTurn: async () => ({
      userContent: "question",
      assistantContent: "draft answer",
      assistantUuid: "assistant-1",
      assistantCursor: "123",
    }),
    resolveStableTurnId: async (value) => {
      idInput = value;
      return "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8";
    },
    client: {
      async syncTurn(value) {
        request = value;
      },
    },
  });

  assert.deepEqual(result, {});
  assert.deepEqual(idInput, {
    sessionId: "s-1",
    assistantUuid: "assistant-1",
    requestSetId: "request-1",
    assistantCursor: "123",
  });
  assert.deepEqual(request, {
    sessionId: "s-1",
    turnId: "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
    userContent: "question",
    assistantContent: "final answer",
  });
});

test("Stop masks remote error details that could contain conversation text", async () => {
  await assert.rejects(
    handleHook("Stop", {
      session_id: "s-1",
      transcript_path: "/local/transcript.jsonl",
      last_assistant_message: "answer",
    }, {
      config: { ...baseConfig, stopSyncEnabled: true },
      readLatestTranscriptTurn: async () => ({
        userContent: "question",
        assistantUuid: "assistant-1",
        assistantCursor: "123",
      }),
      resolveStableTurnId: async () => "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
      client: {
        async syncTurn() {
          const error = new Error("server echoed private conversation");
          error.status = 503;
          throw error;
        },
      },
    }),
    (error) => {
      assert.equal(error.message, "Stop actions failed: 对话同步 (HTTP 503)");
      assert.doesNotMatch(error.message, /private conversation/);
      return true;
    },
  );
});

test("the same Stop input produces the same turn_id end to end", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-stop-repeat-"));
  const transcriptPath = path.join(directory, "session.jsonl");
  await writeFile(transcriptPath, [
    JSON.stringify({ type: "user", uuid: "user-1", message: { content: "question" } }),
    JSON.stringify({ type: "assistant", uuid: "assistant-1", message: { content: "answer" } }),
    "",
  ].join("\n"));
  const turnIds = [];
  const options = {
    config: {
      ...baseConfig,
      stopSyncEnabled: true,
      configPath: path.join(directory, "config.json"),
    },
    client: {
      async syncTurn(value) {
        turnIds.push(value.turnId);
      },
    },
  };
  const input = {
    session_id: "s-repeat",
    transcript_path: transcriptPath,
    last_assistant_message: "answer",
  };

  await handleHook("Stop", input, options);
  await handleHook("Stop", input, options);

  assert.equal(turnIds.length, 2);
  assert.equal(turnIds[0], turnIds[1]);
});

test("Stop can run memory extraction without trajectory sync", async () => {
  let extractionRequest;
  const result = await handleHook("Stop", {
    session_id: "s-1",
    transcript_path: "/local/transcript.jsonl",
    last_assistant_message: "answer",
  }, {
    config: { ...baseConfig, stopMemoryExtractionEnabled: true },
    readLatestTranscriptTurn: async () => ({
      userContent: "question",
      assistantUuid: "assistant-1",
      assistantCursor: "123",
    }),
    resolveStableTurnId: async () => "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
    client: {
      syncTurn: () => assert.fail("sync must not run"),
      async extractTurnMemory(value) {
        extractionRequest = value;
      },
    },
  });

  assert.deepEqual(result, {});
  assert.deepEqual(extractionRequest, {
    sessionId: "s-1",
    turnId: "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
    userContent: "question",
    assistantContent: "answer",
  });
});

test("Stop starts sync and extraction in parallel with one transcript read", async () => {
  let reads = 0;
  let resolves = 0;
  const started = [];
  let releaseSync;
  let releaseExtraction;
  const syncPending = new Promise((resolve) => { releaseSync = resolve; });
  const extractionPending = new Promise((resolve) => { releaseExtraction = resolve; });

  const pending = handleHook("Stop", {
    session_id: "s-1",
    transcript_path: "/local/transcript.jsonl",
    last_assistant_message: "answer",
  }, {
    config: {
      ...baseConfig,
      stopSyncEnabled: true,
      stopMemoryExtractionEnabled: true,
    },
    readLatestTranscriptTurn: async () => {
      reads += 1;
      return {
        userContent: "question",
        assistantUuid: "assistant-1",
        assistantCursor: "123",
      };
    },
    resolveStableTurnId: async () => {
      resolves += 1;
      return "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8";
    },
    client: {
      async syncTurn() {
        started.push("sync");
        return syncPending;
      },
      async extractTurnMemory() {
        started.push("extraction");
        return extractionPending;
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["extraction", "sync"]);
  assert.equal(reads, 1);
  assert.equal(resolves, 1);
  releaseSync();
  releaseExtraction();
  assert.deepEqual(await pending, {});
});

test("Stop waits for successful extraction when sync fails", async () => {
  let extractionCompleted = false;
  await assert.rejects(
    handleHook("Stop", {
      session_id: "s-1",
      transcript_path: "/local/transcript.jsonl",
      last_assistant_message: "answer",
    }, {
      config: {
        ...baseConfig,
        stopSyncEnabled: true,
        stopMemoryExtractionEnabled: true,
      },
      readLatestTranscriptTurn: async () => ({
        userContent: "question",
        assistantUuid: "assistant-1",
        assistantCursor: "123",
      }),
      resolveStableTurnId: async () => "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
      client: {
        async syncTurn() {
          const error = new Error("private upstream detail");
          error.status = 503;
          throw error;
        },
        async extractTurnMemory() {
          await new Promise((resolve) => setImmediate(resolve));
          extractionCompleted = true;
        },
      },
    }),
    (error) => {
      assert.equal(error.message, "Stop actions failed: 对话同步 (HTTP 503)");
      assert.equal(extractionCompleted, true);
      assert.doesNotMatch(error.message, /private upstream detail/);
      return true;
    },
  );
});

test("Stop keeps successful sync when memory extraction fails", async () => {
  let syncCompleted = false;
  await assert.rejects(
    handleHook("Stop", {
      session_id: "s-1",
      transcript_path: "/local/transcript.jsonl",
      last_assistant_message: "answer",
    }, {
      config: {
        ...baseConfig,
        stopSyncEnabled: true,
        stopMemoryExtractionEnabled: true,
      },
      readLatestTranscriptTurn: async () => ({
        userContent: "question",
        assistantUuid: "assistant-1",
        assistantCursor: "123",
      }),
      resolveStableTurnId: async () => "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
      client: {
        async syncTurn() {
          syncCompleted = true;
        },
        async extractTurnMemory() {
          const error = new Error("private memory detail");
          error.status = 502;
          throw error;
        },
      },
    }),
    (error) => {
      assert.equal(error.message, "Stop actions failed: 长期记忆保存 (HTTP 502)");
      assert.equal(syncCompleted, true);
      assert.doesNotMatch(error.message, /private memory detail/);
      return true;
    },
  );
});

test("Stop reports both action failures without private details", async () => {
  await assert.rejects(
    handleHook("Stop", {
      session_id: "s-1",
      transcript_path: "/local/transcript.jsonl",
      last_assistant_message: "answer",
    }, {
      config: {
        ...baseConfig,
        stopSyncEnabled: true,
        stopMemoryExtractionEnabled: true,
      },
      readLatestTranscriptTurn: async () => ({
        userContent: "question",
        assistantUuid: "assistant-1",
        assistantCursor: "123",
      }),
      resolveStableTurnId: async () => "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
      client: {
        async syncTurn() {
          throw Object.assign(new Error("sync secret"), { status: 503 });
        },
        async extractTurnMemory() {
          throw Object.assign(new Error("memory secret"), { status: 502 });
        },
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Stop actions failed: 对话同步 (HTTP 503), 长期记忆保存 (HTTP 502)",
      );
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("UserPromptSubmit is disabled by default", async () => {
  const result = await handleHook("UserPromptSubmit", {
    session_id: "s-1",
    prompt: "how do I deploy?",
  }, {
    config: baseConfig,
    client: { assemble: () => assert.fail("assemble should not be called") },
  });
  assert.deepEqual(result, {});
});

test("UserPromptSubmit can inject query-specific context", async () => {
  let request;
  const result = await handleHook("UserPromptSubmit", {
    session_id: "s-1",
    prompt: "  how do I deploy?  ",
  }, {
    config: { ...baseConfig, userPromptSubmitEnabled: true },
    client: {
      async assemble(value) {
        request = value;
        return { system_prompt_block: "deployment context" };
      },
    },
  });

  assert.deepEqual(request, {
    sessionId: "s-1",
    query: "how do I deploy?",
    extra: {
      disable_rules: true,
      disable_session_state: true,
    },
  });
  assert.equal(
    result.hookSpecificOutput.additionalContext,
    "deployment context",
  );
});
