import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

let mockCreateResponse: (() => Promise<Response>) | null = null;

vi.mock("@src/proxy/codex-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/proxy/codex-api.js")>();

  const CodexApi = vi.fn().mockImplementation(() => ({
    createResponse: vi.fn((): Promise<Response> => {
      if (mockCreateResponse) return mockCreateResponse();
      return Promise.resolve(new Response("data: {}\n\n"));
    }),
  }));

  return { ...actual, CodexApi };
});

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({ auth: { request_interval_ms: 0 } })),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitterInt: vi.fn((val: number) => val),
}));

vi.mock("@src/utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";
import { EmptyResponseError } from "@src/translation/codex-event-extractor.js";

function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok1", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@test.com" })),
    recordEmptyResponse: vi.fn(),
    hasAvailableAccounts: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({
      total: 1,
      active: 0,
      expired: 0,
      quota_exhausted: 0,
      rate_limited: 0,
      refreshing: 0,
      disabled: 0,
      banned: 0,
    })),
    ...overrides,
  };
}

function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "Hello" }],
      stream: false,
      store: false,
    },
    model: "codex",
    isStreaming: false,
  };
}

describe("handleProxyRequest empty-response fallback", () => {
  beforeEach(() => {
    mockCreateResponse = null;
    vi.clearAllMocks();
  });

  it("releases the second slot after same-entry empty-response fallback succeeds", async () => {
    const emptyUsage = { input_tokens: 1, output_tokens: 0 };
    const successUsage = { input_tokens: 10, output_tokens: 20 };
    const accountPool = createMockAccountPool({
      acquire: vi.fn((opts?: { excludeIds?: string[] }) => {
        if (opts?.excludeIds?.includes("e1")) return null;
        return { entryId: "e1", token: "tok1", accountId: "acc1" };
      }),
    });
    let collectCallCount = 0;
    const fmt = createMockFormatAdapter({
      collectTranslator: vi.fn(async () => {
        collectCallCount++;
        if (collectCallCount === 1) {
          throw new EmptyResponseError("resp_empty", emptyUsage);
        }
        return {
          response: { id: "resp_ok", choices: [] },
          usage: successUsage,
          responseId: "resp_ok",
        };
      }),
    });
    const app = new Hono();
    app.post("/test", (c) =>
      handleProxyRequest(c, accountPool as never, undefined, createDefaultRequest(), fmt),
    );

    const res = await app.request("/test", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "resp_ok", choices: [] });
    expect(accountPool.recordEmptyResponse).toHaveBeenCalledWith("e1");
    expect(accountPool.release).toHaveBeenNthCalledWith(1, "e1", emptyUsage);
    expect(accountPool.release).toHaveBeenNthCalledWith(2, "e1", successUsage);
    expect(accountPool.release).toHaveBeenCalledTimes(2);
  });
});
