import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../../auth/account-pool.js";
import type { AcquireFailureDiagnosis } from "../../auth/account-lifecycle.js";
import type { FormatAdapter, ProxyRequest } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";

export interface AccountPoolSummary {
  total: number;
  active: number;
  expired: number;
  quota_exhausted: number;
  rate_limited: number;
  refreshing: number;
  disabled: number;
  banned: number;
}

export interface RespondWithNoAccountOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
  pool: AccountPool;
}

export interface RespondWithProxyErrorOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
  status: number;
  message: string;
  useFormat429?: boolean;
}

export function buildAccountExhaustionDetail(summary: AccountPoolSummary, message: string): string {
  const parts: string[] = [];
  if (summary.rate_limited) parts.push(`${summary.rate_limited} rate-limited`);
  if (summary.expired) parts.push(`${summary.expired} expired`);
  if (summary.banned) parts.push(`${summary.banned} banned`);
  if (summary.disabled) parts.push(`${summary.disabled} disabled`);
  if (summary.quota_exhausted) parts.push(`${summary.quota_exhausted} quota-exhausted`);
  if (summary.refreshing) parts.push(`${summary.refreshing} refreshing`);

  return parts.length
    ? `All accounts exhausted (${parts.join(", ")}). ${message}`
    : `No accounts available. ${message}`;
}

// ★ #81: heuristic Retry-After for the concurrency-saturated bucket. This is
// NOT measured against a real release-time distribution — a slot frees up
// whenever whichever in-flight request holding it finishes, which this
// process has no way to predict. 3 seconds is a "comfortably short, won't
// make an already-impatient client wait needlessly long" guess, nothing
// more. Do not present this number to anyone as a precise ETA.
const CONCURRENCY_RETRY_AFTER_HEURISTIC_SECONDS = 3;

/**
 * ★ #81: Retry-After (seconds) for a self-heal diagnosis, or null if neither
 * self-heal bucket applies (i.e. this is a pure needs_human diagnosis).
 *
 * quota_window gets a REAL value — `earliestQuotaResetAt` comes straight
 * from the account's own `cachedQuota.*.reset_at`, not a guess. When both
 * buckets are non-empty (the "mixed" self-heal case), the quota value wins
 * because it's authoritative; the concurrency heuristic is a fallback for
 * when there's nothing better.
 */
function computeSelfHealRetryAfterSeconds(diag: AcquireFailureDiagnosis): number | null {
  if (diag.quotaWindowCount > 0 && diag.earliestQuotaResetAt != null) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return Math.max(1, diag.earliestQuotaResetAt - nowSeconds);
  }
  if (diag.concurrencySaturatedCount > 0) {
    return CONCURRENCY_RETRY_AFTER_HEURISTIC_SECONDS;
  }
  return null;
}

/**
 * ★ #81: message for the self-heal buckets (concurrency saturated / quota
 * window / a mix of the two, with or without a needs_human component
 * alongside — see the "why mixed still retries" note in respondWithNoAccount).
 * Deliberately does NOT claim "all accounts are expired or rate-limited" —
 * that was the original lying message this whole investigation started
 * from (#81 production incident: single account, 3/3 concurrency slots
 * full, nothing expired or rate-limited, yet that's what the message said).
 */
function buildSelfHealMessage(diag: AcquireFailureDiagnosis): string {
  const parts: string[] = [];
  if (diag.concurrencySaturatedCount > 0) {
    parts.push(`${diag.concurrencySaturatedCount} account(s) at their concurrency limit`);
  }
  if (diag.quotaWindowCount > 0) {
    parts.push(`${diag.quotaWindowCount} account(s) waiting on a quota window`);
  }
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `No account is immediately available${detail}. This is temporary — please retry shortly.`;
}

/**
 * ★ #81: classify why acquire() failed and respond accordingly — replaces
 * the single "No available accounts. All accounts are expired or
 * rate-limited." message that was accurate for a genuinely exhausted pool
 * but actively misleading for a pool that was merely momentarily busy (the
 * #81 production incident: single account, all 3 concurrency slots full,
 * `active=1` — nothing about the account was actually wrong).
 *
 * ★ Deliberately NEVER routes through `streamErrorResponse`/`canReturnStreamError`
 * for either branch, streaming or not — see the doc comment on the
 * `needs_human` branch below for why, and don't "helpfully" restore that
 * branching later without re-reading it.
 *
 * ★ Why a "mixed" diagnosis (some accounts needs_human, others self-healing)
 * still gets the self-heal treatment, not the needs_human one: the buckets
 * answer "would retrying THIS specific attempt help", and if any account in
 * the pool is merely transiently blocked, retrying might succeed once that
 * account frees up or its quota window resets — telling the client to give
 * up (`x-should-retry: false`, `/clear`) would be wrong for that case. The
 * needs_human accounts in a mixed pool are a real operational concern, but
 * that's visible to operators via the diagnosis-enriched warn log in
 * account-acquisition.ts, not something the client-facing response needs to
 * (or safely can, given it's one status code) represent.
 */
export function respondWithNoAccount(options: RespondWithNoAccountOptions): Response {
  // `req` is consulted for `model` only (so the diagnosis can replicate
  // acquire()'s plan-matching narrowing — see AccountLifecycle
  // .diagnoseAcquireFailure's "★ #81 follow-up" comment) — not for
  // req.isStreaming, which this function deliberately never branches on
  // anymore (see the doc comment above).
  const { c, req, fmt, pool } = options;
  const diag = pool.diagnoseAcquireFailure({ model: req.model });

  if (diag.reason === "needs_human") {
    // ★ #81: intentionally real `c.status()` + `c.json()`, never
    // `streamErrorResponse` — even when `req.isStreaming` is true.
    //
    // `streamErrorResponse` never calls `c.status()` at all (see
    // stream-error-response.ts) — the real HTTP status of that path is
    // always 200, with the intended status only embedded in the SSE body.
    // A 200 response is, from the client SDK's transport-level shouldRetry
    // perspective, a *success* — it never even evaluates retry eligibility,
    // so no status code choice made here would have had any effect through
    // that path. This exact problem was already solved once, for a
    // different 409-vs-400 decision, by the #91/#92 fix in messages.ts
    // (lines ~739-745): it also always calls `c.status()` + `c.json()`
    // directly regardless of `req.stream`, and that fix has real production
    // verification with a streaming Claude Code client (134s silent hang →
    // ~150ms, zero silent retries). `streamErrorResponse` keeps its
    // original purpose — reporting an error after the stream has already
    // started and headers are already committed to 200 — which does not
    // describe this function: `respondWithNoAccount` fires before any
    // upstream call is even attempted.
    c.header("x-should-retry", "false");
    c.status(fmt.needsHumanStatus);
    const message = buildAccountExhaustionDetail(
      pool.getPoolSummary(),
      "Run /clear and start a new session, or contact your administrator.",
    );
    return c.json(fmt.formatError(fmt.needsHumanStatus, message));
  }

  const retryAfterSeconds = computeSelfHealRetryAfterSeconds(diag);
  if (retryAfterSeconds != null) {
    c.header("Retry-After", String(retryAfterSeconds));
  }
  c.status(fmt.noAccountStatus);
  return c.json(fmt.formatError(fmt.noAccountStatus, buildSelfHealMessage(diag)));
}

export function respondWithProxyError(options: RespondWithProxyErrorOptions): Response {
  const { c, req, fmt, status, message, useFormat429 = false } = options;
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(c, fmt, status, message);
  }
  c.status(status as StatusCode);
  return c.json(useFormat429 ? fmt.format429(message) : fmt.formatError(status, message));
}
