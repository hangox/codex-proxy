/**
 * Tests for AccountPool core scheduling logic.
 *
 * Uses vi.mock to stub filesystem and JWT utilities so tests run
 * without actual data files or valid JWT tokens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing AccountPool
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

// Mock config
vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: {
      proxy_api_key: null,
    },
  })),
}));

// Mock JWT utilities — all tokens are "valid"
vi.mock("../jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

// Mock jitter to return the exact value (no randomness in tests)
vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

import { AccountPool } from "../account-pool.js";
import { getConfig } from "../../config.js";
import { isTokenExpired } from "../jwt-utils.js";

describe("AccountPool", () => {
  let pool: AccountPool;

  beforeEach(() => {
    // Reset mock implementations to defaults (clearAllMocks only clears call history)
    vi.mocked(isTokenExpired).mockReturnValue(false);
    vi.mocked(getConfig).mockReturnValue({
      auth: {
        jwt_token: null,
        rotation_strategy: "least_used",
        rate_limit_backoff_seconds: 60,
      },
      server: { proxy_api_key: null },
    } as ReturnType<typeof getConfig>);
    pool = new AccountPool();
  });

  afterEach(() => {
    pool.destroy();
  });

  describe("addAccount + acquire", () => {
    it("adds an account and acquires it", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire();
      expect(acquired).not.toBeNull();
      expect(acquired!.token).toBe("token-aaa");
    });

    it("deduplicates by accountId", () => {
      const id1 = pool.addAccount("token-aaa");
      const id2 = pool.addAccount("token-aaa"); // same prefix → same accountId

      expect(id1).toBe(id2);
    });

    it("returns null when no accounts exist", () => {
      expect(pool.acquire()).toBeNull();
    });
  });

  describe("least_used rotation", () => {
    it("selects the account with lowest request_count", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      // Use account A once
      const first = pool.acquire()!;
      pool.release(first.entryId, { input_tokens: 10, output_tokens: 5 });

      // Next acquire should pick the other account (0 requests)
      const second = pool.acquire()!;
      expect(second.entryId).not.toBe(first.entryId);
    });
  });

  describe("round_robin rotation", () => {
    it("cycles through accounts in order", () => {
      vi.mocked(getConfig).mockReturnValue({
        auth: {
          jwt_token: null,
          rotation_strategy: "round_robin",
          rate_limit_backoff_seconds: 60,
        },
        server: { proxy_api_key: null },
      } as ReturnType<typeof getConfig>);

      // Create a fresh pool with round_robin config
      const rrPool = new AccountPool();
      rrPool.addAccount("token-aaa");
      rrPool.addAccount("token-bbb");

      const a1 = rrPool.acquire()!;
      rrPool.release(a1.entryId);

      const a2 = rrPool.acquire()!;
      rrPool.release(a2.entryId);

      const a3 = rrPool.acquire()!;
      rrPool.release(a3.entryId);

      // a3 should wrap around to same as a1
      expect(a3.entryId).toBe(a1.entryId);
      expect(a1.entryId).not.toBe(a2.entryId);

      rrPool.destroy();
    });
  });

  describe("release", () => {
    it("increments request_count and token usage", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 100, output_tokens: 50 });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
      expect(accounts[0].usage.input_tokens).toBe(100);
      expect(accounts[0].usage.output_tokens).toBe(50);
      expect(accounts[0].usage.last_used).not.toBeNull();
    });

    it("unlocks account after release", () => {
      pool.addAccount("token-aaa");

      const a1 = pool.acquire()!;
      // While locked, acquire returns null (only 1 account)
      expect(pool.acquire()).toBeNull();

      pool.release(a1.entryId);
      // After release, can acquire again
      expect(pool.acquire()).not.toBeNull();
    });
  });

  describe("markRateLimited", () => {
    it("marks account as rate_limited and skips it in acquire", () => {
      pool.addAccount("token-aaa");
      pool.addAccount("token-bbb");

      const first = pool.acquire()!;
      pool.markRateLimited(first.entryId);

      // Pool summary should show 1 rate_limited
      const summary = pool.getPoolSummary();
      expect(summary.rate_limited).toBe(1);
      expect(summary.active).toBe(1);

      // Next acquire should skip the rate-limited account
      const second = pool.acquire()!;
      expect(second.entryId).not.toBe(first.entryId);
    });

    it("countRequest option increments usage on 429", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.markRateLimited(acquired.entryId, { countRequest: true });

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(1);
    });

    it("auto-recovers after rate_limit_until passes", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      // Set rate limit to already expired
      pool.markRateLimited(acquired.entryId, { retryAfterSec: -1 });

      // refreshStatus should detect the expired rate_limit_until
      const summary = pool.getPoolSummary();
      expect(summary.active).toBe(1);
      expect(summary.rate_limited).toBe(0);
    });
  });

  describe("stale lock auto-release", () => {
    it("releases locks older than 5 minutes", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;

      // Manually backdate the lock by manipulating the acquireLocks map
      // Access private field for testing — unavoidable for TTL tests
      const locks = (pool as unknown as { acquireLocks: Map<string, number> }).acquireLocks;
      locks.set(acquired.entryId, Date.now() - 6 * 60 * 1000); // 6 minutes ago

      // Next acquire should auto-release the stale lock and return the same account
      const reacquired = pool.acquire()!;
      expect(reacquired).not.toBeNull();
      expect(reacquired.entryId).toBe(acquired.entryId);
    });
  });

  describe("expired tokens", () => {
    it("skips expired accounts in acquire", () => {
      vi.mocked(isTokenExpired).mockReturnValue(true);
      pool.addAccount("token-expired");

      expect(pool.acquire()).toBeNull();
      expect(pool.getPoolSummary().expired).toBe(1);
    });
  });

  describe("removeAccount", () => {
    it("removes an account and clears its lock", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.removeAccount(acquired.entryId);

      expect(pool.getPoolSummary().total).toBe(0);
      expect(pool.acquire()).toBeNull();
    });
  });

  describe("resetUsage", () => {
    it("resets counters to zero", () => {
      pool.addAccount("token-aaa");

      const acquired = pool.acquire()!;
      pool.release(acquired.entryId, { input_tokens: 100, output_tokens: 50 });
      pool.resetUsage(acquired.entryId);

      const accounts = pool.getAccounts();
      expect(accounts[0].usage.request_count).toBe(0);
      expect(accounts[0].usage.input_tokens).toBe(0);
      expect(accounts[0].usage.output_tokens).toBe(0);
    });
  });

  describe("validateProxyApiKey", () => {
    it("validates per-account proxy API key", () => {
      pool.addAccount("token-aaa");

      const accounts = pool.getAccounts();
      // Each account gets a generated proxyApiKey — we can't predict it,
      // but we can read it and validate
      const entry = pool.getEntry(accounts[0].id)!;
      expect(pool.validateProxyApiKey(entry.proxyApiKey)).toBe(true);
      expect(pool.validateProxyApiKey("wrong-key")).toBe(false);
    });

    it("validates config-level proxy API key", () => {
      vi.mocked(getConfig).mockReturnValue({
        auth: {
          jwt_token: null,
          rotation_strategy: "least_used",
          rate_limit_backoff_seconds: 60,
        },
        server: { proxy_api_key: "global-key-123" },
      } as ReturnType<typeof getConfig>);

      expect(pool.validateProxyApiKey("global-key-123")).toBe(true);
    });
  });
});
