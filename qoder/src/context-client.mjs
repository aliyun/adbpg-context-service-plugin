export class ContextServiceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ContextServiceError";
    this.status = options.status;
  }
}

export class ContextServiceClient {
  constructor(config, options = {}) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable");
  }

  async assemble({ sessionId, query, personaId, extra = {} }) {
    const context = {
      session_id: sessionId,
      query,
      extra,
    };
    if (personaId) context.persona_id = personaId;

    const response = await this.#request("/v1/assemble", {
      method: "POST",
      body: JSON.stringify({ context }),
    });
    if (typeof response.system_prompt_block !== "string") {
      throw new ContextServiceError("上下文服务返回了无效响应");
    }
    return response;
  }

  async health() {
    return this.#request("/health", { method: "GET" });
  }

  async syncTurn({ sessionId, turnId, userContent, assistantContent }) {
    const response = await this.#request("/v1/sync_turn", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        turn_id: turnId,
        user_content: userContent,
        assistant_content: assistantContent,
      }),
    }, Math.min(this.timeoutMs, 12_000));
    if (response.status !== "ok") {
      throw new ContextServiceError("对话同步返回了无效响应");
    }
    return response;
  }

  async extractTurnMemory({ sessionId, turnId, userContent, assistantContent }) {
    const response = await this.#request("/v1/memory/extract_turn", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        turn_id: turnId,
        user_content: userContent,
        assistant_content: assistantContent,
      }),
    }, Math.min(this.timeoutMs, 12_000));
    if (response.status !== "accepted" || response.turn_id !== turnId) {
      throw new ContextServiceError("长期记忆保存返回了无效响应");
    }
    return response;
  }

  async #request(endpoint, init, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = {};
        }
      }
      if (!response.ok) {
        const detail = body.error || body.detail || `HTTP ${response.status}`;
        throw new ContextServiceError(`context service request failed: ${detail}`, {
          status: response.status,
        });
      }
      return body;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ContextServiceError(`context service timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      if (error instanceof ContextServiceError) throw error;
      throw new ContextServiceError(`context service is unavailable: ${error.message}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
