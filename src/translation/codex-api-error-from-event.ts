import { CodexApiError } from "../proxy/codex-types.js";
import {
  buildPromptTooLongErrorBody,
  isPromptTooLongLike,
  promptTooLongStatus,
} from "../proxy/prompt-too-long-error.js";
import { classifyRawUpstreamError } from "../proxy/error-classification.js";
import type { UsageInfo } from "./codex-event-extractor.js";

export type CodexApiErrorWithUsage = CodexApiError & {
  usage?: UsageInfo;
  responseId?: string | null;
};

/**
 * Convert an upstream `error` / `response.failed` SSE event into a CodexApiError
 * with an HTTP-equivalent status. Used by the non-streaming collectors so the
 * proxy's catch path can run the same recovery logic (strip + retry) it would
 * have used for an HTTP-layer 4xx, instead of falling through as 502.
 */
export function codexApiErrorFromEvent(
  err: { code: string; message: string },
  usage?: UsageInfo,
  responseId?: string | null,
): CodexApiErrorWithUsage {
  const attachUsage = (error: CodexApiError): CodexApiErrorWithUsage => Object.assign(
    error,
    usage !== undefined ? { usage } : {},
    responseId !== undefined ? { responseId } : {},
  );
  const raw = JSON.stringify({ error: { code: err.code, message: err.message } });
  const promptTooLong = isPromptTooLongLike(raw);
  if (promptTooLong) {
    return attachUsage(new CodexApiError(
      promptTooLongStatus(statusForCode(err.code)),
      buildPromptTooLongErrorBody(raw),
    ));
  }
  const body = JSON.stringify({
    error: { type: err.code, code: err.code, message: err.message },
  });
  // 这条 SSE/WS 事件路径上，上游有时用一个这里没有归类过的 code 报出「客户端
  // 请求内容确定性有误」的错误——实测过 `invalid_function_parameters`（工具
  // JSON Schema 用了上游校验器不认的正则语法），statusForCode 对未知 code
  // 兜底 502，而 502 落在 withRetry 的可重试区间、也会被 Claude Code 客户端
  // 自己的退避重试放大。复用 classifyRawUpstreamError 对拼好的错误 body 文本
  // 做一次兜底分类——它是 codex-api.ts 等原始 HTTP 错误路径已经在用的同一份
  // 判据，两条路径（事件 code 路径 vs. 原始 HTTP body 路径）统一到一起，不再
  // 各自维护一份、互相漏覆盖对方命中的形态。
  const { status, retryable } = classifyRawUpstreamError(statusForCode(err.code), body);
  return attachUsage(new CodexApiError(status, body, { retryable }));
}

function statusForCode(code: string): number {
  const lower = code.toLowerCase();
  if (lower === "server_is_overloaded") return 503;
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
