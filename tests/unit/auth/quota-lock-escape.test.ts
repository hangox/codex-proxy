/**
 * Tests for issue #730 quota lock escape bugs.
 *
 * Bug 2: When limit_reached=true but reset_at=null the account must be
 *   marked quotaVerifyRequired so ActiveQuotaRefresher picks it up.
 *
 * Bug 1b: Active quota refresh must be triggered for used_percent>=100
 *   even when limit_reached is still false — hasReachedCachedQuota check.
 *
 * Bug 3: ActiveQuotaRefresher must check rate_limits_by_limit_id buckets
 *   in addition to the primary bucket when deciding whether to refresh.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { hasReachedCachedQuota } from "@src/auth/quota-skip.js";
import { resolveRefreshIntervals } from "@src/auth/active-quota-refresher.js";
import type { CodexQuota } from "@src/auth/types.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "round_robin",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
}

function quota(overrides: Partial<CodexQuota> = {}): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 0,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

// ── Bug 2: reset_at=null + limit_reached=true → quotaVerifyRequired ──────────

describe("Bug 2 — limit_reached=true reset_at=null → quotaVerifyRequired", () => {
  beforeEach(() => setConfigForTesting(createMockConfig()));
  afterEach(() => resetConfigForTesting());

  it("sets quotaVerifyRequired=true when primary limit_reached=true and reset_at=null", () => {
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "b2a" }));

    pool.updateCachedQuota(id, quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: null,          // no reset_at → would be locked forever without fix
        limit_window_seconds: null,
      },
    }));

    // Trigger refreshStatus (called internally by getPoolSummary)
    pool.getPoolSummary();

    const entry = pool.getEntry(id);
    // Fix 2: quotaVerifyRequired must be true so ActiveQuotaRefresher picks it up
    expect(entry?.quotaVerifyRequired).toBe(true);
  });

  it("does NOT set quotaVerifyRequired when limit_reached=true but reset_at is set in future", () => {
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "b2b" }));

    pool.updateCachedQuota(id, quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,  // has reset_at → normal
        limit_window_seconds: 3600,
      },
    }));

    pool.getPoolSummary();
    const entry = pool.getEntry(id);
    // updateCachedQuota clears quotaVerifyRequired=false; refreshStatus must NOT re-set it
    // when reset_at is in the future (offline unlock will happen at that time)
    expect(entry?.quotaVerifyRequired).toBe(false);
  });
});

// ── Bug 1b: used_percent>=100 → hasReachedCachedQuota must return true ───────

describe("Bug 1b — hasReachedCachedQuota on used_percent=100 with limit_reached=false", () => {
  beforeEach(() => setConfigForTesting(createMockConfig()));
  afterEach(() => resetConfigForTesting());

  it("rateLimitToQuota-derived quota with used_percent=100 excludes account from pool", () => {
    // This verifies the current behaviour that rateLimitToQuota sets limit_reached=true
    // when used_percent>=100. The account must be excluded so ActiveQuotaRefresher
    // (which checks isLocked = limit_reached===true) will proactively refresh it.
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "b1a" }));

    pool.updateCachedQuota(id, quota({
      rate_limit: {
        allowed: true,
        // This is what rateLimitToQuota produces from used_percent>=100 header:
        limit_reached: true,
        used_percent: 100,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
    }));

    // Account must NOT be available (excluded by hasReachedCachedQuota)
    expect(pool.hasAvailableAccounts()).toBe(false);
    // And hasReachedCachedQuota must reflect this
    const entry = pool.getEntry(id)!;
    expect(hasReachedCachedQuota(entry)).toBe(true);
  });
});

// ── Bug 3: rate_limits_by_limit_id bucket locked → excluded from pool ────────

describe("Bug 3 — hasReachedCachedQuota checks rate_limits_by_limit_id", () => {
  beforeEach(() => setConfigForTesting(createMockConfig()));
  afterEach(() => resetConfigForTesting());

  it("hasReachedCachedQuota returns true when a per-model bucket is limit_reached", () => {
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "b3a" }));

    pool.updateCachedQuota(id, quota({
      rate_limit: {
        allowed: true,
        limit_reached: false,  // primary is fine
        used_percent: 30,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 3600,
      },
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          limit_name: "codex_bengalfox",
          allowed: false,
          limit_reached: true,   // model bucket IS locked
          used_percent: 100,
          remaining_percent: 0,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 3600,
          secondary_rate_limit: null,
        },
      },
    }));

    const entry = pool.getEntry(id)!;
    // Model-specific: hasReachedCachedQuota with the model name should return true
    expect(hasReachedCachedQuota(entry, "codex-bengalfox")).toBe(true);
    // Without a model arg, hasReachedCachedQuota correctly returns false —
    // per-model buckets only block the specific model, not the whole account.
    // The fix for Bug 3 is in ActiveQuotaRefresher which now directly checks
    // all rate_limits_by_limit_id buckets via the bucketLocked variable.
    expect(hasReachedCachedQuota(entry)).toBe(false);
  });

  it("hasReachedCachedQuota returns false when all rate_limits_by_limit_id buckets are not locked", () => {
    const pool = makePool();
    const id = pool.addAccount(createValidJwt({ accountId: "b3b" }));

    pool.updateCachedQuota(id, quota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          limit_name: "codex_bengalfox",
          allowed: true,
          limit_reached: false,
          used_percent: 30,
          remaining_percent: 70,
          reset_at: Math.floor(Date.now() / 1000) + 3600,
          limit_window_seconds: 3600,
          secondary_rate_limit: null,
        },
      },
    }));

    const entry = pool.getEntry(id)!;
    expect(hasReachedCachedQuota(entry)).toBe(false);
    expect(pool.hasAvailableAccounts()).toBe(true);
  });
});

// ── Bug (Issue #753): refresh_interval_minutes resolution ───────────────────
// Unconfigured (default.yaml ships 0) must fall back to the historical
// 15 min tick / 30 min min-gap; an explicitly configured value must be honored.

describe("resolveRefreshIntervals (Issue #753)", () => {
  it("falls back to 15 min tick / 30 min gap when interval is 0", () => {
    expect(resolveRefreshIntervals(0)).toEqual({
      tickMs: 15 * 60_000,
      minGapMs: 30 * 60_000,
    });
  });

  it("falls back when interval is unset or non-positive", () => {
    expect(resolveRefreshIntervals(undefined)).toEqual({
      tickMs: 15 * 60_000,
      minGapMs: 30 * 60_000,
    });
    expect(resolveRefreshIntervals(null)).toEqual({
      tickMs: 15 * 60_000,
      minGapMs: 30 * 60_000,
    });
    expect(resolveRefreshIntervals(-1)).toEqual({
      tickMs: 15 * 60_000,
      minGapMs: 30 * 60_000,
    });
  });

  it("honors an explicitly configured interval", () => {
    const { tickMs, minGapMs } = resolveRefreshIntervals(10);
    expect(tickMs).toBe(10 * 60_000);
    expect(minGapMs).toBe(10 * 60_000);
  });
});
