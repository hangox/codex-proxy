/**
 * E2E tests for POST /v1/chat/completions.
 *
 * Only mocks the external boundary (transport, config, paths, fs, background tasks).
 * CodexApi, AccountPool, CookieJar, all translation layers, all middleware run for real.
 *
 * Each test builds a fresh Hono app to avoid shared account-lock state.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getLastTransportBody,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import {
  buildTextStreamChunks,
  buildToolCallStreamChunks,
  buildReasoningStreamChunks,
  buildDetailedUsageStreamChunks,
  buildMultiToolCallStreamChunks,
} from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

// ── App imports (after mocks declared in e2e-setup) ──────────────────

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

// ── Per-test app lifecycle ───────────────────────────────────────────

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

let ctx: TestContext;

function buildApp(opts?: { noAccount?: boolean }): TestContext {
  loadStaticModels();

  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();

  if (!opts?.noAccount) {
    accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-1",
      email: "e2e@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createChatRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_1", "Hello!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

// ── Helpers ──────────────────────────────────────────────────────────

function chatRequest(body: unknown) {
  return ctx.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

/** Parse SSE text into an array of data objects. */
function parseSSE(text: string): unknown[] {
  const results: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const raw = line.slice(6);
      if (raw === "[DONE]") {
        results.push("[DONE]");
      } else {
        try { results.push(JSON.parse(raw)); } catch { results.push(raw); }
      }
    }
  }
  return results;
}

// ── Type helpers for assertions ──────────────────────────────────────

interface SSEChunk {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

interface NonStreamingResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: POST /v1/chat/completions", () => {
  it("streaming: returns SSE with correct content-type and content", async () => {
    const res = await chatRequest(defaultBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    // Consume the body to verify content
    const text = await res.text();
    const events = parseSSE(text);
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Should have at least one chunk with content delta
    const chunks = events.filter((e): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && "object" in e,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Should end with [DONE]
    expect(events[events.length - 1]).toBe("[DONE]");

    // Verify chunk structure
    const firstChunk = chunks[0] as Record<string, unknown>;
    expect(firstChunk.object).toBe("chat.completion.chunk");
    const choices = firstChunk.choices as Array<{ delta?: { content?: string } }>;
    expect(Array.isArray(choices)).toBe(true);
  });

  it("non-streaming: returns JSON with OpenAI structure", async () => {
    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");

    const choices = body.choices as Array<{ message: { content: string } }>;
    expect(Array.isArray(choices)).toBe(true);
    expect(choices.length).toBeGreaterThanOrEqual(1);
    expect(choices[0].message.content).toContain("Hello!");
  });

  it("non-streaming: response has correct model name", async () => {
    const res = await chatRequest(defaultBody());
    const body = await res.json() as Record<string, unknown>;
    // "codex" alias resolves to "gpt-5.4"
    expect(body.model).toBe("gpt-5.4");
  });

  it("unauthenticated: returns 401", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_api_key");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  it("invalid JSON body: returns 400", async () => {
    const res = await ctx.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
  });

  it("missing messages field: returns 400", async () => {
    const res = await chatRequest({ model: "codex" });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("upstream 429: returns 429 with rate_limit_error", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(429);

    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("upstream 500: returns error after retries", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(500, JSON.stringify({ detail: "Internal error" })),
    );

    // Real withRetry runs here — retries 2x with backoff (total ~3s).
    // This intentionally exercises the real retry path end-to-end.
    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(500);

    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("server_error");

    // Verify transport was called 3 times (1 initial + 2 retries)
    expect(getMockTransport().post).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("model suffix: codex-fast resolves correctly", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_fast", "Fast response!")),
    );

    const res = await chatRequest(defaultBody({ model: "codex-fast" }));
    expect(res.status).toBe(200);

    // Verify the request body sent to transport
    const sentBody = JSON.parse(getLastTransportBody()!) as Record<string, unknown>;
    expect(sentBody.model).toBe("gpt-5.4");
    // service_tier must NOT be in request body — Codex backend rejects it
    expect(sentBody.service_tier).toBeUndefined();

    // The response model should reflect the suffix
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.4-fast");
  });

  // ── Tool call tests ──────────────────────────────────────────────

  it("tool calls (streaming): returns SSE chunks with tool_calls delta", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_tool_s", "call_abc", "get_weather", '{"city":"London"}'),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    const events = parseSSE(text);
    const chunks = events.filter((e): e is SSEChunk =>
      typeof e === "object" && e !== null && "object" in e,
    ) as SSEChunk[];

    // Find chunks with tool_calls in delta
    const toolCallChunks = chunks.filter(
      (c) => c.choices[0]?.delta?.tool_calls && c.choices[0].delta.tool_calls.length > 0,
    );
    expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);

    // First tool call chunk should have the function name
    const firstToolChunk = toolCallChunks[0];
    const firstToolCall = firstToolChunk.choices[0].delta.tool_calls![0];
    expect(firstToolCall.function?.name).toBe("get_weather");
    expect(firstToolCall.id).toBe("call_abc");
    expect(firstToolCall.type).toBe("function");

    // Final chunk should have finish_reason "tool_calls"
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");

    // Should end with [DONE]
    expect(events[events.length - 1]).toBe("[DONE]");
  });

