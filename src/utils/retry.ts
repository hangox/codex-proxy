import { CodexApiError } from "../proxy/codex-api.js";
import { sanitizeFreeTextForLog } from "../logs/redact.js";

/** Retry a function on 5xx errors with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxRetries = 2,
    baseDelayMs = 1000,
    tag = "Proxy",
    signal,
  }: { maxRetries?: number; baseDelayMs?: number; tag?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof CodexApiError && err.status >= 500 && err.status < 600;
      if (!isRetryable || attempt === maxRetries) {
        // 此前这个分支直接 throw，没有任何"为什么放弃"的痕迹——只有下面
        // "Retrying after..."那一行会打印，而它只在真的要重试时才执行。
        // 不管是"根本不可重试"还是"重试次数耗尽"，都在这里补一行区分。
        const errMessage = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${tag}] giving up after attempt ${attempt + 1}/${maxRetries + 1}` +
            ` (${isRetryable ? "retries exhausted" : "non-retryable"})` +
            ` status=${err instanceof CodexApiError ? err.status : "-"}` +
            ` message=${sanitizeFreeTextForLog(errMessage)}`,
        );
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[${tag}] Retrying after ${err instanceof CodexApiError ? err.status : "error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (!signal) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
    }
  }
  throw lastError;
}
