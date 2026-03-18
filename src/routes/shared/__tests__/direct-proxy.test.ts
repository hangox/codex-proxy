/**
 * Tests for the direct proxy handler (relay accounts with non-codex formats).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { handleDirectProxy } from "../direct-proxy.js";
import type { AcquiredAccount } from "../../../auth/types.js";

const mockPost = vi.fn();
const mockSimplePost = vi.fn();

vi.mock("../../../tls/transport.js", () => ({
  getTransport: () => ({
    post: mockPost,
    simplePost: mockSimplePost,
    isImpersonate: () => false,
  }),
}));

// Minimal AccountPool mock
function createMockPool() {
  return {
    release: vi.fn(),
    releaseWithoutCounting: vi.fn(),
    markRateLimited: vi.fn(),
  };
}

function makeAcquired(overrides?: Partial<AcquiredAccount>): AcquiredAccount {
  return {
    entryId: "relay-1",
    token: "sk-relay-key",
    accountId: null,
    type: "relay",
    baseUrl: "https://api.example.com/v1",
    format: "openai",
    ...overrides,
  };
}

describe("handleDirectProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streaming: pipes SSE response from relay to client", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"id\":\"1\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    mockPost.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
      setCookieHeaders: [],
    });

    const pool = createMockPool();
    const app = new Hono();
    app.post("/test", async (c) => {
      return handleDirectProxy({
        c,
        accountPool: pool as never,
        acquired: makeAcquired(),
        rawBody: '{"model":"gpt-4","messages":[]}',
        upstreamPath: "/chat/completions",
        isStreaming: true,
      });
    });

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, headers] = mockPost.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(headers["Authorization"]).toBe("Bearer sk-relay-key");
    expect(headers["Content-Type"]).toBe("application/json");
    // No fingerprint headers
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
    expect(headers["originator"]).toBeUndefined();
  });

  it("non-streaming: returns full response body", async () => {
    mockSimplePost.mockResolvedValue({
      status: 200,
      body: '{"id":"chatcmpl-1","choices":[]}',
    });

    const pool = createMockPool();
    const app = new Hono();
    app.post("/test", async (c) => {
      return handleDirectProxy({
        c,
        accountPool: pool as never,
        acquired: makeAcquired(),
        rawBody: '{"model":"gpt-4","messages":[],"stream":false}',
        upstreamPath: "/chat/completions",
        isStreaming: false,
      });
    });

    const res = await app.request("/test", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(200);
    const data = await res.text();
    expect(data).toContain("chatcmpl-1");
    expect(mockSimplePost).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledWith("relay-1");
  });

  it("429: marks account rate limited", async () => {
    mockSimplePost.mockResolvedValue({
      status: 429,
      body: '{"error":"rate limited"}',
    });

    const pool = createMockPool();
    const app = new Hono();
    app.post("/test", async (c) => {
      return handleDirectProxy({
        c,
        accountPool: pool as never,
        acquired: makeAcquired(),
        rawBody: "{}",
        upstreamPath: "/chat/completions",
        isStreaming: false,
      });
    });

    const res = await app.request("/test", { method: "POST", body: "{}" });

    expect(res.status).toBe(429);
    expect(pool.markRateLimited).toHaveBeenCalledWith("relay-1", { countRequest: true });
  });

  it("error: releases account and returns 502", async () => {
    mockSimplePost.mockRejectedValue(new Error("Connection refused"));

    const pool = createMockPool();
    const app = new Hono();
    app.post("/test", async (c) => {
      return handleDirectProxy({
        c,
        accountPool: pool as never,
        acquired: makeAcquired(),
        rawBody: "{}",
        upstreamPath: "/chat/completions",
        isStreaming: false,
      });
    });

    const res = await app.request("/test", { method: "POST", body: "{}" });

    expect(res.status).toBe(502);
    expect(pool.release).toHaveBeenCalledWith("relay-1");
  });

  it("no baseUrl: returns 500", async () => {
    const pool = createMockPool();
    const app = new Hono();
    app.post("/test", async (c) => {
      return handleDirectProxy({
        c,
        accountPool: pool as never,
        acquired: makeAcquired({ baseUrl: null }),
        rawBody: "{}",
        upstreamPath: "/chat/completions",
        isStreaming: false,
      });
    });

    const res = await app.request("/test", { method: "POST", body: "{}" });

    expect(res.status).toBe(500);
    expect(pool.releaseWithoutCounting).toHaveBeenCalled();
  });
});
