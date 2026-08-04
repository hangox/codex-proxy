/**
 * AccountLifecycle — owns acquire locks and rotation strategy.
 *
 * Handles: acquire, release, lock management, rotation strategy.
 * Uses AccountRegistry for entry access (no circular dep — one-way reference).
 */

import { getConfig } from "../config.js";
import { getModelPlanTypes, isPlanFetched } from "../models/model-store.js";
import { hasReachedCachedQuota } from "./quota-skip.js";
import { getRotationStrategy } from "./rotation-strategy.js";
import type { RotationStrategy, RotationState, RotationStrategyName } from "./rotation-strategy.js";
import type { AccountRegistry } from "./account-registry.js";
import type { AccountEntry, AcquiredAccount, CodexQuota } from "./types.js";

const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * ★ #81: why `acquire()` returned null, broken down by "does retrying help".
 *
 * `getPoolSummary()` (account-registry.ts) only knows account `status` +
 * cached quota — it has never known about concurrency slots, because that
 * state lives here in AccountLifecycle, not the registry. That gap is the
 * direct cause of the 529 "No available accounts. All accounts are expired
 * or rate-limited" message lying to users whose single account was simply
 * slot-saturated (active=1, nothing wrong) — see #81 production incident
 * (385 occurrences / 46 minutes, single account, `max_concurrent_per_account`
 * capped at 3).
 *
 * Buckets are split by "is retrying useful", not by which AccountStatus
 * value is involved — an earlier draft of this grouped `refreshing` with
 * `expired`/`banned`/`disabled` because they're all "not active", but
 * `refreshing` self-heals in seconds just like slot saturation, and lumping
 * it with genuinely-dead accounts would tell a user to `/clear` a session
 * that would have worked fine a few seconds later.
 */
export type AcquireFailureReason =
  | "concurrency_saturated" // slots full and/or token refresh in flight — self-heals in seconds
  | "quota_window" // cached quota window hit (or hard `quota_exhausted` status) — self-heals when the window resets
  | "needs_human" // expired/banned/disabled, or no accounts configured at all — retrying will not help
  | "mixed"; // more than one of the above applies simultaneously — don't pick one arbitrarily and hide the rest

export interface AcquireFailureDiagnosis {
  reason: AcquireFailureReason;
  concurrencySaturatedCount: number;
  quotaWindowCount: number;
  needsHumanCount: number;
  /** Earliest cachedQuota reset_at (Unix seconds) among accounts contributing
   *  to quotaWindowCount, or null if none have quota data to derive one from.
   *  This is a REAL value (not a heuristic) — safe to use directly as a
   *  Retry-After hint, unlike the concurrency-saturated case which has no
   *  equivalent authoritative number (slot release time is unpredictable). */
  earliestQuotaResetAt: number | null;
}

/** Earliest `reset_at` (Unix seconds) among this account's *currently
 *  limit_reached* quota windows, or null if none are reached or none carry
 *  a reset_at. Mirrors `hasReachedCachedQuota`'s bucket set exactly (see
 *  quota-skip.ts) so this stays in sync if a bucket is ever added there. */
