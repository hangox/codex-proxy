/**
 * Integration tests for proxy-handler.
 *
 * Uses a real Hono app to exercise handleProxyRequest end-to-end,
 * avoiding the need to manually mock Hono Context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

// ── Module-level control for CodexApi.createResponse / stream preflight ─────

let mockCreateResponse: ((...args: unknown[]) => Promise<Response>) | null = null;
let mockIterateCodexEvents: (() => AsyncGenerator<unknown>) | null = null;
let mockPreflightContentfulStream: ((source: AsyncIterable<unknown>) => Promise<{ buffered: unknown[]; stream: AsyncIterable<unknown> }>) | null = null;

const wsPoolMocks = vi.hoisted(() => ({
  evictByPoolKey: vi.fn(),
  getWsPool: vi.fn(),
}));

const sessionAffinityMocks = vi.hoisted(() => ({
  getSessionAffinityMap: vi.fn(),
}));

vi.mock("@src/proxy/codex-api.js", () => {
  class CodexApiError extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      let detail: string;
      try {
        const parsed = JSON.parse(body);
        detail = parsed.detail ?? parsed.error?.message ?? body;
      } catch {
        detail = body;
      }
      super(`Codex API error (${status}): ${detail}`);
      this.status = status;
      this.body = body;
    }
  }

  class PreviousResponseWebSocketError extends CodexApiError {
    causeMessage: string;
    phase: "pre-connect" | "mid-stream" | "unknown";
    recoverable: boolean;

    constructor(
      causeMessage: string,
      opts: { phase?: "pre-connect" | "mid-stream" | "unknown"; recoverable?: boolean } = {},
    ) {
      super(
        0,
        JSON.stringify({
          error: {
            message:
              "WebSocket failed while using previous_response_id; HTTP SSE fallback would drop server-side history: " +
              causeMessage,
          },
        }),
      );
      this.name = "PreviousResponseWebSocketError";
      this.causeMessage = causeMessage;
      this.phase = opts.phase ?? "unknown";
      this.recoverable = opts.recoverable ?? false;
    }
  }

  const CodexApi = vi.fn().mockImplementation(() => ({
    createResponse: vi.fn((...args: unknown[]): Promise<Response> => {
      if (mockCreateResponse) return mockCreateResponse(...args);
      return Promise.resolve(new Response("data: {}\n\n"));
    }),
  }));

  return { CodexApi, CodexApiError, PreviousResponseWebSocketError };
});

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ auth: { request_interval_ms: 0 } })),
}));

vi.mock("@src/auth/session-affinity.js", () => ({
  getSessionAffinityMap: sessionAffinityMocks.getSessionAffinityMap,
}));

vi.mock("@src/proxy/ws-pool.js", () => ({
  getWsPool: wsPoolMocks.getWsPool,
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitterInt: vi.fn((val: number) => val),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@src/translation/codex-event-extractor.js", () => {
  class EmptyResponseError extends Error {
    usage: { input_tokens: number; output_tokens: number } | undefined;
    responseId: string | null;
    constructor(
      responseId: string | null = null,
      usage?: { input_tokens: number; output_tokens: number },
    ) {
      super("Codex returned an empty response");
      this.name = "EmptyResponseError";
      this.responseId = responseId;
      this.usage = usage;
    }
  }

  async function* iterateCodexEvents() {
    if (mockIterateCodexEvents) {
      yield* mockIterateCodexEvents();
      return;
    }
    yield { typed: { type: "response.output_text.delta", delta: "hi" }, textDelta: "hi" };
    yield {
      typed: { type: "response.completed", response: { id: "resp_stream", usage: { input_tokens: 10, output_tokens: 20 } } },
      responseId: "resp_stream",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
  }

  async function preflightContentfulStream(source: AsyncIterable<unknown>) {
    if (mockPreflightContentfulStream) return mockPreflightContentfulStream(source);
    return { buffered: [], stream: source };
  }

  return { EmptyResponseError, iterateCodexEvents, preflightContentfulStream };
});

// Import after mocks are set up
import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { CodexApiError, PreviousResponseWebSocketError } from "@src/proxy/codex-api.js";
import { EmptyResponseError, preflightContentfulStream } from "@src/translation/codex-event-extractor.js";

// ── Helpers ───────────────────────────────────────────────────────────

function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@test.com" })),
    recordEmptyResponse: vi.fn(),
    hasAvailableAccounts: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({
      total: 1, active: 0, expired: 0, quota_exhausted: 0,
      rate_limited: 0, refreshing: 0, disabled: 0, banned: 0,
    })),
    ...overrides,
  };
}

function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user" as const, content: "Hello" }],
      stream: true as const,
      store: false as const,
    },
    model: "codex",
    isStreaming: false,
  };
}

function createStreamingRequest(): ProxyRequest {
  return { ...createDefaultRequest(), isStreaming: true };
}

/**
 * Build a Hono app that forwards POST /test to handleProxyRequest.
 * Returns the app and the mocks for assertion.
 */
