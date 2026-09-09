/**
 * Shared error classification utilities for CodexApiError responses.
 *
 * Used by proxy-handler (request path) and account routes (single-account quota).
 *
 * Uses duck-typing ({ status, body, message }) instead of instanceof to stay
 * compatible with vi.mock'd CodexApiError in integration tests.
 */

interface CodexLikeError {
  status: number;
  body: string;
  message: string;
  headers?: unknown;
}

function isCodexLike(err: unknown): err is CodexLikeError {
  if (!(err instanceof Error)) return false;
  const rec = err as unknown as Record<string, unknown>;
  return typeof rec.status === "number" && typeof rec.body === "string";
}

function headersToLowerHaystack(headers: unknown): string {
  if (!(headers instanceof Headers)) return "";
  const parts: string[] = [];
  headers.forEach((value, key) => {
    parts.push(key, value);
  });
  return parts.join(" ").toLowerCase();
}

/** Extract the rate-limit reset duration from a 429 error body, if available. */
export function extractRetryAfterSec(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    if (!error) return undefined;
    if (typeof error.resets_in_seconds === "number" && error.resets_in_seconds > 0) {
      return error.resets_in_seconds;
    }
    if (typeof error.resets_at === "number" && error.resets_at > 0) {
      const diff = error.resets_at - Date.now() / 1000;
      return diff > 0 ? diff : undefined;
    }
  } catch { /* use default backoff */ }
  return undefined;
}

/** Check if a 402 Payment Required indicates the account's quota/subscription is exhausted. */
export function isQuotaExhaustedError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  return err.status === 402;
}

/** Check if a 503 is the upstream capacity error that is safe to retry. */
export function isServerOverloadedError(err: unknown): boolean {
  if (!isCodexLike(err) || err.status !== 503) return false;
  try {
    const parsed = JSON.parse(err.body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    return error?.code === "server_is_overloaded";
  } catch {
    return false;
  }
}

/** Check if a 403 body is a Cloudflare challenge rather than an account ban. */
export function isCfChallengeError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  if (err.status !== 403) return false;
  const haystack = `${err.body.toLowerCase()} ${headersToLowerHaystack(err.headers)}`;
  return (
    haystack.includes("cf-mitigated") ||
    haystack.includes("cf-chl-bypass") ||
    haystack.includes("_cf_chl") ||
    haystack.includes("cf_chl") ||
    haystack.includes("attention required") ||
    haystack.includes("just a moment")
  );
}

/** Check if an error indicates the account is banned/suspended (non-CF 403). */
export function isBanError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  if (err.status !== 403) return false;
  if (isCfChallengeError(err)) return false;
  const body = err.body.toLowerCase();
  if (body.includes("<!doctype") || body.includes("<html")) return false;
  return true;
}

/** Check if an error is a 401 token invalidation (revoked/expired upstream). */
export function isTokenInvalidError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  return err.status === 401;
}

/**
 * Check if an error indicates the upstream account does not recognize the
 * `previous_response_id` referenced in the request (response was created by
 * a different account, expired upstream, or the local affinity map was lost).
 *
 * Detects either:
 *  - structured `code: "previous_response_not_found"` in the error body, or
 *  - the human-readable "Previous response with id ... not found" message.
 */
export function isPreviousResponseNotFoundError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  try {
    const parsed = JSON.parse(err.body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    if (error && typeof error.code === "string" && error.code === "previous_response_not_found") {
      return true;
    }
  } catch { /* fall through to message check */ }
  const lower = (err.body + " " + err.message).toLowerCase();
  return lower.includes("previous_response_not_found")
    || (lower.includes("previous response with id") && lower.includes("not found"));
}

/** Check if a previous_response_id WebSocket failure happened before any data
 *  was streamed, so the request may be safely replayed once after stripping the
 *  stale previous_response_id / turnState. */
export function isRecoverablePreConnectWebSocketError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const rec = err as unknown as Record<string, unknown>;
  return rec.name === "PreviousResponseWebSocketError"
    && rec.phase === "pre-connect"
    && rec.recoverable === true;
}

/**
 * Check if an error indicates a stored function_call from the previous response
 * was not answered with a function_call_output in the current request. Upstream
 * surfaces this as 400 with message "No tool output found for function call call_X".
 */
export function isUnansweredFunctionCallError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  if (err.status !== 400) return false;
  const haystack = (err.body + " " + err.message).toLowerCase();
  return haystack.includes("no tool output found for function call");
}

/**
 * Detects Cloudflare path-level bot blocks that surface as empty-body 404s.
 *
 * Cloudflare's Bot Management can "hide" a guarded path (e.g. /codex/responses)
 * by returning 404 with no body when the session's __cf_bm cookie or
 * fingerprint no longer matches what it issued — this is its standard
 * "stealth deny" pattern (more deniable than 403). The distinguishing
 * signal is the empty body: real Codex 404s from upstream always carry a
 * JSON error payload.
 */
export function isCfPathBlockError(err: unknown): boolean {
  if (!isCodexLike(err)) return false;
  if (err.status !== 404) return false;
  return err.body.trim().length === 0;
}

