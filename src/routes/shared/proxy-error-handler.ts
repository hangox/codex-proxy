/**
 * Structured error handler for CodexApiError responses in the proxy handler.
 *
 * Returns an ErrorAction telling the orchestrator whether to retry (acquire
 * a new account) or respond with an error to the client.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import {
  extractRetryAfterSec,
  isBanError,
  isCfChallengeError,
  isCfPathBlockError,
  isQuotaExhaustedError,
  isServerOverloadedError,
  isTokenInvalidError,
  isModelNotSupportedError,
} from "../../proxy/error-classification.js";
import type { CodexApiError } from "../../proxy/codex-types.js";
import type { StatusCode } from "hono/utils/http-status";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import { recordCfPathBlock } from "../../auth/cf-path-block-tracker.js";
import { recordCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import { appendErrorLog } from "../../logs/error-log.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import {
  isPromptTooLongLike,
  normalizePromptTooLongMessage,
  promptTooLongStatus,
} from "../../proxy/prompt-too-long-error.js";
import { auditAccountTag } from "./opaque-compact-audit.js";

/** Consecutive CF path-blocks before the account is auto-disabled. */
const CF_PATH_BLOCK_DISABLE_THRESHOLD = 3;

/** Clamp an HTTP status to a valid error StatusCode, defaulting to 502 for non-error codes. */
export function toErrorStatus(status: number): StatusCode {
  return (status >= 400 && status < 600 ? status : 502) as StatusCode;
}

export type ErrorAction =
  | { action: "respond"; status: number; message: string; errorBody?: string }
  | {
      action: "retry";
      releaseBeforeRetry?: boolean;
      markModelRetried?: boolean;
      /** Fallback status/message when no retry account is available. */
      status: number;
      message: string;
      /** Use format429 instead of formatError for the fallback response. */
      useFormat429?: boolean;
    };

/**
 * Classify a CodexApiError and mutate pool state accordingly.
 *
 * Returns an ErrorAction instructing the proxy-handler orchestrator on
 * what to do next.
 *
 * @param err           The CodexApiError from upstream
 * @param pool          AccountPool for status mutations
 * @param entryId       Current account entry ID
 * @param model         Requested model name
 * @param tag           Route tag for logging
 * @param modelRetried  Whether model-not-supported retry has already been attempted
 * @param cookieJar     该账号的 cookie jar。**必须显式传**（可以传 undefined，
 *                      顶层确实可能没有）——传 undefined 和「忘了传」在语义上
 *                      完全不同，但在调用点长得一模一样，所以这里刻意去掉了
 *                      `?`，让「忘了传」变成编译错误。
 *                      漏传的后果不是报错而是**静默降级**：Cloudflare
 *                      path-block 分支里是 `cookieJar?.clear(entryId)`，可选链
 *                      会把它变成 no-op，而紧跟着的 "cleared cookies and
 *                      retrying..." 日志照打——日志说清了、实际没清。
 *                      `/v1/responses/compact` 就这么漏了很久。
 * @param safeLog       是否按隐私合同抑制明文账号标识/邮箱。**必须显式传**，
 *                      不给默认值：它不是「可有可无的开关」，而是一个需要
 *                      调用方明确表态的合同。opaque compact 相关路径传 true；
 *                      普通代理路由传 false（那是既有的正确行为，不要因为
 *                      "看起来更安全" 就改成 true，会改变日志语义）。
 */
