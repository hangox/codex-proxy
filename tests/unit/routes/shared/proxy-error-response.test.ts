import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  buildAccountExhaustionDetail,
  respondWithNoAccount,
  respondWithProxyError,
} from "@src/routes/shared/proxy-error-response.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquireFailureDiagnosis } from "@src/auth/account-lifecycle.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

function createMockPoolForDiagnosis(diagnosis: AcquireFailureDiagnosis): AccountPool {
  return {
    diagnoseAcquireFailure: vi.fn(() => diagnosis),
    getPoolSummary: vi.fn(() => ({
      total: 1, active: 0, expired: 0, quota_exhausted: 0,
      rate_limited: 0, refreshing: 0, disabled: 0, banned: 0,
    })),
  } as unknown as AccountPool;
}

function createRequest(isStreaming: boolean): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "hello" }],
      stream: isStreaming,
    },
    model: "codex",
    isStreaming,
  };
}

describe("proxy error response helpers", () => {
  it("builds account exhaustion detail from inactive pool counts", () => {
    expect(buildAccountExhaustionDetail({
      total: 6,
      active: 0,
      rate_limited: 2,
      expired: 1,
      banned: 1,
      disabled: 0,
      quota_exhausted: 1,
      refreshing: 1,
    }, "Rate limited")).toBe(
      "All accounts exhausted (2 rate-limited, 1 expired, 1 banned, 1 quota-exhausted, 1 refreshing). Rate limited",
    );
  });

  it("formats non-streaming proxy errors with the route-specific 429 formatter", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(false);

    app.get("/error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 429,
      message: "All accounts exhausted",
      useFormat429: true,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "All accounts exhausted",
    });
    expect(fmt.format429).toHaveBeenCalledWith("All accounts exhausted");
    expect(fmt.formatError).not.toHaveBeenCalled();
  });

  it("formats streaming proxy errors as SSE when the adapter supports stream errors", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(true);

    app.get("/stream-error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 503,
      message: "No accounts",
    }));

    const res = await app.request("/stream-error");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(text).toContain("event: response.failed");
    expect(text).toContain("No accounts");
    expect(fmt.formatStreamError).toHaveBeenCalledWith(503, "No accounts");
  });

  describe("respondWithNoAccount (★ #81)", () => {
    it("self-heal bucket (concurrency_saturated) → noAccountStatus + Retry-After, even for a streaming request", async () => {
      const app = new Hono();
      const fmt = createMockFormatAdapter();
      // ★ #81: streaming must NOT change this — respondWithNoAccount never
      // routes through streamErrorResponse, unlike respondWithProxyError
      // above. If this ever regresses back to branching on req.isStreaming,
      // the real HTTP status silently becomes 200 (see the doc comment on
      // respondWithNoAccount for why).
      const req = createRequest(true);
      const pool = createMockPoolForDiagnosis({
        reason: "concurrency_saturated",
        concurrencySaturatedCount: 1,
        quotaWindowCount: 0,
        needsHumanCount: 0,
        earliestQuotaResetAt: null,
      });

      app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt, pool }));
      const res = await app.request("/no-account");

      expect(res.status).toBe(503); // fmt.noAccountStatus, not 200
      expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(res.headers.get("x-should-retry")).toBeNull();
      const body = await res.json() as { error: string; status: number; message: string };
      expect(body.status).toBe(503);
      expect(body.message).toContain("concurrency limit");
      expect(fmt.formatError).toHaveBeenCalledWith(503, expect.any(String));
    });

    it("self-heal bucket (quota_window) → real Retry-After derived from earliestQuotaResetAt, not a guess", async () => {
      const app = new Hono();
      const fmt = createMockFormatAdapter();
      const req = createRequest(false);
      const resetInSeconds = 120;
      const pool = createMockPoolForDiagnosis({
        reason: "quota_window",
        concurrencySaturatedCount: 0,
        quotaWindowCount: 1,
        needsHumanCount: 0,
        earliestQuotaResetAt: Math.floor(Date.now() / 1000) + resetInSeconds,
      });

      app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt, pool }));
      const res = await app.request("/no-account");

      expect(res.status).toBe(503);
      const retryAfter = Number(res.headers.get("Retry-After"));
      // Allow a couple seconds of test execution slack either side of the
      // exact 120s — this is a real derived value, not a fixed heuristic,
      // so it must track the input closely, not just "be present".
      expect(retryAfter).toBeGreaterThan(resetInSeconds - 5);
      expect(retryAfter).toBeLessThanOrEqual(resetInSeconds);
    });

    it("needs_human bucket → needsHumanStatus, x-should-retry:false, no Retry-After, even for a streaming request", async () => {
      const app = new Hono();
      const fmt = createMockFormatAdapter();
      const req = createRequest(true);
      const pool = createMockPoolForDiagnosis({
        reason: "needs_human",
        concurrencySaturatedCount: 0,
        quotaWindowCount: 0,
        needsHumanCount: 1,
        earliestQuotaResetAt: null,
      });

      app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt, pool }));
      const res = await app.request("/no-account");

      expect(res.status).toBe(403); // fmt.needsHumanStatus, not 200
      expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
      expect(res.headers.get("x-should-retry")).toBe("false");
      expect(res.headers.get("Retry-After")).toBeNull();
      const body = await res.json() as { error: string; status: number };
      expect(body.status).toBe(403);
      expect(fmt.formatError).toHaveBeenCalledWith(403, expect.any(String));
    });

    it("mixed bucket with a self-heal component present → treated as self-heal, not needs_human (retrying might still succeed)", async () => {
      const app = new Hono();
      const fmt = createMockFormatAdapter();
      const req = createRequest(false);
      const pool = createMockPoolForDiagnosis({
        reason: "mixed",
        concurrencySaturatedCount: 1,
        quotaWindowCount: 0,
        needsHumanCount: 1,
        earliestQuotaResetAt: null,
      });

      app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt, pool }));
      const res = await app.request("/no-account");

      expect(res.status).toBe(503);
      expect(res.headers.get("x-should-retry")).toBeNull();
    });
  });
});