/**
 * Upstream WS terminal-error `code` → HTTP-equivalent status allowlist.
 *
 * Shared by ws-transport.ts（一次性 / 不入池的 WS）和 ws-pool.ts（复用连接
 * 池的 WS）——两条路径需要对同一批上游 code 是否安全轮换/重试达成一致。
 * 此前这两个文件各自维护一份，ws-pool.ts 里甚至专门写了注释"Same allowlist
 * as ws-transport.ts. Duplicated here intentionally"，但两份表实际已经
 * 各自漂移：ws-transport.ts 独有 `server_error`/`internal_error`/
 * `internal_server_error`（502）三个分支，ws-pool.ts 独有
 * `websocket_connection_limit_reached`（503）——不是有意为之的差异，就是
 * 改一处忘了改另一处。
 *
 * 两个文件之间没有真正的循环依赖或运行上下文隔离约束（ws-pool.ts 只是
 * `import type` 了 ws-transport.ts 的类型，ws-transport.ts 反过来 import
 * 了 ws-pool.ts 的值——类型导入在编译期会被完全擦除，不构成运行时环，两边
 * 都能安全依赖这个模块），所以直接抽到这里统一维护，不再要求"改一处记得
 * 改另一处"。
 *
 * Exact-match only: a substring rule like `includes("rate_limit")` would
 * also match codes such as `soft_rate_limit_warning` and incorrectly
 * trigger account rotation. Unlisted codes fall through and keep streaming
 * as SSE — the safer default, and downstream `codexApiErrorFromEvent` still
 * gets a chance to classify them from the message text.
 */
export const ROTATABLE_WS_ERROR_CODES: Readonly<Record<string, number>> = {
  // 429 — weekly/primary cap
  usage_limit_reached: 429,
  rate_limit_exceeded: 429,
  rate_limit_reached: 429,
  // 402 — plan/credit exhausted
  quota_exhausted: 402,
  payment_required: 402,
  // 401 — credential rejected upstream
  unauthorized: 401,
  token_invalid: 401,
  token_expired: 401,
  account_deactivated: 401,
  // 403 — account banned
  forbidden: 403,
  account_banned: 403,
  banned: 403,
  // 400 — stale previous_response_id (account doesn't recognise it; let
  // proxy-handler strip the ID and retry on the same account)
  previous_response_not_found: 400,
  context_length_exceeded: 400,
  // 502 — upstream transient server failures. Retryable through the
  // existing proxy-handler flow.
  server_error: 502,
  internal_error: 502,
  internal_server_error: 502,
  // 503 — transient upstream capacity/connection errors
  server_is_overloaded: 503,
  websocket_connection_limit_reached: 503,
};

/** Check if a CodexApiError indicates the model is not supported on the account's plan. */
export function isModelNotSupportedError(err: CodexLikeError): boolean {
  if (err.status < 400 || err.status >= 500 || err.status === 429) return false;
  const lower = err.message.toLowerCase();
  if (!lower.includes("model")) return false;
  return lower.includes("not supported") || lower.includes("not_supported")
    || lower.includes("not available") || lower.includes("not_available");
}

/**
 * Detects deterministic "bad request content" errors that upstream reports
 * at the HTTP layer as a 5xx instead of a 4xx — currently, a tool's JSON
 * Schema using a regex construct (e.g. Unicode property escapes in the
 * built-in Artifact tool's `doc_id` pattern) that upstream's schema
 * validator doesn't accept:
 *   Invalid schema for function 'Artifact': '...' is not a 'regex'.
 * Replaying the exact same request produces the exact same error every
 * time — it's a request-content error, not upstream capacity/availability.
 * Reported as 502, this used to fall into `withRetry`'s 5xx-retryable
 * bucket (and the Claude Code CLI client does the same on its own 502
 * retries), so a request with an offending tool schema would retry forever
 * with exponential backoff and wedge the interactive session — real
 * reproduction: attempt 7/10 and climbing, same 502 every time.
 */
export function isDeterministicSchemaOrParamErrorBody(body: string): boolean {
  return /invalid schema for function/i.test(body);
}

/**
 * Reclassify a raw upstream HTTP error (status + body text) that arrived
 * without a structured error code — the path in `codex-api.ts`'s
 * `createResponseViaHttp()`, which only has the bytes upstream sent back.
 * This mirrors `statusForCode()` in `codex-api-error-from-event.ts`, which
 * does the same "deterministic client error, not a retryable 5xx"
 * reclassification for the SSE `error` / `response.failed` event path
 * (which does have a structured `err.code` to key off). The two paths stay
 * separate functions because they classify different inputs (event code vs.
 * raw body text), but they should agree on which failures are deterministic.
 *
 * Returns the status to actually throw with — 400 in place of whatever 5xx
 * upstream reported — and `retryable: false` so `withRetry` (see
 * `CodexApiError`'s `retryable` option) won't spend more attempts on a
 * request that will fail identically every time. When nothing matches, the
 * original status is returned unchanged and `retryable` is left
 * `undefined`, so a genuine transport 5xx keeps its old status-based retry
 * behavior — this function must never make a real 5xx look non-retryable.
 */
export function classifyRawUpstreamError(
  status: number,
  body: string,
): { status: number; retryable?: boolean } {
  if (isDeterministicSchemaOrParamErrorBody(body)) {
    return { status: 400, retryable: false };
  }
  return { status };
}