export function handleCodexApiError(
  err: CodexApiError,
  pool: AccountPool,
  entryId: string,
  model: string,
  tag: string,
  modelRetried: boolean,
  cookieJar: CookieJar | undefined,
  safeLog: boolean,
): ErrorAction {
  // safeLog 用于 opaque compact 等受隐私合同约束的调用方：这些路径的审计日志
  // 不得出现明文账号标识或邮箱。此前 safeLog 只隐藏 err.message，entryId/email
  // 仍然逐条泄漏在每个错误分支里。
  //
  // ★ 口径调整（排查 19% root compact 静默降级时发现）：safeLog 原来把
  // err.message **整段**吞掉（见下面 console.error），而不只是账号标识——
  // 后果是 opaque compact 遇到 transport 层异常（`CodexApiError(0, msg)`，
  // 比如超时/连接重置/TLS 失败）时，日志里只剩 `status=0`，连是哪一类
  // 网络故障都分不出来。err.message 本身不是凭据（它要么是上游错误分类
  // 文案，要么是 Node 网络层异常文案），账号标识才是这里真正需要保密的
  // 东西——两者被同一个开关误绑在一起。改法：message 一律打印（不再受
  // safeLog 控制），但先过 `sanitizeFreeTextForLog`（marker 值级脱敏 +
  // 截断，理由见 opaque-compact-fallback-log.ts 头部注释），账号标识
  // 仍然受 safeLog 控制、原样不变。
  const email = pool.getEntry(entryId)?.email ?? "?";
  const acct = safeLog ? `acct=${auditAccountTag(entryId)}` : `Account ${entryId} (${email})`;
  const acctShort = safeLog ? `acct=${auditAccountTag(entryId)}` : `Account ${entryId}`;

  if (isPromptTooLongLike(err.body) || isPromptTooLongLike(err.message)) {
    const status = promptTooLongStatus(err.status);
    const message = normalizePromptTooLongMessage(err.body || err.message);
    return { action: "respond", status, message };
  }

  // 1. Model not supported on this account's plan
  if (isModelNotSupportedError(err)) {
    if (!modelRetried) {
      console.warn(
        `[${tag}] ${acct} | Model "${model}" not supported, trying different account...`,
      );
      const fallbackStatus = toErrorStatus(err.status);
      return {
        action: "retry", releaseBeforeRetry: true, markModelRetried: true,
        status: fallbackStatus, message: err.message,
      };
    }
    const status = toErrorStatus(err.status);
    return { action: "respond", status, message: err.message };
  }

  console.error(
    `[${tag}] ${acctShort} | Codex API error status=${err.status}` +
      ` message=${sanitizeFreeTextForLog(err.message)}`,
  );

  // 2. Rate-limited — write into cachedQuota.rate_limit (single source of
  // truth). applyRateLimit429 internally never shrinks an existing reset_at,
  // so a fresh secondary-window lock survives a stale primary 429.
  if (err.status === 429) {
    const retryAfterSec = extractRetryAfterSec(err.body);
    pool.applyRateLimit429(entryId, { retryAfterSec, countRequest: true });
    const backoffDisplay = retryAfterSec != null ? Math.round(retryAfterSec) : null;
    console.warn(
      `[${tag}] ${acct} | 429 rate limited` +
        (backoffDisplay != null ? ` (resets in ${backoffDisplay}s)` : "") +
        `, trying different account...`,
    );
    return { action: "retry", status: 429, message: err.message, useFormat429: true };
  }

  // 3. Quota exhausted (402 Payment Required)
  if (isQuotaExhaustedError(err)) {
    pool.markStatus(entryId, "quota_exhausted");
    console.warn(
      `[${tag}] ${acct} | 402 quota exhausted, trying different account...`,
    );
    return { action: "retry", status: 402, message: err.message };
  }

  // 503 server capacity — transient upstream condition. Retry on another
  // account when available, but do not mutate account health or quota state.
  if (isServerOverloadedError(err)) {
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 503 server overloaded, trying different account...`,
    );
    return {
      action: "retry",
      releaseBeforeRetry: true,
      status: 503,
      message: err.message,
    };
  }

  // 4. Cloudflare challenge (403 HTML/challenge response) — cooldown, not ban.
  if (isCfChallengeError(err)) {
    const cooldown = recordCfChallengeCooldown(entryId);
    console.warn(
      `[${tag}] ${acct} | Cloudflare challenge 403, ` +
        `cooling down for ${cooldown.delaySeconds}s and trying different account...`,
    );
    return {
      action: "retry",
      releaseBeforeRetry: true,
      status: 502,
      message: "Upstream blocked the request (Cloudflare challenge)",
    };
  }

  // 5. Ban (non-Cloudflare 403)
  if (isBanError(err)) {
    pool.markStatus(entryId, "banned");
    console.warn(
      `[${tag}] ${acct} | 403 banned, trying different account...`,
    );
    return { action: "retry", status: 403, message: err.message };
  }

  // 6. Token invalidated / account deactivated
  if (isTokenInvalidError(err)) {
    const isDeactivated = err.message.toLowerCase().includes("deactivated");
    const newStatus = isDeactivated ? "banned" : "expired";
    pool.markStatus(entryId, newStatus);
    console.warn(
      `[${tag}] ${acct} | 401 ${isDeactivated ? "deactivated (banned)" : "token invalidated"}, trying different account...`,
    );
    return { action: "retry", status: 401, message: err.message };
  }

  // 7. Cloudflare path block (empty-body 404). CF's Bot Management can
  //    "hide" the /codex/responses path by returning 404 with no body when
  //    the captured __cf_bm cookie no longer matches the request
  //    fingerprint. Clear the cookie jar (so the next attempt is a clean,
  //    fingerprint-only request) and retry on a different account. After
  //    the threshold is reached within the sliding window, disable the
  //    account so session affinity stops pinning a dying conversation to
  //    it.
  if (isCfPathBlockError(err)) {
    cookieJar?.clear(entryId);
    const blockCount = recordCfPathBlock(entryId);
    if (blockCount >= CF_PATH_BLOCK_DISABLE_THRESHOLD) {
      pool.markStatus(entryId, "disabled");
      console.warn(
        `[${tag}] ${acct} | Cloudflare path-block 404 ×${blockCount} — auto-disabling account`,
      );
      appendErrorLog({
        source: "server",
        error: {
          name: "CfPathBlockAutoDisable",
          message: `Account auto-disabled after ${blockCount} consecutive Cloudflare path-block 404s on /codex/responses`,
        },
        // safeLog 路径同样不能把明文账号写进持久化错误日志。
        context: safeLog
          ? { acct: auditAccountTag(entryId), model, tag, blockCount }
          : { entryId, email, model, tag, blockCount },
      });
    } else {
      console.warn(
        `[${tag}] ${acct} | Cloudflare path-block 404 ×${blockCount}, cleared cookies and retrying...`,
      );
    }
    return {
      action: "retry",
      releaseBeforeRetry: true,
      status: 502,
      message: "Upstream blocked the request (Cloudflare path-block)",
    };
  }

  // 8. Generic error — return to client (preserve original body for passthrough)
  const status = toErrorStatus(err.status);
  return { action: "respond", status, message: err.message, errorBody: err.body };
}
