import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCodexApiError, type ErrorAction } from "@src/routes/shared/proxy-error-handler.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import { _resetAllCfPathBlocks } from "@src/auth/cf-path-block-tracker.js";
import {
  _resetAllCfChallengeCooldowns,
  getCfChallengeCooldown,
} from "@src/auth/cf-challenge-cooldown.js";

/* ── Minimal mock matching AccountPool subset used by error handler ── */
interface MockPool {
  markRateLimited: ReturnType<typeof vi.fn>;
  applyRateLimit429: ReturnType<typeof vi.fn>;
  markStatus: ReturnType<typeof vi.fn>;
  getEntry: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
  return {
    markRateLimited: vi.fn(),
    applyRateLimit429: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn().mockReturnValue({ email: "test@example.com" }),
    acquire: vi.fn(),
  };
}

interface MockJar {
  clear: ReturnType<typeof vi.fn>;
}

function createMockJar(): MockJar {
  return { clear: vi.fn() };
}

describe("handleCodexApiError", () => {
  let pool: MockPool;
  const tag = "Test";
  const model = "gpt-5.4";
  const entryId = "e1";

  beforeEach(() => {
    pool = createMockPool();
    _resetAllCfChallengeCooldowns();
  });

  // ── model-not-supported ──

  describe("model-not-supported", () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { message: "Model gpt-5.4 is not supported on this plan" },
    }));

    it("returns retry action on first occurrence with fallback info", () => {
      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.markModelRetried).toBe(true);
      expect(result.status).toBe(400);
      expect(result.message).toBeDefined();
    });

    it("returns respond action when already retried", () => {
      const result = handleCodexApiError(err, pool as never, entryId, model, tag, true);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(400);
    });

    it("does not mark account status", () => {
      handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(pool.applyRateLimit429).not.toHaveBeenCalled();
      expect(pool.markRateLimited).not.toHaveBeenCalled();
      expect(pool.markStatus).not.toHaveBeenCalled();
    });
  });

  // ── 429 rate-limited ──

  describe("429 rate-limited", () => {
    it("applies 429 retry-after to cachedQuota and returns retry", () => {
      const body = JSON.stringify({ error: { resets_in_seconds: 30 } });
      const err = new CodexApiError(429, body);

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.applyRateLimit429).toHaveBeenCalledWith(entryId, {
        retryAfterSec: 30,
        countRequest: true,
      });
    });

    it("forwards undefined retryAfterSec when 429 body has no hint (registry uses default backoff)", () => {
      const err = new CodexApiError(429, "rate limited");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.applyRateLimit429).toHaveBeenCalledWith(entryId, {
        retryAfterSec: undefined,
        countRequest: true,
      });
    });

    it("does not combine with cached quota in handler (don't-shrink-existing-reset_at lives inside applyRateLimit429)", () => {
      const resetAt = Math.floor(Date.now() / 1000) + 86400;
      pool.getEntry.mockReturnValue({
        email: "test@example.com",
        cachedQuota: {
          rate_limit: { limit_reached: true, reset_at: resetAt },
        },
      });
      const err = new CodexApiError(429, JSON.stringify({ error: { resets_in_seconds: 30 } }));

      handleCodexApiError(err, pool as never, entryId, model, tag, false);

      // Handler passes through the raw retry-after; registry-level
      // applyRateLimit429 preserves the longer existing reset_at.
      expect(pool.applyRateLimit429).toHaveBeenCalledWith(entryId, {
        retryAfterSec: 30,
        countRequest: true,
      });
    });
  });

  // ── 402 quota exhausted ──

  describe("402 quota exhausted", () => {
    it("marks account quota_exhausted and returns retry", () => {
      const err = new CodexApiError(402, JSON.stringify({ detail: "Payment required" }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.status).toBe(402);
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "quota_exhausted");
    });
  });

  describe("503 server overloaded", () => {
    it("retries on another account without mutating account health or quota", () => {
      const err = new CodexApiError(503, JSON.stringify({
        error: { code: "server_is_overloaded", message: "The server is overloaded" },
      }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.status).toBe(503);
      expect(result.releaseBeforeRetry).toBe(true);
      expect(pool.markStatus).not.toHaveBeenCalled();
      expect(pool.applyRateLimit429).not.toHaveBeenCalled();
    });

    it("does not retry an unrelated generic 503", () => {
      const result = handleCodexApiError(
        new CodexApiError(503, "database unavailable"),
        pool as never, entryId, model, tag, false,
      );

      expect(result.action).toBe("respond");
      expect(result.status).toBe(503);
    });
  });

  // ── 403 ban ──

  describe("403 ban", () => {
    it("marks account banned and returns retry", () => {
      const err = new CodexApiError(403, JSON.stringify({ error: { message: "banned" } }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "banned");
    });

    it("records Cloudflare challenge cooldown and retries without banning", () => {
      const err = new CodexApiError(403, "<html>cf_chl challenge</html>");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBe(true);
      expect(result.status).toBe(502);
      expect(result.message).toContain("Cloudflare challenge");
      expect(pool.markStatus).not.toHaveBeenCalled();
      expect(getCfChallengeCooldown(entryId)?.delaySeconds).toBe(10);
    });

    it("does not ban Cloudflare challenge responses that do not include HTML markers", () => {
      const err = new CodexApiError(403, "cf-mitigated: challenge; cf-chl-bypass: managed");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBe(true);
      expect(result.status).toBe(502);
      expect(pool.markStatus).not.toHaveBeenCalled();
      expect(getCfChallengeCooldown(entryId)?.delaySeconds).toBe(10);
    });
  });

  // ── 401 token-invalid ──

  describe("401 token-invalid", () => {
    it("marks account expired and returns retry", () => {
      const err = new CodexApiError(401, "token revoked");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "expired");
    });

    it("marks account banned when deactivated", () => {
      const err = new CodexApiError(
        401,
        "Your OpenAI account has been deactivated, please check your email",
      );

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "banned");
    });
  });

  // ── generic errors ──

  describe("generic errors", () => {
    it("returns prompt-too-long as a client error without mutating account state", () => {
      const err = new CodexApiError(502, JSON.stringify({
        error: {
          type: "context_length_exceeded",
          code: "context_length_exceeded",
          message: "Your input exceeds the context window",
        },
      }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result).toMatchObject({
        action: "respond",
        status: 400,
        message: expect.stringContaining("Prompt is too long"),
      });
      expect(pool.applyRateLimit429).not.toHaveBeenCalled();
      expect(pool.markStatus).not.toHaveBeenCalled();
    });

    it("returns respond with clamped status for 5xx", () => {
      const err = new CodexApiError(503, "service unavailable");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(503);
      expect(result.message).toContain("service unavailable");
    });

    it("clamps non-error status codes to 502", () => {
      const err = new CodexApiError(0, "connection refused");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("respond");
      expect(result.status).toBe(502);
    });

    it("includes errorBody from upstream in respond action", () => {
      const upstreamBody = JSON.stringify({ error: { message: "invalid param", type: "invalid_request_error" } });
      const err = new CodexApiError(422, upstreamBody);

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("respond");
      expect(result.errorBody).toBe(upstreamBody);
    });
  });

  // ── safeLog console.error message（19% root compact 静默降级排查发现的
  //    口径调整：safeLog 此前把 err.message 整段吞掉，只为了保护账号标识，
  //    结果 opaque compact 遇到 transport 层异常（status=0）时日志里只剩
  //    "status=0"，连是超时还是连接重置都分不出来）──

  describe("safeLog console.error message", () => {
    it("safeLog=true：账号标识仍然脱敏，但 message 现在会打印（经 sanitizeFreeTextForLog）", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const err = new CodexApiError(0, "connect ETIMEDOUT 1.2.3.4:443");
        handleCodexApiError(err, pool as never, entryId, model, tag, false, undefined, true);

        expect(errSpy).toHaveBeenCalledTimes(1);
        const line = String(errSpy.mock.calls[0]![0]);
        expect(line).toContain("status=0");
        // 账号标识仍然不能明文出现——safeLog 对这部分的保护没有变。
        expect(line).not.toContain(entryId);
        expect(line).not.toContain("test@example.com");
        // message 现在必须出现——这正是这次要修的盲点。
        expect(line).toContain("message=");
        expect(line).toContain("ETIMEDOUT");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("safeLog=false：账号标识明文、message 同样打印（未受影响，一直如此）", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const err = new CodexApiError(0, "connect ECONNRESET");
        handleCodexApiError(err, pool as never, entryId, model, tag, false, undefined, false);

        const line = String(errSpy.mock.calls[0]![0]);
        expect(line).toContain(`Account ${entryId}`);
        expect(line).toContain("ECONNRESET");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("message 里嵌的 opaque marker 不会原样打印（经 sanitizeFreeTextForLog 脱敏）", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const marker = `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;
        const err = new CodexApiError(0, marker);
        handleCodexApiError(err, pool as never, entryId, model, tag, false, undefined, true);

        const line = String(errSpy.mock.calls[0]![0]);
        expect(line).not.toContain(marker);
        expect(line).not.toContain("A".repeat(32));
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  // ── ErrorAction shape ──

  describe("ErrorAction shape", () => {
    it("retry action includes releaseBeforeRetry flag for model-not-supported", () => {
      const err = new CodexApiError(400, JSON.stringify({
        error: { message: "Model not supported" },
      }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBe(true);
    });

    it("retry action for 429/ban/401 does NOT release but includes fallback info", () => {
      const err = new CodexApiError(429, "{}");

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);

      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBeUndefined();
      // Includes fallback info for when no retry account is available
      expect(result.status).toBe(429);
      expect(result.useFormat429).toBe(true);
    });

    it("Cloudflare path-block (empty-body 404): clears cookies, retries, disables after threshold", () => {
      _resetAllCfPathBlocks();
      const jar = createMockJar();
      const err = new CodexApiError(404, "");

      // 1st & 2nd: clear cookies, retry on different account, no disable
      let result = handleCodexApiError(err, pool as never, entryId, model, tag, false, jar as never);
      expect(result.action).toBe("retry");
      expect(result.releaseBeforeRetry).toBe(true);
      expect(jar.clear).toHaveBeenCalledWith(entryId);
      expect(pool.markStatus).not.toHaveBeenCalled();

      result = handleCodexApiError(err, pool as never, entryId, model, tag, false, jar as never);
      expect(result.action).toBe("retry");
      expect(pool.markStatus).not.toHaveBeenCalled();

      // 3rd: threshold reached — disable account
      result = handleCodexApiError(err, pool as never, entryId, model, tag, false, jar as never);
      expect(pool.markStatus).toHaveBeenCalledWith(entryId, "disabled");
      // Still a retry so the request can fail over to another account on the
      // same orchestration loop.
      expect(result.action).toBe("retry");
    });

    it("Cloudflare path-block branch ignores non-empty 404 bodies", () => {
      _resetAllCfPathBlocks();
      const jar = createMockJar();
      const err = new CodexApiError(404, JSON.stringify({ error: { message: "real not found" } }));

      const result = handleCodexApiError(err, pool as never, entryId, model, tag, false, jar as never);

      // Falls through to generic respond path; no cookie clear, no disable.
      expect(result.action).toBe("respond");
      expect(result.status).toBe(404);
      expect(jar.clear).not.toHaveBeenCalled();
      expect(pool.markStatus).not.toHaveBeenCalled();
    });

    it("retry actions do NOT include errorBody", () => {
      const cases = [
        new CodexApiError(429, JSON.stringify({ error: { resets_in_seconds: 30 } })),
        new CodexApiError(402, JSON.stringify({ detail: "Payment required" })),
        new CodexApiError(403, JSON.stringify({ error: { message: "banned" } })),
        new CodexApiError(401, "token revoked"),
      ];
      for (const err of cases) {
        const result = handleCodexApiError(err, pool as never, entryId, model, tag, false);
        expect(result.action).toBe("retry");
        expect("errorBody" in result).toBe(false);
      }
    });
  });
});
