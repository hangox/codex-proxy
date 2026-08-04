import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireAccount, releaseAccount } from "@src/routes/shared/account-acquisition.js";

/* ── Minimal mock types matching AccountPool interface ── */
interface MockPool {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  getEntry: ReturnType<typeof vi.fn>;
  getPoolSummary: ReturnType<typeof vi.fn>;
  diagnoseAcquireFailure: ReturnType<typeof vi.fn>;
}

const DEFAULT_POOL_SUMMARY = {
  total: 3,
  active: 0,
  expired: 1,
  quota_exhausted: 0,
  rate_limited: 2,
  refreshing: 0,
  disabled: 0,
  banned: 0,
};

const DEFAULT_DIAGNOSIS = {
  reason: "needs_human" as const,
  concurrencySaturatedCount: 0,
  quotaWindowCount: 0,
  needsHumanCount: 1,
  earliestQuotaResetAt: null,
};

function createMockPool(): MockPool {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    getEntry: vi.fn(),
    // 排查 19% root compact 静默降级新加的诊断分支——"没有可用账号"时
    // acquireAccount 会调用它拼一行池状态构成的 warn，mock 需要提供实现。
    getPoolSummary: vi.fn().mockReturnValue(DEFAULT_POOL_SUMMARY),
    // ★ #81：并发槽位打满会让 active=1 这类聚合计数看起来"健康"却拿不到
    // 账号——diagnoseAcquireFailure 补上这一维，同样只在失败冷路径调用。
    diagnoseAcquireFailure: vi.fn().mockReturnValue(DEFAULT_DIAGNOSIS),
  };
}

describe("acquireAccount", () => {
  let pool: MockPool;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("delegates to pool.acquire with model and excludeIds", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: "a1" });

    const result = acquireAccount(pool as never, "gpt-5.4", ["x1"], "OpenAI");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: ["x1"], preferredEntryId: undefined });
    expect(result).toEqual({ entryId: "e1", token: "t1", accountId: "a1" });
  });

  it("passes preferredEntryId for session affinity", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: "a1" });

    acquireAccount(pool as never, "gpt-5.4", undefined, "OpenAI", "e1");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: undefined, preferredEntryId: "e1" });
  });

  it("returns null when pool has no available account", () => {
    pool.acquire.mockReturnValue(null);

    const result = acquireAccount(pool as never, "gpt-5.4", [], "OpenAI");

    expect(result).toBeNull();
  });

  it("no-account warn includes pool summary breakdown and already-tried count, not just \"no account\"", () => {
    pool.acquire.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      acquireAccount(pool as never, "gpt-5.4", ["e1", "e2"], "OpenAI");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = String(warnSpy.mock.calls[0]![0]);
      expect(line).toContain('No available account for model "gpt-5.4"');
      expect(line).toContain("excluded 2 already-tried");
      expect(line).toContain("total=3");
      expect(line).toContain("active=0");
      expect(line).toContain("rate_limited=2");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("★ #81: no-account warn includes the diagnosis breakdown (reason + per-bucket counts), not just the status-blind pool summary", () => {
    pool.acquire.mockReturnValue(null);
    pool.diagnoseAcquireFailure.mockReturnValue({
      reason: "concurrency_saturated",
      concurrencySaturatedCount: 1,
      quotaWindowCount: 0,
      needsHumanCount: 0,
      earliestQuotaResetAt: null,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      acquireAccount(pool as never, "gpt-5.4", ["e1"], "OpenAI");

      expect(pool.diagnoseAcquireFailure).toHaveBeenCalledWith({ excludeIds: ["e1"], model: "gpt-5.4" });
      const line = String(warnSpy.mock.calls[0]![0]);
      expect(line).toContain("diagnosis: reason=concurrency_saturated");
      expect(line).toContain("concurrency_saturated=1");
      expect(line).toContain("quota_window=0");
      expect(line).toContain("needs_human=0");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("no-account warn is silent (no getPoolSummary/diagnoseAcquireFailure call, no throw) when tag is omitted", () => {
    pool.acquire.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = acquireAccount(pool as never, "gpt-5.4");
      expect(result).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(pool.getPoolSummary).not.toHaveBeenCalled();
      expect(pool.diagnoseAcquireFailure).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("passes empty excludeIds by default", () => {
    pool.acquire.mockReturnValue({ entryId: "e1", token: "t1", accountId: null });

    acquireAccount(pool as never, "gpt-5.4", undefined, "OpenAI");

    expect(pool.acquire).toHaveBeenCalledWith({ model: "gpt-5.4", excludeIds: undefined, preferredEntryId: undefined });
  });
});

describe("releaseAccount", () => {
  let pool: MockPool;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("delegates to pool.release with entryId and usage", () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    releaseAccount(pool as never, "e1", usage);

    expect(pool.release).toHaveBeenCalledWith("e1", usage);
  });

  it("releases without usage when not provided", () => {
    releaseAccount(pool as never, "e1");

    expect(pool.release).toHaveBeenCalledWith("e1", undefined);
  });

  it("is idempotent — second call with same entryId is a no-op", () => {
    const guard = new Set<string>();

    releaseAccount(pool as never, "e1", undefined, guard);
    releaseAccount(pool as never, "e1", undefined, guard);

    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("releases different entryIds independently", () => {
    const guard = new Set<string>();

    releaseAccount(pool as never, "e1", undefined, guard);
    releaseAccount(pool as never, "e2", undefined, guard);

    expect(pool.release).toHaveBeenCalledTimes(2);
  });
});
