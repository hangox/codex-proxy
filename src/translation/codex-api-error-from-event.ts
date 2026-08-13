import { CodexApiError } from "../proxy/codex-types.js";
import {
  buildPromptTooLongErrorBody,
  isPromptTooLongLike,
  promptTooLongStatus,
} from "../proxy/prompt-too-long-error.js";

/**
 * Convert an upstream `error` / `response.failed` SSE event into a CodexApiError
 * with an HTTP-equivalent status. Used by the non-streaming collectors so the
 * proxy's catch path can run the same recovery logic (strip + retry) it would
 * have used for an HTTP-layer 4xx, instead of falling through as 502.
 */
export function codexApiErrorFromEvent(
  err: { code: string; message: string },
): CodexApiError {
  const raw = JSON.stringify({ error: { code: err.code, message: err.message } });
  const promptTooLong = isPromptTooLongLike(raw);
  const status = promptTooLong ? promptTooLongStatus(statusForCode(err.code)) : statusForCode(err.code);
  const body = promptTooLong
    ? buildPromptTooLongErrorBody(raw)
    : JSON.stringify({
        error: { type: err.code, code: err.code, message: err.message },
      });
  return new CodexApiError(status, body);
}

function statusForCode(code: string): number {
  const lower = code.toLowerCase();
  if (lower.includes("context_length")) return 400;
  // `invalid_value` / `unsupported_value` 是上游对**请求内容**的校验错误，
  // 语义上就是 400。此前它们不在这张表里、落到兜底的 502——而 502 落在
  // withRetry 的可重试区间，等于把一个「重发多少次都一样」的参数错误重试
  // 3 次。这两个 code 是 Responses 流里真实会出现的形态（例如
  // `Invalid value for 'input': ...`），不是假想的。
  // 注意保持这一行在 invalid_api_key 判断之前不会误伤：那个 code 既不含
  // invalid_request 也不含 invalid_value，仍然会正确落到 401。
  if (
    lower.includes("invalid_request")
    || lower.includes("invalid_value")
    || lower.includes("unsupported_value")
    || lower.includes("not_found")
  ) return 400;
  if (lower.includes("rate_limit") || lower.includes("usage_limit")) return 429;
  if (lower.includes("unauthorized") || lower.includes("invalid_api_key")) return 401;
  if (lower.includes("forbidden") || lower.includes("banned")) return 403;
  if (lower.includes("payment") || lower.includes("quota")) return 402;
  return 502;
}
