import { describe, it, expect, vi } from "vitest";
import { CodexApiError } from "@src/proxy/codex-api.js";

// Import after mocks if needed — withRetry uses CodexApiError at runtime
import { withRetry } from "@src/utils/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new CodexApiError(500, "Internal"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(400, "Bad Request"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (400)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 429 errors", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(429, "Rate limited"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (429)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new CodexApiError(502, "Bad Gateway"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("Codex API error (502)");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-CodexApiError errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("random"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }))
      .rejects.toThrow("random");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("logs a 'giving up' warning with status when a non-retryable error is thrown immediately", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = vi.fn().mockRejectedValue(new CodexApiError(400, JSON.stringify({ detail: "bad request detail" })));
      await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, tag: "TestTag" })).rejects.toThrow();

      const giveUpLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("giving up"));
      expect(giveUpLine).toBeDefined();
      expect(giveUpLine).toContain("[TestTag]");
      expect(giveUpLine).toContain("non-retryable");
      expect(giveUpLine).toContain("status=400");
      expect(giveUpLine).toContain("bad request detail");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs a 'giving up' warning after retries are exhausted, distinct from the per-attempt retry warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = vi.fn().mockRejectedValue(new CodexApiError(502, "Bad Gateway"));
      await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, tag: "TestTag" })).rejects.toThrow();

      const lines = warnSpy.mock.calls.map((c) => String(c[0]));
      const retryLines = lines.filter((l) => l.includes("Retrying after"));
      const giveUpLines = lines.filter((l) => l.includes("giving up"));
      expect(retryLines.length).toBe(2); // one before each of the 2 retries
      expect(giveUpLines.length).toBe(1); // exactly one, when attempts are truly exhausted
      expect(giveUpLines[0]).toContain("retries exhausted");
      expect(giveUpLines[0]).toContain("attempt 3/3");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("'giving up' warning sanitizes an opaque marker embedded in the error message instead of leaking it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const marker = `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;
      const fn = vi.fn().mockRejectedValue(new CodexApiError(400, marker));
      await expect(withRetry(fn, { maxRetries: 1, baseDelayMs: 1 })).rejects.toThrow();

      const raw = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain("A".repeat(32));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("aborts while waiting in retry backoff", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error("stop retry backoff");
      const fn = vi.fn().mockRejectedValue(new CodexApiError(500, "Internal"));
      const promise = withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
      controller.abort(reason);
      await expect(promise).rejects.toBe(reason);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