function earliestLimitReachedResetAt(quota: CodexQuota | null): number | null {
  if (!quota) return null;
  const candidates: number[] = [];
  if (quota.rate_limit.limit_reached && quota.rate_limit.reset_at != null) {
    candidates.push(quota.rate_limit.reset_at);
  }
  if (quota.secondary_rate_limit?.limit_reached && quota.secondary_rate_limit.reset_at != null) {
    candidates.push(quota.secondary_rate_limit.reset_at);
  }
  if (quota.code_review_rate_limit?.limit_reached && quota.code_review_rate_limit.reset_at != null) {
    candidates.push(quota.code_review_rate_limit.reset_at);
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export class AccountLifecycle {
  /** Per-account active slot timestamps. Each entry = one in-flight request. */
  private acquireLocks: Map<string, number[]> = new Map();
  private strategy: RotationStrategy;
  private rotationState: RotationState = { roundRobinIndex: 0 };
  private registry: AccountRegistry;

  constructor(registry: AccountRegistry, strategyName: RotationStrategyName) {
    this.registry = registry;
    this.strategy = getRotationStrategy(strategyName);
  }

  private slotCount(entryId: string): number {
    return this.acquireLocks.get(entryId)?.length ?? 0;
  }

  private pushSlot(entryId: string): void {
    const slots = this.acquireLocks.get(entryId);
    if (slots) {
      slots.push(Date.now());
    } else {
      this.acquireLocks.set(entryId, [Date.now()]);
    }
  }

  private popSlot(entryId: string): void {
    const slots = this.acquireLocks.get(entryId);
    if (!slots) return;
    slots.shift();
    if (slots.length === 0) this.acquireLocks.delete(entryId);
  }

  acquire(options?: { model?: string; excludeIds?: string[]; preferredEntryId?: string }): AcquiredAccount | null {
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    // Auto-release stale slots (slots are chronological — if oldest is fresh, all are)
    for (const [id, slots] of this.acquireLocks) {
      if (nowMs - slots[0] <= ACQUIRE_LOCK_TTL_MS) continue;
      const fresh = slots.filter((ts) => nowMs - ts <= ACQUIRE_LOCK_TTL_MS);
      const staleCount = slots.length - fresh.length;
      console.warn(
        `[AccountPool] Auto-releasing ${staleCount} stale slot(s) for ${id}`,
      );
      if (fresh.length === 0) {
        this.acquireLocks.delete(id);
      } else {
        this.acquireLocks.set(id, fresh);
      }
    }

    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const excludeSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;

    const available = entries.filter(
      (a) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        (!excludeSet || !excludeSet.has(a.id)) &&
        (!skipExhausted || !hasReachedCachedQuota(a)),
    );

    if (available.length === 0) return null;

    let candidates = available;
    if (options?.model) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = available.filter((a) => {
          if (!a.planType) return false;
          if (planSet.has(a.planType)) return true;
          return !isPlanFetched(a.planType);
        });
        if (matched.length > 0) {
          candidates = matched;
        } else {
          return null;
        }
      }
    }

    // Tier-based filtering: when configured, restrict to the highest available tier
    const tierPriority = config.auth.tier_priority;
    if (tierPriority && tierPriority.length > 0) {
      const tierOrder = new Map(tierPriority.map((t, i) => [t, i]));
      let bestIdx = Infinity;
      for (const c of candidates) {
        const idx = c.planType != null ? (tierOrder.get(c.planType) ?? Infinity) : Infinity;
        if (idx < bestIdx) bestIdx = idx;
      }
      if (bestIdx < Infinity) {
        const bestTier = tierPriority[bestIdx];
        const tierFiltered = candidates.filter((c) => c.planType === bestTier);
        if (tierFiltered.length > 0) candidates = tierFiltered;
      }
    }

    // Session affinity: prefer the account that owns the conversation
    let selected: AccountEntry;
    if (options?.preferredEntryId) {
      const preferred = candidates.find((a) => a.id === options.preferredEntryId);
      selected = preferred ?? this.strategy.select(candidates, this.rotationState);
    } else {
      selected = this.strategy.select(candidates, this.rotationState);
    }
    const prevSlots = this.acquireLocks.get(selected.id);
    const prevSlotMs = prevSlots?.[prevSlots.length - 1] ?? null;
    this.pushSlot(selected.id);
    return {
      entryId: selected.id,
      token: selected.token,
      accountId: selected.accountId,
      prevSlotMs,
    };
  }

  /**
   * ★ #81: classify why `acquire()` returned (or would return) null — only
   * meant to be called on the cold/failure path, not on every acquire. It
   * re-walks all entries with the same status/slot/quota checks `acquire()`
   * uses, but instead of short-circuiting on the first empty result, it
   * tallies *why* each entry was excluded so the caller can tell "server is
   * momentarily busy" from "your account pool is actually broken" — see the
   * `AcquireFailureReason` doc comment for the full rationale.
   *
   * Deliberately a separate pass rather than folding this into `acquire()`
   * itself: `acquire()` is the hot path (every proxied request), and this
   * walks every entry unconditionally to build full counts — paying that
   * cost on every request for a value that's only used when acquisition
   * already failed would be wasteful.
   */
  diagnoseAcquireFailure(options?: { excludeIds?: string[]; model?: string }): AcquireFailureDiagnosis {
    const now = new Date();
    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const excludeSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;

    let concurrencySaturatedCount = 0;
    let quotaWindowCount = 0;
    let needsHumanCount = 0;
    let earliestQuotaResetAt: number | null = null;
    // Entries that pass every primary check (status/slot/quota) — i.e. would
    // be in acquire()'s `available` array. Tracked separately from the
    // bucket counters below because they need a *second* pass (model/plan
    // matching) before we know whether they actually explain the failure.
    const primarilyAvailable: AccountEntry[] = [];

    const noteQuotaResetAt = (entry: AccountEntry) => {
      const resetAt = earliestLimitReachedResetAt(entry.cachedQuota);
      if (resetAt == null) return;
      earliestQuotaResetAt = earliestQuotaResetAt == null ? resetAt : Math.min(earliestQuotaResetAt, resetAt);
    };

    for (const entry of entries) {
      // Deliberately excluded by the caller (already tried this account in
      // a retry loop) — not a reason the pool itself is unavailable, so it
      // doesn't count toward any bucket.
      if (excludeSet?.has(entry.id)) continue;

      if (entry.status === "refreshing") {
        concurrencySaturatedCount++; // self-heals in seconds, same as slot saturation
        continue;
      }
      if (entry.status === "expired" || entry.status === "disabled" || entry.status === "banned") {
        needsHumanCount++;
        continue;
      }
      if (entry.status === "quota_exhausted") {
        quotaWindowCount++;
        noteQuotaResetAt(entry);
        continue;
      }
      // entry.status === "active" from here on.
      if (skipExhausted && hasReachedCachedQuota(entry)) {
        quotaWindowCount++;
        noteQuotaResetAt(entry);
        continue;
      }
      if (this.slotCount(entry.id) >= maxConcurrent) {
        concurrencySaturatedCount++;
        continue;
      }
      primarilyAvailable.push(entry);
    }

    // ★ #81 follow-up: acquire() has a SECOND failure mode this method
    // originally missed — `available.length > 0` but every candidate gets
    // filtered out by model/plan matching (see acquire()'s `candidates`
    // narrowing block). Real example: single free-plan account, model only
    // available on team plan — the account is active, unsaturated, not
    // quota-blocked (contributes to none of the three counters above), yet
    // acquire() still returns null. Folded into concurrencySaturatedCount
    // rather than a fourth bucket: like slot saturation, this resolves on
    // its own (the account's plan gets re-synced from a backend refresh,
    // or another account of the right plan joins the pool) without any
    // human action — telling the client to give up would be wrong here for
    // the same reason it's wrong for real concurrency saturation. Not a
    // perfect semantic fit (nothing here is literally "at its concurrency
    // limit"), but it gets the retry-vs-give-up decision right, which is
    // the only thing the client-facing bucket actually needs.
    if (options?.model && primarilyAvailable.length > 0) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = primarilyAvailable.filter((a) => {
          if (!a.planType) return false;
          if (planSet.has(a.planType)) return true;
          return !isPlanFetched(a.planType);
        });
        if (matched.length === 0) {
          concurrencySaturatedCount += primarilyAvailable.length;
        }
      }
    }

    const bucketsHit =
      Number(concurrencySaturatedCount > 0) +
      Number(quotaWindowCount > 0) +
      Number(needsHumanCount > 0);

    const reason: AcquireFailureReason =
      bucketsHit > 1
        ? "mixed"
        : concurrencySaturatedCount > 0
          ? "concurrency_saturated"
          : quotaWindowCount > 0
            ? "quota_window"
            : "needs_human"; // covers needsHumanCount > 0 and the "zero accounts at all" case

    return { reason, concurrencySaturatedCount, quotaWindowCount, needsHumanCount, earliestQuotaResetAt };
  }

  release(
    entryId: string,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_tokens?: number;
      image_input_tokens?: number;
      image_output_tokens?: number;
      image_request_attempted?: boolean;
      image_request_succeeded?: boolean;
    },
  ): void {
    this.popSlot(entryId);
    this.registry.recordUsage(entryId, usage);
  }

  releaseWithoutCounting(entryId: string): void {
    this.popSlot(entryId);
  }

  /** Clear all slots for an entry (called by facade on status mutations). */
  clearLock(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  clearAllLocks(): void {
    this.acquireLocks.clear();
  }

  setRotationStrategy(name: RotationStrategyName): void {
    this.strategy = getRotationStrategy(name);
    this.rotationState.roundRobinIndex = 0;
  }

  getDistinctPlanAccounts(): Array<{
    planType: string;
    entryId: string;
    token: string;
    accountId: string | null;
  }> {
    const now = new Date();
    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    const available = entries.filter(
      (a: AccountEntry) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        a.planType &&
        (!skipExhausted || !hasReachedCachedQuota(a)),
    );

    const byPlan = new Map<string, AccountEntry[]>();
    for (const a of available) {
      const plan = a.planType!;
      let group = byPlan.get(plan);
      if (!group) {
        group = [];
        byPlan.set(plan, group);
      }
      group.push(a);
    }

    const result: Array<{ planType: string; entryId: string; token: string; accountId: string | null }> = [];
    for (const [plan, group] of byPlan) {
      const selected = this.strategy.select(group, this.rotationState);
      this.pushSlot(selected.id);
      result.push({
        planType: plan,
        entryId: selected.id,
        token: selected.token,
        accountId: selected.accountId,
      });
    }

    return result;
  }
}
