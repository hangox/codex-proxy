import { CodexApiError } from "../proxy/codex-types.js";
import { classifyRawUpstreamError } from "../proxy/error-classification.js";

/**
 * Convert an upstream `error` / `response.failed` SSE event into a CodexApiError
 * with an HTTP-equivalent status. Used by the non-streaming collectors so the
 * proxy's catch path can run the same recovery logic (strip + retry) it would
 * have used for an HTTP-layer 4xx, instead of falling through as 502.
 */
export function codexApiErrorFromEvent(
  err: { code: string; message: string },
): CodexApiError {
  const body = JSON.stringify({
    error: { type: err.code, code: err.code, message: err.message },
  });
  // 这条 SSE/WS 事件路径上，上游有时用一个这里没有归类过的 code 报出「客户端
  // 请求内容确定性有误」的错误——实测过 `invalid_function_parameters`（工具
  // JSON Schema 用了上游校验器不认的正则语法），statusForCode 对未知 code 兜底
  // 502，而 502 落在 withRetry 的可重试区间、也会被 Claude Code 客户端自己的
  // 退避重试放大。复用 classifyRawUpstreamError 对拼好的错误 body 文本做一次兜底
  // 分类——与 codex-api.ts 等原始 HTTP 错误路径共用同一份判据，两条路径不再各自
  // 维护、互相漏覆盖对方命中的形态。
  const status = classifyRawUpstreamError(statusForCode(err.code), body);
  return new CodexApiError(status, body);
}

function statusForCode(code: string): number {
  const lower = code.toLowerCase();
  if (lower === "server_is_overloaded") return 503;
  if (lower === "server_error") return 500;
  if (lower.includes("invalid_request") || lower.includes("not_found")) return 400;
  if (lower.includes("rate_limit") || lower.includes("usage_limit")) return 429;
  if (lower.includes("unauthorized") || lower.includes("invalid_api_key")) return 401;
  if (lower.includes("forbidden") || lower.includes("banned")) return 403;
  if (lower.includes("payment") || lower.includes("quota")) return 402;
  return 502;
}