  it("tool calls (non-streaming): returns JSON with tool_calls array", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_tool_ns", "call_xyz", "get_weather", '{"city":"Paris"}'),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: false,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as NonStreamingResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls!.length).toBe(1);

    const toolCall = body.choices[0].message.tool_calls![0];
    expect(toolCall.id).toBe("call_xyz");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function.name).toBe("get_weather");
    expect(toolCall.function.arguments).toBe('{"city":"Paris"}');
  });

  it("legacy function_call: translates functions to tools", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildToolCallStreamChunks("resp_legacy", "call_fn1", "get_weather", '{"city":"Tokyo"}'),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: false,
      functions: [{ name: "get_weather", parameters: {} }],
      function_call: "auto",
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as NonStreamingResponse;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls!.length).toBe(1);

    const toolCall = body.choices[0].message.tool_calls![0];
    expect(toolCall.function.name).toBe("get_weather");
    expect(toolCall.function.arguments).toBe('{"city":"Tokyo"}');

    // Verify that the transport request body has tools (translated from functions)
    const sentBody = JSON.parse(getLastTransportBody()!) as Record<string, unknown>;
    const sentTools = sentBody.tools as Array<Record<string, unknown>>;
    expect(sentTools).toBeDefined();
    expect(sentTools.length).toBe(1);
  });

  it("image input: forwards image content to codex request", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_img", "It is a cat.")),
    );

    const res = await chatRequest(defaultBody({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    }));
    expect(res.status).toBe(200);

    // Verify the transport received the image in the codex request body
    const sentBody = JSON.parse(getLastTransportBody()!) as Record<string, unknown>;
    const input = sentBody.input as Array<Record<string, unknown>>;
    expect(input).toBeDefined();
    expect(input.length).toBeGreaterThanOrEqual(1);

    // The user message should have structured content with image
    const userMsg = input.find(
      (item) => item.role === "user",
    );
    expect(userMsg).toBeDefined();
    const content = userMsg!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);

    const imagePart = content.find((p) => p.type === "input_image");
    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url).toBe("data:image/png;base64,abc");

    const textPart = content.find((p) => p.type === "input_text");
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("What is this?");
  });

  // ── Reasoning tests ──────────────────────────────────────────────

  it("reasoning (streaming): returns SSE chunks with reasoning_content", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildReasoningStreamChunks("resp_reason_s", "Let me think step by step...", "The answer is 42."),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: true,
      reasoning_effort: "high",
    }));
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSE(text);
    const chunks = events.filter((e): e is SSEChunk =>
      typeof e === "object" && e !== null && "object" in e,
    ) as SSEChunk[];

    // Find chunks with reasoning_content delta
    const reasoningChunks = chunks.filter(
      (c) => c.choices[0]?.delta?.reasoning_content != null,
    );
    expect(reasoningChunks.length).toBeGreaterThanOrEqual(1);
    expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe(
      "Let me think step by step...",
    );

    // Find chunks with text content delta
    const contentChunks = chunks.filter(
      (c) => c.choices[0]?.delta?.content != null && c.choices[0].delta.content !== "",
    );
    expect(contentChunks.length).toBeGreaterThanOrEqual(1);

    // Should end with [DONE]
    expect(events[events.length - 1]).toBe("[DONE]");
  });

  it("reasoning (non-streaming): returns JSON with reasoning_content", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildReasoningStreamChunks("resp_reason_ns", "Thinking carefully...", "Result is 7."),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: false,
      reasoning_effort: "high",
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as NonStreamingResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Result is 7.");
    expect(body.choices[0].message.reasoning_content).toBe("Thinking carefully...");
  });

  // ── Usage details tests ──────────────────────────────────────────

  it("usage details: cached_tokens and reasoning_tokens are forwarded", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildDetailedUsageStreamChunks("resp_usage", "Answer", {
          input_tokens: 100,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 50 },
          output_tokens_details: { reasoning_tokens: 30 },
        }),
      ),
    );

    const res = await chatRequest(defaultBody());
    expect(res.status).toBe(200);

    const body = await res.json() as NonStreamingResponse;
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.usage.completion_tokens).toBe(50);
    expect(body.usage.total_tokens).toBe(150);
    expect(body.usage.prompt_tokens_details?.cached_tokens).toBe(50);
    expect(body.usage.completion_tokens_details?.reasoning_tokens).toBe(30);
  });

  // ── Model suffix tests ───────────────────────────────────────────

  it("model suffix: codex-high resolves reasoning effort", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_high", "High reasoning response")),
    );

    const res = await chatRequest(defaultBody({ model: "codex-high" }));
    expect(res.status).toBe(200);

    // Verify the transport body has the resolved model ID
    const sentBody = JSON.parse(getLastTransportBody()!) as Record<string, unknown>;
    expect(sentBody.model).toBe("gpt-5.4");

    // Verify reasoning effort is set in the request
    const reasoning = sentBody.reasoning as Record<string, unknown> | undefined;
    expect(reasoning?.effort).toBe("high");

    // The response model should include the suffix
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.4-high");
  });

  it("model suffix: codex-high-fast (dual suffix) resolves both", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_dual", "Dual suffix response")),
    );

    const res = await chatRequest(defaultBody({ model: "codex-high-fast" }));
    expect(res.status).toBe(200);

    // Verify the transport body has the base model (no suffix)
    const sentBody = JSON.parse(getLastTransportBody()!) as Record<string, unknown>;
    expect(sentBody.model).toBe("gpt-5.4");

    // Verify reasoning effort and service tier
    const reasoning = sentBody.reasoning as Record<string, unknown> | undefined;
    expect(reasoning?.effort).toBe("high");
    // service_tier for "fast" is set but may not appear in the codex request body
    // (it's passed as service_tier field)

    // The response model should have the full suffix
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.4-high-fast");
  });

  // ── Error format tests ───────────────────────────────────────────

  it("error 400: missing model field returns invalid_request", async () => {
    const res = await chatRequest({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string; type: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("error 401: no accounts returns invalid_api_key", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { error: { code: string; type: string } };
      expect(body.error.code).toBe("invalid_api_key");
      expect(body.error.type).toBe("invalid_request_error");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  // ── Multiple tool calls ──────────────────────────────────────────

  it("multiple tool calls: non-streaming returns 2 tool_calls entries", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildMultiToolCallStreamChunks("resp_multi", [
          { callId: "call_1", name: "get_weather", args: '{"city":"NYC"}' },
          { callId: "call_2", name: "get_time", args: '{"timezone":"EST"}' },
        ]),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: false,
      tools: [
        { type: "function", function: { name: "get_weather", parameters: {} } },
        { type: "function", function: { name: "get_time", parameters: {} } },
      ],
    }));
    expect(res.status).toBe(200);

    const body = await res.json() as NonStreamingResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls!.length).toBe(2);

    const [tc1, tc2] = body.choices[0].message.tool_calls!;
    expect(tc1.id).toBe("call_1");
    expect(tc1.function.name).toBe("get_weather");
    expect(tc1.function.arguments).toBe('{"city":"NYC"}');
    expect(tc2.id).toBe("call_2");
    expect(tc2.function.name).toBe("get_time");
    expect(tc2.function.arguments).toBe('{"timezone":"EST"}');
  });

  it("multiple tool calls (streaming): returns SSE chunks for each tool call", async () => {
    setTransportPost(async () =>
      makeTransportResponse(
        buildMultiToolCallStreamChunks("resp_multi_s", [
          { callId: "call_a", name: "search", args: '{"q":"hello"}' },
          { callId: "call_b", name: "calculate", args: '{"expr":"1+1"}' },
        ]),
      ),
    );

    const res = await chatRequest(defaultBody({
      stream: true,
      tools: [
        { type: "function", function: { name: "search", parameters: {} } },
        { type: "function", function: { name: "calculate", parameters: {} } },
      ],
    }));
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = parseSSE(text);
    const chunks = events.filter((e): e is SSEChunk =>
      typeof e === "object" && e !== null && "object" in e,
    ) as SSEChunk[];

    // Find chunks with tool_calls delta
    const toolCallChunks = chunks.filter(
      (c) => c.choices[0]?.delta?.tool_calls && c.choices[0].delta.tool_calls.length > 0,
    );

    // Should have chunks for both tool calls (at least 2: one start per call + args)
    expect(toolCallChunks.length).toBeGreaterThanOrEqual(2);

    // Verify we see both function names across the chunks
    const functionNames = toolCallChunks
      .map((c) => c.choices[0].delta.tool_calls![0].function?.name)
      .filter((n): n is string => n != null);
    expect(functionNames).toContain("search");
    expect(functionNames).toContain("calculate");

    // Final chunk should have finish_reason "tool_calls"
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");

    // Should end with [DONE]
    expect(events[events.length - 1]).toBe("[DONE]");
  });
});
