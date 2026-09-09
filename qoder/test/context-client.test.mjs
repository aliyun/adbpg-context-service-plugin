import assert from "node:assert/strict";
import test from "node:test";
import { ContextServiceClient, ContextServiceError } from "../src/context-client.mjs";

const config = {
  baseUrl: "https://proxy.example.com",
  apiKey: "secret-key",
  timeoutMs: 1000,
};

test("assemble uses the proxy bearer token and never sends scope headers", async () => {
  let captured;
  const client = new ContextServiceClient(config, {
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        system_prompt_block: "team context",
        token_estimate: 2,
      }), { status: 200 });
    },
  });

  const result = await client.assemble({
    sessionId: "session-1",
    query: "deploy",
    extra: { disable_state: true },
  });

  assert.equal(result.system_prompt_block, "team context");
  assert.equal(captured.url, "https://proxy.example.com/v1/assemble");
  assert.equal(captured.init.headers.authorization, "Bearer secret-key");
  assert.deepEqual(Object.keys(captured.init.headers).sort(), [
    "accept",
    "authorization",
    "content-type",
  ]);
  assert.deepEqual(JSON.parse(captured.init.body), {
    context: {
      session_id: "session-1",
      query: "deploy",
      extra: { disable_state: true },
    },
  });
});

test("HTTP failures expose status without exposing the API key", async () => {
  const client = new ContextServiceClient(config, {
    fetch: async () => new Response(JSON.stringify({ error: "admin_token_forbidden" }), {
      status: 403,
    }),
  });

  await assert.rejects(
    client.assemble({ sessionId: "session-1", query: "" }),
    (error) => {
      assert.ok(error instanceof ContextServiceError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /secret-key/);
      return true;
    },
  );
});

test("syncTurn only sends the approved turn fields", async () => {
  let captured;
  const client = new ContextServiceClient(config, {
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    },
  });

  await client.syncTurn({
    sessionId: "session-1",
    turnId: "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
    userContent: "question",
    assistantContent: "answer",
    transcriptPath: "/must/not/be/sent",
  });

  assert.equal(captured.url, "https://proxy.example.com/v1/sync_turn");
  assert.deepEqual(JSON.parse(captured.init.body), {
    session_id: "session-1",
    turn_id: "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
    user_content: "question",
    assistant_content: "answer",
  });
});

test("extractTurnMemory only sends the approved turn fields", async () => {
  let captured;
  const turnId = "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8";
  const client = new ContextServiceClient(config, {
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        status: "accepted",
        turn_id: turnId,
      }), { status: 200 });
    },
  });

  await client.extractTurnMemory({
    sessionId: "session-1",
    turnId,
    userContent: "question",
    assistantContent: "answer",
    transcriptPath: "/must/not/be/sent",
    cwd: "/must/not/be/sent",
  });

  assert.equal(captured.url, "https://proxy.example.com/v1/memory/extract_turn");
  assert.deepEqual(JSON.parse(captured.init.body), {
    session_id: "session-1",
    turn_id: turnId,
    user_content: "question",
    assistant_content: "answer",
  });
});

test("Stop requests abort at the configured timeout", async () => {
  const client = new ContextServiceClient({ ...config, timeoutMs: 100 }, {
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });

  await assert.rejects(
    client.extractTurnMemory({
      sessionId: "session-1",
      turnId: "f4f4d380-e727-5fb3-9a48-73d0db3cbdc8",
      userContent: "question",
      assistantContent: "answer",
    }),
    /timed out after 100ms/,
  );
});
