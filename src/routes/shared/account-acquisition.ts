/**
 * Account acquisition / release helpers for the proxy handler.
 *
 * Wraps AccountPool.acquire/release with logging and idempotent-release guard.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import type { AcquiredAccount } from "../../auth/types.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

/**
 * Acquire an account from the pool for the given model.
 * Returns null when no account is available.
 */
export function acquireAccount(
  pool: AccountPool,
  model: string,
  excludeIds?: string[],
  tag?: string,
  preferredEntryId?: string,
): AcquiredAccount | null {
  const acquired = pool.acquire({ model, excludeIds, preferredEntryId });
  if (!acquired && tag) {
    // 补池状态构成：此前这行只说"没有可用账号"，排查时分不清是池子本来
    // 就空、还是全部限流/封禁、还是这次调用把候选集合排除到只剩零个
    // （retry 循环里 excludeIds 就是"已经试过的账号"）。这些都是聚合计数，
    // 不含任何账号标识，可以直接打。
    const summary = pool.getPoolSummary();
    console.warn(
      `[${tag}] No available account for model "${model}"` +
        ` (excluded ${excludeIds?.length ?? 0} already-tried;` +
        ` pool: total=${summary.total} active=${summary.active} expired=${summary.expired}` +
        ` quota_exhausted=${summary.quota_exhausted} rate_limited=${summary.rate_limited}` +
        ` refreshing=${summary.refreshing} disabled=${summary.disabled} banned=${summary.banned})`,
    );
  }
  return acquired;
}

/**
 * Release an account back to the pool.
 *
 * When a `guard` Set is provided, the release is idempotent:
 * if the entryId has already been released (tracked in the set),
 * the call is silently skipped. This prevents the 7-release-point
 * problem in the old proxy handler.
 */
export function releaseAccount(
  pool: AccountPool,
  entryId: string,
  usage?: UsageInfo,
  guard?: Set<string>,
): void {
  if (guard) {
    if (guard.has(entryId)) return;
    guard.add(entryId);
  }
  pool.release(entryId, usage);
}