function buildTestApp(opts: {
  accountPool?: ReturnType<typeof createMockAccountPool>;
  fmt?: ReturnType<typeof createMockFormatAdapter>;
  req?: ProxyRequest;
  cookieJar?: unknown;
}) {
  const accountPool = opts.accountPool ?? createMockAccountPool();
  const fmt = opts.fmt ?? createMockFormatAdapter();
  const proxyReq = opts.req ?? createDefaultRequest();
  const cookieJar = opts.cookieJar ?? undefined;

  const app = new Hono();
  app.post("/test", (c) =>
    handleProxyRequest(
      c,
      accountPool as never,
      cookieJar,
      proxyReq,
      fmt,
    ),
  );

  return { app, accountPool, fmt, proxyReq };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("proxy-handler integration", () => {
  beforeEach(() => {
    mockCreateResponse = null;
    mockIterateCodexEvents = null;
    mockPreflightContentfulStream = null;
    wsPoolMocks.evictByPoolKey.mockReset();
    wsPoolMocks.evictByPoolKey.mockReturnValue(false);
    wsPoolMocks.getWsPool.mockReset();
    wsPoolMocks.getWsPool.mockReturnValue({
      evictByPoolKey: wsPoolMocks.evictByPoolKey,
    });
    sessionAffinityMocks.getSessionAffinityMap.mockReset();
    sessionAffinityMocks.getSessionAffinityMap.mockReturnValue({
      lookup: vi.fn(() => null),
      lookupConversationId: vi.fn(() => null),
      lookupLatestResponseIdByConversationId: vi.fn(() => null),
      lookupTurnState: vi.fn(() => null),
      lookupInstructions: vi.fn(() => null),
      lookupInputTokens: vi.fn(() => null),
      lookupFunctionCallIds: vi.fn(() => []),
      forget: vi.fn(),
      record: vi.fn(),
    });
    vi.clearAllMocks();
  });

  // 1. No account available
  it("returns noAccountStatus (503) when no account is available", async () => {
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body).toEqual({ error: "no_account" });
    expect(fmt.formatNoAccount).toHaveBeenCalled();
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 2. Non-streaming success
  it("returns JSON result from collectTranslator for non-streaming", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ id: "resp_1", choices: [] });
    expect(fmt.collectTranslator).toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 3. Streaming success
  it("returns text/event-stream with SSE chunks for streaming", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: {}\n\n");
    expect(text).toContain("data: [DONE]\n\n");
    expect(fmt.streamTranslator).toHaveBeenCalled();
  });

  // 4. CodexApiError 429 → markRateLimited with parsed retryAfterSec + fallback to next account
  it("handles 429 by parsing resets_in_seconds and falling back to next account", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", message: "Limit reached", resets_in_seconds: 471284 },
    });
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(429, body429));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", {
      retryAfterSec: 471284,
      countRequest: true,
    });
    // Second account succeeds — release called with usage
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 4b. 429 with no resets_in_seconds → retryAfterSec undefined
  it("handles 429 with plain body (no resets_in_seconds) using default backoff", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, "Rate limited"));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", {
      retryAfterSec: undefined,
      countRequest: true,
    });
  });

  // 4c. 429 with resets_at fallback (no resets_in_seconds)
  it("handles 429 with resets_at fallback when resets_in_seconds is absent", async () => {
    const futureResetAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", resets_at: futureResetAt },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    const call = accountPool.markRateLimited.mock.calls[0] as [string, { retryAfterSec: number; countRequest: boolean }];
    expect(call[0]).toBe("e1");
    // Should be approximately 3600 (±5s tolerance for test execution time)
    expect(call[1].retryAfterSec).toBeGreaterThan(3590);
    expect(call[1].retryAfterSec).toBeLessThanOrEqual(3600);
    expect(call[1].countRequest).toBe(true);
  });

  // 4d. 429 exhausts all accounts → returns 429 to client
  it("returns 429 when all accounts are rate limited", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", resets_in_seconds: 100 },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce({ entryId: "e2", token: "tok2", accountId: "acc2" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    // Both accounts marked rate limited
    expect(accountPool.markRateLimited).toHaveBeenCalledTimes(2);
    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e1", { retryAfterSec: 100, countRequest: true });
    expect(accountPool.markRateLimited).toHaveBeenCalledWith("e2", { retryAfterSec: 100, countRequest: true });
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 5. CodexApiError 4xx → formatError with status code
  it("handles 4xx CodexApiError with formatError", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(400, "Bad Request"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.status).toBe(400);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 5b. CodexApiError 403 (non-CF) → marks banned, tries fallback
  it("handles 403 ban by marking banned and trying next account", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '{"detail": "Account suspended"}'));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "banned");
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 5c. CF 403 (Cloudflare challenge) → NOT treated as ban
  it("handles CF 403 as regular error, not ban", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '<!DOCTYPE html><html>cf_chl_managed</html>'));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    expect(accountPool.markStatus).not.toHaveBeenCalled();
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 6. CodexApiError 5xx → formatError with 502
  it("handles 5xx CodexApiError with 502 status", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(500, "Internal Server Error"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 7. Non-CodexApiError → re-thrown (500)
  it("re-throws non-CodexApiError causing a 500", async () => {
    mockCreateResponse = () =>
      Promise.reject(new TypeError("unexpected failure"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    // Hono returns 500 for unhandled exceptions
    expect(res.status).toBe(500);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  it("retries streaming request when preflight detects empty response", async () => {
    let preflightCallCount = 0;
    mockPreflightContentfulStream = async (source: AsyncIterable<unknown>) => {
      preflightCallCount++;
      if (preflightCallCount <= 2) {
        throw new EmptyResponseError(`resp_stream_empty_${preflightCallCount}`, {
          input_tokens: preflightCallCount,
          output_tokens: 0,
        });
      }
      return { buffered: [], stream: source };
    };

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok1", accountId: "acc1" })
        .mockReturnValueOnce({ entryId: "e2", token: "tok2", accountId: "acc2" })
        .mockReturnValueOnce({ entryId: "e3", token: "tok3", accountId: "acc3" }),
    });
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(preflightCallCount).toBe(3);
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledTimes(2);
    expect(accountPool.recordEmptyResponse).toHaveBeenNthCalledWith(1, "e1");
    expect(accountPool.recordEmptyResponse).toHaveBeenNthCalledWith(2, "e2");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 2,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenCalledTimes(2);
    const text = await res.text();
    expect(text).not.toContain("Codex returned an empty response");
  });

  it("streaming empty-response retry calls createResponse exactly once per attempt and excludes tried accounts", async () => {
    // 防回归: streaming 空响应重试不能在外层 for 多打一次 createResponse,
    // 也不能选回已经试过的账号。
    let createResponseCallCount = 0;
    mockCreateResponse = async () => {
      createResponseCallCount++;
      return new Response("data: {}\n\n");
    };

    let preflightCallCount = 0;
    mockPreflightContentfulStream = async (source: AsyncIterable<unknown>) => {
      preflightCallCount++;
      if (preflightCallCount <= 2) {
        throw new EmptyResponseError(`resp_stream_empty_${preflightCallCount}`, {
          input_tokens: preflightCallCount,
          output_tokens: 0,
        });
      }
      return { buffered: [], stream: source };
    };

    const acquireCalls: Array<{ excludeIds?: string[] }> = [];
    const acquire = vi.fn((opts?: { excludeIds?: string[] }) => {
      // snapshot the array — caller mutates it across attempts.
      acquireCalls.push({ excludeIds: opts?.excludeIds ? [...opts.excludeIds] : undefined });
      const idx = acquireCalls.length;
      return { entryId: `e${idx}`, token: `tok${idx}`, accountId: `acc${idx}` };
    });
    const accountPool = createMockAccountPool({ acquire });
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    // 3 次尝试 → 恰好 3 次 createResponse（首次 + 2 次重试），不能多。
    expect(createResponseCallCount).toBe(3);
    expect(preflightCallCount).toBe(3);

    // 第二次 acquire 排除 e1；第三次排除 e1 + e2。
    expect(acquireCalls.length).toBe(3);
    expect(acquireCalls[0].excludeIds ?? []).toEqual([]);
    expect(acquireCalls[1].excludeIds).toEqual(["e1"]);
    expect(acquireCalls[2].excludeIds).toEqual(["e1", "e2"]);
  });

  it("streaming empty-response retries are bounded by MAX_EMPTY_RETRIES", async () => {
    // 防回归: streaming 路径必须有 retry 上限，不能无限循环。
    let createResponseCallCount = 0;
    mockCreateResponse = async () => {
      createResponseCallCount++;
      return new Response("data: {}\n\n");
    };

    mockPreflightContentfulStream = async () => {
      throw new EmptyResponseError("resp_always_empty", {
        input_tokens: 0,
        output_tokens: 0,
      });
    };

    const accountPool = createMockAccountPool({
      acquire: vi.fn((opts?: { excludeIds?: string[] }) => {
        const idx = (opts?.excludeIds?.length ?? 0) + 1;
        return { entryId: `e${idx}`, token: `tok${idx}`, accountId: `acc${idx}` };
      }),
    });
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);
    // MAX_EMPTY_RETRIES = 2 → 上限 3 次 createResponse，绝不能更多。
    expect(createResponseCallCount).toBe(3);
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledTimes(3);
  });

  it("streaming single-account empty-response falls back to same-account retry", async () => {
    let createResponseCallCount = 0;
    mockCreateResponse = async () => {
      createResponseCallCount++;
      return new Response("data: {}\n\n");
    };

    let preflightCallCount = 0;
    mockPreflightContentfulStream = async () => {
      preflightCallCount++;
      throw new EmptyResponseError(`resp_single_${preflightCallCount}`, {
        input_tokens: preflightCallCount,
        output_tokens: 0,
      });
    };

    const acquireCalls: Array<{ excludeIds?: string[] }> = [];
    const accountPool = createMockAccountPool({
      acquire: vi.fn((opts?: { excludeIds?: string[] }) => {
        const snapshot = opts?.excludeIds ? [...opts.excludeIds] : undefined;
        acquireCalls.push({ excludeIds: snapshot });
        if (snapshot?.includes("e1")) return null;
        return { entryId: "e1", token: "tok1", accountId: "acc1" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const req = createStreamingRequest();
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);
    expect(preflightCallCount).toBe(3);
    expect(createResponseCallCount).toBe(3);
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledTimes(3);
    expect(accountPool.recordEmptyResponse).toHaveBeenNthCalledWith(1, "e1");
    expect(accountPool.recordEmptyResponse).toHaveBeenNthCalledWith(2, "e1");
    expect(accountPool.recordEmptyResponse).toHaveBeenNthCalledWith(3, "e1");
    expect(accountPool.release).toHaveBeenCalledTimes(3);
    expect(accountPool.release).toHaveBeenNthCalledWith(1, "e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenNthCalledWith(2, "e1", {
      input_tokens: 2,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenNthCalledWith(3, "e1", {
      input_tokens: 3,
      output_tokens: 0,
    });

    // 实际调用序列：初始 acquire 1 次；每次 retry 先 exclude(e1) 再 fallback(undefined)。
    expect(acquireCalls.map((c) => c.excludeIds ?? [])).toEqual([
      [],
      ["e1"],
      [],
      ["e1", "e1"],
      [],
    ]);
  });

  it("streaming single-account empty-response evicts the pooled WebSocket before retry", async () => {
    wsPoolMocks.evictByPoolKey.mockReturnValue(true);

    const createResponseCalls: unknown[][] = [];
    mockCreateResponse = async (...args: unknown[]) => {
      createResponseCalls.push([{ ...(args[0] as Record<string, unknown>) }, ...args.slice(1)]);
      return new Response("data: {}\n\n");
    };

    let preflightCallCount = 0;
    mockPreflightContentfulStream = async (source: AsyncIterable<unknown>) => {
      preflightCallCount++;
      if (preflightCallCount === 1) {
        throw new EmptyResponseError("resp_ws_empty", {
          input_tokens: 1,
          output_tokens: 0,
        });
      }
      return { buffered: [], stream: source };
    };

    const accountPool = createMockAccountPool({
      acquire: vi.fn((opts?: { excludeIds?: string[] }) => {
        if (opts?.excludeIds?.includes("e1")) return null;
        return { entryId: "e1", token: "tok1", accountId: "acc1" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createStreamingRequest(),
      clientConversationId: "conv-ws-empty",
      codexRequest: {
        ...createStreamingRequest().codexRequest,
        useWebSocket: true,
      },
    };
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(preflightCallCount).toBe(2);
    expect(createResponseCalls).toHaveLength(2);
    expect(wsPoolMocks.evictByPoolKey).toHaveBeenCalledTimes(1);
    expect(wsPoolMocks.evictByPoolKey).toHaveBeenCalledWith("e1:conv-ws-empty");

    const firstRequest = createResponseCalls[0][0] as { useWebSocket?: boolean };
    const retryRequest = createResponseCalls[1][0] as { useWebSocket?: boolean };
    const firstPoolCtx = createResponseCalls[0][3] as { entryId: string; poolKey: string };
    expect(firstPoolCtx).toMatchObject({ entryId: "e1", poolKey: "e1:conv-ws-empty" });
    expect(firstRequest.useWebSocket).toBe(true);
    expect(retryRequest.useWebSocket).toBe(false);
    expect(createResponseCalls[1][3]).toBeUndefined();
    expect(typeof createResponseCalls[1][2]).toBe("function");
  });

  // 8. Empty response retry (non-streaming) → account switch, second succeeds
  it("retries with a new account on EmptyResponseError", async () => {
    let callCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return { entryId: "e1", token: "tok1", accountId: "acc1" };
        }
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });

    const successResult = {
      response: { id: "resp_2", choices: [{ text: "hi" }] },
      usage: { input_tokens: 5, output_tokens: 15 },
      responseId: "resp_2",
    };

    let collectCallCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCallCount++;
        if (collectCallCount === 1) {
          throw new EmptyResponseError(
            "resp_empty",
            { input_tokens: 1, output_tokens: 0 },
          );
        }
        return successResult;
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual(successResult.response);

    // First account released with EmptyResponseError usage, second with success usage
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 5,
      output_tokens: 15,
    });
  });

  // 9. Empty response retries exhausted → 502
  it("returns 502 when all empty response retries are exhausted", async () => {
    const emptyUsage = { input_tokens: 0, output_tokens: 0 };
    let acquireCount = 0;

    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        return {
          entryId: `e${acquireCount}`,
          token: `tok${acquireCount}`,
          accountId: `acc${acquireCount}`,
        };
      }),
    });

    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new EmptyResponseError("resp_e", emptyUsage);
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.message).toContain("empty responses");

    // MAX_EMPTY_RETRIES = 2, so 3 total attempts → 3 acquires (1 initial + 2 retries)
    // recordEmptyResponse called for each failed attempt
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledTimes(3);
  });

  // 10. No account for retry → 502 with specific message
  it("returns 502 when no account is available for empty-response retry", async () => {
    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) {
          return { entryId: "e1", token: "tok1", accountId: "acc1" };
        }
        return null; // No accounts for retry
      }),
    });

    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        throw new EmptyResponseError(
          "resp_e",
          { input_tokens: 1, output_tokens: 0 },
        );
      }),
    });

    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.message).toContain("no other accounts are available");
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 1,
      output_tokens: 0,
    });
  });

  // 11. Account released on success (non-streaming)
  it("releases the account with usage on non-streaming success", async () => {
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 12. Account released on error (CodexApiError path — non-401/403/429)
  it("releases the account on CodexApiError (non-retryable)", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(422, "Unprocessable Entity"));

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    await app.request("/test", { method: "POST" });

    expect(accountPool.release).toHaveBeenCalledTimes(1);
    expect(accountPool.release).toHaveBeenCalledWith("e1", undefined);
  });

  // 13. 401 token invalidation → marks expired, tries next account
  it("handles 401 by marking expired and trying next account", async () => {
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(401, '{"detail":"Your authentication token has been invalidated."}'));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    let acquireCount = 0;
    const accountPool = createMockAccountPool({
      acquire: vi.fn(() => {
        acquireCount++;
        if (acquireCount === 1) return { entryId: "e1", token: "tok1", accountId: "acc1" };
        return { entryId: "e2", token: "tok2", accountId: "acc2" };
      }),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "expired");
    expect(accountPool.release).toHaveBeenCalledWith("e2", {
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  // 14. 401 with no fallback account → returns 401
  it("returns 401 when token invalidated and no other account available", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(401, "Unauthorized"));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" })
        .mockReturnValueOnce(null),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(401);

    expect(accountPool.markStatus).toHaveBeenCalledWith("e1", "expired");
    expect(accountPool.release).not.toHaveBeenCalled();
  });

  // 15. 429 with no available accounts → descriptive "all accounts exhausted" error
  it("returns descriptive error when 429 and no accounts available for retry", async () => {
    const body429 = JSON.stringify({
      error: { type: "usage_limit_reached", message: "Limit reached" },
    });
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(429, body429));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" }),
      hasAvailableAccounts: vi.fn(() => false),
      getPoolSummary: vi.fn(() => ({
        total: 2, active: 0, expired: 0, quota_exhausted: 0,
        rate_limited: 2, refreshing: 0, disabled: 0, banned: 0,
      })),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(429);

    const body = await res.json();
    // format429 is used for 429 errors
    expect(fmt.format429).toHaveBeenCalled();
    const message = fmt.format429.mock.calls[0][0] as string;
    expect(message).toContain("All accounts exhausted");
    expect(message).toContain("2 rate-limited");
  });

  // 17. previous_response_not_found: should strip previous_response_id and retry
  // Reproduces the bug: when upstream returns previous_response_not_found
  // (because the response was created on a different account or is unknown to
  // this account), the proxy currently passes the error straight through with
  // no recovery. Desired behavior: strip previous_response_id and replay.
  it("recovers from previous_response_not_found by stripping ID and retrying", async () => {
    const notFoundBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68' not found.",
      },
    });

    let createCount = 0;
    const seenPrevIds: Array<string | undefined> = [];
    mockCreateResponse = () => {
      // The mock-CodexApi instance receives the *current* codexRequest by
      // reference. We capture the previous_response_id at the moment of call.
      createCount++;
      if (createCount === 1) return Promise.reject(new CodexApiError(400, notFoundBody));
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    // Wrap createResponse to capture the previous_response_id seen on each call.
    // (Re-mock CodexApi inline so we can observe the request mutation.)
    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68",
      },
    };

    // Spy: snapshot previous_response_id before the upstream is called.
    const origMock = mockCreateResponse;
    mockCreateResponse = () => {
      seenPrevIds.push(req.codexRequest.previous_response_id);
      return origMock!();
    };

    const { app } = buildTestApp({ accountPool, fmt, req });
    const res = await app.request("/test", { method: "POST" });

    // Desired: proxy retries after stripping previous_response_id, returns 200
    expect(res.status).toBe(200);
    // Desired: 2 upstream calls — first with the stale ID, second without it
    expect(createCount).toBe(2);
    expect(seenPrevIds[0]).toBe("resp_0e2e6e7917486cfd0069eec8532d988194a3da6379c70abe68");
    expect(seenPrevIds[1]).toBeUndefined();
  });

  it("recovers from recoverable pre-connect WS failure by stripping previous_response_id and disabling WS", async () => {
    const seenRequests: Array<{ previous_response_id: string | undefined; useWebSocket: boolean | undefined; turnState: string | undefined }> = [];
    let createCount = 0;
    mockCreateResponse = (codexRequest: unknown) => {
      const req = codexRequest as {
        previous_response_id?: string;
        useWebSocket?: boolean;
        turnState?: string;
      };
      seenRequests.push({
        previous_response_id: req.previous_response_id,
        useWebSocket: req.useWebSocket,
        turnState: req.turnState,
      });
      createCount++;
      if (createCount === 1) {
        return Promise.reject(new PreviousResponseWebSocketError("Aborted before WebSocket connect", {
          phase: "pre-connect",
          recoverable: true,
        }));
      }
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_prev",
        turnState: "turn_prev",
        useWebSocket: true,
      },
    };

    const { app } = buildTestApp({ accountPool, fmt, req });
    const res = await app.request("/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(createCount).toBe(2);
    expect(seenRequests).toEqual([
      {
        previous_response_id: "resp_prev",
        useWebSocket: true,
        turnState: "turn_prev",
      },
      {
        previous_response_id: undefined,
        useWebSocket: false,
        turnState: undefined,
      },
    ]);
  });

  it("recovers implicit resume by restoring full input after recoverable pre-connect WS failure", async () => {
    const seenRequests: Array<{
      previous_response_id: string | undefined;
      useWebSocket: boolean | undefined;
      turnState: string | undefined;
      input: unknown[];
    }> = [];
    let createCount = 0;
    mockCreateResponse = (codexRequest: unknown) => {
      const req = codexRequest as {
        previous_response_id?: string;
        useWebSocket?: boolean;
        turnState?: string;
        input: unknown[];
      };
      seenRequests.push({
        previous_response_id: req.previous_response_id,
        useWebSocket: req.useWebSocket,
        turnState: req.turnState,
        input: req.input,
      });
      createCount++;
      if (createCount === 1) {
        return Promise.reject(new PreviousResponseWebSocketError("Aborted before WebSocket connect", {
          phase: "pre-connect",
          recoverable: true,
        }));
      }
      return Promise.resolve(new Response("data: {}\n\n"));
    };

    sessionAffinityMocks.getSessionAffinityMap.mockReturnValue({
      lookup: vi.fn(() => "e1"),
      lookupConversationId: vi.fn(() => null),
      lookupLatestResponseIdByConversationId: vi.fn(() => "resp_implicit_prev"),
      lookupTurnState: vi.fn(() => "turn_implicit_prev"),
      lookupInstructions: vi.fn(() => "You are helpful"),
      lookupInputTokens: vi.fn(() => null),
      lookupFunctionCallIds: vi.fn(() => []),
      forget: vi.fn(),
      record: vi.fn(),
    });

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      clientConversationId: "conv_implicit_1",
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        input: [
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Continue" },
        ],
      },
    };

    const { app } = buildTestApp({ accountPool, fmt, req });
    const res = await app.request("/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(createCount).toBe(2);
    expect(seenRequests[0]).toEqual({
      previous_response_id: "resp_implicit_prev",
      useWebSocket: true,
      turnState: "turn_implicit_prev",
      input: [{ role: "user", content: "Continue" }],
    });
    expect(seenRequests[1]).toEqual({
      previous_response_id: undefined,
      useWebSocket: undefined,
      turnState: undefined,
      input: [
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Continue" },
      ],
    });
  });

  // 17b. previous_response_not_found loop guard — only retry once
  it("does not loop forever when previous_response_not_found persists after strip", async () => {
    const notFoundBody = JSON.stringify({
      error: { type: "invalid_request_error", code: "previous_response_not_found",
        message: "Previous response with id 'resp_xxx' not found." },
    });
    let createCount = 0;
    mockCreateResponse = () => {
      createCount++;
      return Promise.reject(new CodexApiError(400, notFoundBody));
    };

    const accountPool = createMockAccountPool();
    const fmt = createMockFormatAdapter();
    const req: ProxyRequest = {
      ...createDefaultRequest(),
      codexRequest: {
        ...createDefaultRequest().codexRequest,
        previous_response_id: "resp_xxx",
      },
    };
    const { app } = buildTestApp({ accountPool, fmt, req });

    const res = await app.request("/test", { method: "POST" });
    // After the strip+retry attempt also fails, fall through to generic error
    expect(res.status).toBe(400);
    // Exactly 2 upstream calls — strip-retry happens once, no further retries
    expect(createCount).toBe(2);
  });

  // 18. 403 ban with mixed pool states → descriptive error
  it("returns descriptive error when banned and remaining accounts disabled/expired", async () => {
    mockCreateResponse = () =>
      Promise.reject(new CodexApiError(403, '{"detail": "Account suspended"}'));

    const accountPool = createMockAccountPool({
      acquire: vi.fn()
        .mockReturnValueOnce({ entryId: "e1", token: "tok", accountId: "acc1" }),
      hasAvailableAccounts: vi.fn(() => false),
      getPoolSummary: vi.fn(() => ({
        total: 3, active: 0, expired: 1, quota_exhausted: 0,
        rate_limited: 0, refreshing: 0, disabled: 1, banned: 1,
      })),
    });
    const fmt = createMockFormatAdapter();
    const { app } = buildTestApp({ accountPool, fmt });

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("api_error");
    expect(body.message).toContain("All accounts exhausted");
    expect(body.message).toContain("1 expired");
    expect(body.message).toContain("1 disabled");
    expect(body.message).toContain("1 banned");
  });
});
