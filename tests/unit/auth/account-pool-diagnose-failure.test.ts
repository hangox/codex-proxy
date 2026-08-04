/**
 * Tests for AccountPool.diagnoseAcquireFailure() (#81) — classifying *why*
 * acquire() returned null into "is retrying useful" buckets, instead of the
 * single flat "No available accounts. All accounts are expired or
 * rate-limited." message that lied to users whose account was merely
 * concurrency-saturated (see #81 production incident).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
      max_concurrent_per_account: 3,
    },
    quota: {
      skip_exhausted: true,
    },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn(() => ({
    email: "test@test.com",
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

import { AccountPool } from "@src/auth/account-pool.js";
import { isTokenExpired } from "@src/auth/jwt-utils.js";
import type { CodexQuota } from "@src/auth/types.js";

function makeQuota(overrides?: Partial<CodexQuota>): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 25,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("AccountPool.diagnoseAcquireFailure", () => {
  let pool: AccountPool;

  beforeEach(() => {
    vi.mocked(isTokenExpired).mockReturnValue(false);
    pool = new AccountPool({ rotationStrategy: "least_used" });
  });

  it("empty pool → needs_human (nothing at all, not a transient condition)", () => {
    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("needs_human");
    expect(diag.needsHumanCount).toBe(0); // no entries to count — this is the "zero accounts total" fallback, not a per-entry tally
    expect(diag.concurrencySaturatedCount).toBe(0);
    expect(diag.quotaWindowCount).toBe(0);
  });

  it("single account, all slots full → concurrency_saturated (the #81 production shape: active=1, nothing 'wrong')", () => {
    const id = pool.addAccount("token-a");
    // max_concurrent_per_account is mocked to 3 — fill all 3 slots.
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).toBeNull(); // 4th request: this is the failure being diagnosed

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("concurrency_saturated");
    expect(diag.concurrencySaturatedCount).toBe(1);
    expect(diag.quotaWindowCount).toBe(0);
    expect(diag.needsHumanCount).toBe(0);
    void id;
  });

  it("refreshing status → concurrency_saturated bucket (self-heals in seconds, must NOT be lumped with expired/banned)", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "refreshing");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("concurrency_saturated");
    expect(diag.concurrencySaturatedCount).toBe(1);
    expect(diag.needsHumanCount).toBe(0);
  });

  it("expired account → needs_human", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "expired");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("needs_human");
    expect(diag.needsHumanCount).toBe(1);
  });

  it("banned account → needs_human", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "banned");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("needs_human");
    expect(diag.needsHumanCount).toBe(1);
  });

  it("disabled account → needs_human", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "disabled");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("needs_human");
    expect(diag.needsHumanCount).toBe(1);
  });

  it("hard quota_exhausted status → quota_window, not needs_human", () => {
    const id = pool.addAccount("token-a");
    pool.markStatus(id, "quota_exhausted");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("quota_window");
    expect(diag.quotaWindowCount).toBe(1);
    expect(diag.needsHumanCount).toBe(0);
  });

  it("active account with cached quota limit_reached (soft exclusion via skip_exhausted) → quota_window", () => {
    const id = pool.addAccount("token-a");
    const resetAt = Math.floor(Date.now() / 1000) + 1800;
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: resetAt,
        limit_window_seconds: 3600,
      },
    }));

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("quota_window");
    expect(diag.quotaWindowCount).toBe(1);
    expect(diag.earliestQuotaResetAt).toBe(resetAt);
  });

  it("earliestQuotaResetAt picks the earliest reset_at across multiple quota-blocked accounts", () => {
    const id1 = pool.addAccount("token-a");
    const id2 = pool.addAccount("token-b");
    const laterReset = Math.floor(Date.now() / 1000) + 7200;
    const earlierReset = Math.floor(Date.now() / 1000) + 900;
    pool.updateCachedQuota(id1, makeQuota({
      rate_limit: { allowed: false, limit_reached: true, used_percent: 100, reset_at: laterReset, limit_window_seconds: 3600 },
    }));
    pool.updateCachedQuota(id2, makeQuota({
      rate_limit: { allowed: false, limit_reached: true, used_percent: 100, reset_at: earlierReset, limit_window_seconds: 3600 },
    }));

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.quotaWindowCount).toBe(2);
    expect(diag.earliestQuotaResetAt).toBe(earlierReset);
  });

  it("earliestQuotaResetAt only considers the specific window bucket that is limit_reached, not an unreached sibling window's reset_at", () => {
    const id = pool.addAccount("token-a");
    const primaryReset = Math.floor(Date.now() / 1000) + 500;
    pool.updateCachedQuota(id, makeQuota({
      rate_limit: { allowed: false, limit_reached: true, used_percent: 100, reset_at: primaryReset, limit_window_seconds: 3600 },
      // secondary is NOT limit_reached — its reset_at must not leak in even though it's numerically smaller.
      secondary_rate_limit: { limit_reached: false, used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 100, limit_window_seconds: 604800 },
    }));

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.earliestQuotaResetAt).toBe(primaryReset);
  });

  it("mix of concurrency-saturated and needs-human accounts → mixed, both counts non-zero", () => {
    const id1 = pool.addAccount("token-a");
    pool.addAccount("token-b");
    pool.markStatus(id1, "banned");
    // token-b: fill its slots to force concurrency saturation.
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).not.toBeNull();
    expect(pool.acquire()).toBeNull();

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.reason).toBe("mixed");
    expect(diag.needsHumanCount).toBe(1);
    expect(diag.concurrencySaturatedCount).toBe(1);
  });

  it("excludeIds are not counted toward any bucket — they're retry-loop bookkeeping, not a reason the pool is unavailable", () => {
    const id1 = pool.addAccount("token-a");
    const id2 = pool.addAccount("token-b");
    pool.markStatus(id2, "banned");

    // Excluding the only healthy account (id1) and diagnosing: id1 should
    // not appear in any bucket (it wasn't "the reason" — it was deliberately
    // skipped by the caller), leaving only id2's genuine needs_human reason.
    const diag = pool.diagnoseAcquireFailure({ excludeIds: [id1] });
    expect(diag.needsHumanCount).toBe(1);
    expect(diag.concurrencySaturatedCount).toBe(0);
    expect(diag.quotaWindowCount).toBe(0);
    expect(diag.reason).toBe("needs_human");
  });

  it("an entry that would actually be acquirable is not counted toward any bucket", () => {
    // Two accounts: one banned (needs_human), one perfectly healthy. If
    // acquire() actually succeeded (it would, here), diagnoseAcquireFailure
    // is being called on stale/wrong assumptions by the caller — but its own
    // contract is just "count each entry's own blocking reason", so the
    // healthy entry contributes to nothing.
    const id1 = pool.addAccount("token-a");
    pool.addAccount("token-b");
    pool.markStatus(id1, "banned");

    const diag = pool.diagnoseAcquireFailure();
    expect(diag.needsHumanCount).toBe(1);
    expect(diag.concurrencySaturatedCount).toBe(0);
    expect(diag.quotaWindowCount).toBe(0);
  });

  describe("model/plan mismatch (★ #81 follow-up — acquire()'s second failure mode)", () => {
    it("active, unsaturated, unblocked account whose plan doesn't match the model → concurrency_saturated, not needs_human", async () => {
      const { getModelPlanTypes, isPlanFetched } = await import("@src/models/model-store.js");
      vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
      vi.mocked(isPlanFetched).mockReturnValue(true);

      const id = pool.addAccount("token-a");
      pool.markStatus(id, "active");
      // Real example this reproduces: single free-plan account, model only
      // on the team plan — status/slot/quota checks all pass, only the
      // plan-matching step (which the original three-bucket pass didn't
      // replicate) explains the failure.

      const diag = pool.diagnoseAcquireFailure({ model: "gpt-5.4" });
      expect(diag.reason).toBe("concurrency_saturated");
      expect(diag.concurrencySaturatedCount).toBe(1);
      expect(diag.needsHumanCount).toBe(0);
    });

    it("account whose plan IS fetched and DOES match the model is not counted toward any bucket", async () => {
      const { getModelPlanTypes, isPlanFetched } = await import("@src/models/model-store.js");
      vi.mocked(getModelPlanTypes).mockReturnValue(["free"]);
      vi.mocked(isPlanFetched).mockReturnValue(true);

      pool.addAccount("token-a"); // default test JWT plan is "free" (see extractUserProfile mock above)

      const diag = pool.diagnoseAcquireFailure({ model: "gpt-5.4" });
      expect(diag.concurrencySaturatedCount).toBe(0);
      expect(diag.needsHumanCount).toBe(0);
      expect(diag.quotaWindowCount).toBe(0);
    });

    it("account with an unfetched plan type is treated as a plausible match (mirrors acquire()'s own isPlanFetched escape hatch), not counted as a failure", async () => {
      const { getModelPlanTypes, isPlanFetched } = await import("@src/models/model-store.js");
      vi.mocked(getModelPlanTypes).mockReturnValue(["team"]);
      vi.mocked(isPlanFetched).mockReturnValue(false); // "team" catalog hasn't been fetched yet

      pool.addAccount("token-a"); // plan is "free", but team's catalog is unknown, not confirmed-mismatched

      const diag = pool.diagnoseAcquireFailure({ model: "gpt-5.4" });
      expect(diag.concurrencySaturatedCount).toBe(0);
    });

    it("model with no plan restriction (getModelPlanTypes → []) never triggers this path", async () => {
      const { getModelPlanTypes } = await import("@src/models/model-store.js");
      vi.mocked(getModelPlanTypes).mockReturnValue([]);

      pool.addAccount("token-a");
      // Force a genuine concurrency failure so there's something to diagnose,
      // and confirm the plan-mismatch pass doesn't double-count on top of it.
      expect(pool.acquire()).not.toBeNull();
      expect(pool.acquire()).not.toBeNull();
      expect(pool.acquire()).not.toBeNull();
      expect(pool.acquire()).toBeNull();

      const diag = pool.diagnoseAcquireFailure({ model: "gpt-5.4" });
      expect(diag.concurrencySaturatedCount).toBe(1);
    });
  });
});
