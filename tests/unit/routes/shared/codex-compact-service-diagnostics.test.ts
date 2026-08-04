/**
 * `executeCompactOnly` 的新增诊断日志（排查 19% root compact 静默降级
 * 时补的盲点，见 CHANGELOG）——这些 phase 标记此前完全没有：
 *   - phase=compact_no_account：一开始就没有可用账号
 *   - phase=compact_account_mismatch：跨账号重新 compact 被禁止
 *   - phase=compact_unexpected_error：非 CodexApiError 的意外异常
 *   - phase=compact_abort：上游分类后判定不可重试（含跨账号重试被禁止）
 *   - phase=compact_giveup：重试耗尽账号池后放弃
 *   - phase=account_retry：现在带上 prev_status/tried，不再只有 acct
 *
 * 这里只测"日志确实打印、字段确实对"，不重复 e2e 测试已经覆盖的"请求最终
 * 结果正确"（`tests/e2e/messages.test.ts` 的 "first compact failure safely
 * falls back" 用例）。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CodexApiError } from "@src/proxy/codex-types.js";
import type { CodexCompactRequest } from "@src/proxy/codex-types.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquiredAccount } from "@src/auth/types.js";

vi.mock("@src/routes/shared/proxy-handler-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/routes/shared/proxy-handler-utils.js")>();
  return { ...actual, buildCodexApi: vi.fn() };
});

// executeCompactOnly → staggerIfNeeded(acquired.prevSlotMs, {}, signal) uses
// the DEFAULT deps (not injectable from here), which read getConfig() even
// though prevSlotMs is always null in these fixtures (short-circuits right
// after, no real sleep) — getConfig() still needs a loaded config or it throws.
vi.mock("@src/config.js", () => ({
  getConfig: () => ({ auth: { request_interval_ms: null } }),
}));

const proxyHandlerUtils = await import("@src/routes/shared/proxy-handler-utils.js");
const { executeCompactOnly, CompactServiceError } = await import("@src/routes/shared/codex-compact-service.js");

const buildCodexApiMock = vi.mocked(proxyHandlerUtils.buildCodexApi);

function account(entryId: string, overrides: Partial<AcquiredAccount> = {}): AcquiredAccount {
  return { entryId, token: `token-${entryId}`, accountId: `acct-${entryId}`, prevSlotMs: null, ...overrides };
}

function compactRequest(overrides: Partial<CodexCompactRequest> = {}): CodexCompactRequest {
  return { model: "gpt-5.4", input: [{ type: "message", role: "user", content: [] } as never], instructions: "", ...overrides };
}

/** Minimal AccountPool mock — acquire()/getPoolSummary() are the only members executeCompactOnly touches indirectly via acquireAccount. */
function makePool(acquireResults: Array<AcquiredAccount | null>): AccountPool {
  const acquire = vi.fn();
  for (const r of acquireResults) acquire.mockImplementationOnce(() => r);
  acquire.mockImplementation(() => null); // exhausted after the seeded results
  return {
    acquire,
    release: vi.fn(),
    getPoolSummary: vi.fn(() => ({
      total: 2, active: 0, expired: 0, quota_exhausted: 0, rate_limited: 2, refreshing: 0, disabled: 0, banned: 0,
    })),
    // ★ #81：同一个诊断分支还会调这个补并发槽位维度，mock 需要提供实现。
    diagnoseAcquireFailure: vi.fn(() => ({
      reason: "quota_window",
      concurrencySaturatedCount: 0,
      quotaWindowCount: 2,
      needsHumanCount: 0,
      earliestQuotaResetAt: null,
    })),
    getEntry: vi.fn(() => ({ email: "test@example.com" })),
    // handleCodexApiError 的 429 分支会调用它——不是这个文件要测的行为，
    // 只是让 429 场景能跑通到我们真正关心的那一行日志。
    applyRateLimit429: vi.fn(),
    markStatus: vi.fn(),
  } as unknown as AccountPool;
}

describe("executeCompactOnly diagnostics", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    buildCodexApiMock.mockReset();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("phase=compact_no_account：一开始就没有可用账号，retryCount=0", async () => {
    const pool = makePool([null]);
    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-no-account-1234",
      }),
      // ★ #83：cause 固定值，不经过 classifyCompactUpstreamFailure——从未
      // 联系上游，没有 CodexApiError 可分类。
    ).rejects.toMatchObject({ status: 503, retryCount: 0, cause: "no_account_available" });

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnLines.some((l) => l.includes("phase=compact_no_account") && l.includes("rid=rid-no-a"))).toBe(true);
  });

  it("phase=compact_account_mismatch：requiredEntryId 与实际拿到的账号不一致", async () => {
    const pool = makePool([account("wrong-entry")]);
    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-mismatch-1234",
        requiredEntryId: "required-entry",
      }),
      // ★ #83：同样是固定值——池子选中的账号根本不是要求的那个，压根没打
      // 上游，没有上游错误可分类。
    ).rejects.toMatchObject({ status: 409, retryCount: 1, cause: "bound_account_unavailable" });

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warnLines.find((l) => l.includes("phase=compact_account_mismatch"));
    expect(line).toBeDefined();
    // 账号标识必须是审计哈希，不能是明文 entryId。
    expect(line).not.toContain("wrong-entry");
    expect(line).not.toContain("required-entry");
  });

  it("phase=compact_unexpected_error：非 CodexApiError 的异常单独打标，且 message 已脱敏截断", async () => {
    const pool = makePool([account("e1")]);
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockRejectedValue(new TypeError("boom: cannot read property of undefined")),
    } as never);

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-unexpected-1234",
      }),
    ).rejects.toThrow("boom");

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warnLines.find((l) => l.includes("phase=compact_unexpected_error"));
    expect(line).toBeDefined();
    expect(line).toContain("error_name=TypeError");
    expect(line).toContain("boom");
  });

  it("phase=compact_abort：上游分类为不可重试（4xx 非白名单），不进入重试循环", async () => {
    const pool = makePool([account("e1")]);
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockRejectedValue(new CodexApiError(400, "invalid request")),
    } as never);

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-abort-1234",
      }),
    ).rejects.toMatchObject({ status: 400 });

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warnLines.find((l) => l.includes("phase=compact_abort"));
    expect(line).toBeDefined();
    expect(line).toContain("reason=non_retryable");
    expect(line).toContain("status=400");
    expect(line).toContain("tried=1");
  });

  it("phase=compact_abort：requiredEntryId 设置时跨账号重试被禁止，即便上游错误本身可重试", async () => {
    const pool = makePool([account("e1")]);
    buildCodexApiMock.mockReturnValue({
      // 429 按 handleCodexApiError 的分类本来是 action:"retry"（换个账号
      // 重试），但 requiredEntryId 已设置，短路成立即放弃，不走重试。
      // （特意避开 500-599：那个区间会先被 withRetry 自己的重试逻辑吃掉，
      // 引入真实的 backoff 延迟，拖慢测试且偏离这里要测的分支。）
      createCompactResponse: vi.fn().mockRejectedValue(new CodexApiError(429, "rate limited")),
    } as never);

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-cross-1234",
        requiredEntryId: "e1",
      }),
      // ★ #83（本次要保留下来的信息）：跨账号闸门把 message/status 都改写
      // 成通用文案+409 了，但 cause 必须仍然是从原始 429 独立分类出来的
      // "rate_limited"，不是被闸门吞掉之后再猜一个"account_failed"之类的
      // 笼统值——这正是 P1 场景本身要解决的问题。
    ).rejects.toMatchObject({ status: 409, retryCount: 1, cause: "rate_limited" });

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warnLines.find((l) => l.includes("phase=compact_abort"));
    expect(line).toBeDefined();
    expect(line).toContain("reason=cross_account_retry_disabled");
  });

  it("phase=compact_giveup：重试耗尽账号池后放弃，tried 反映实际尝试过的账号数", async () => {
    const pool = makePool([account("e1"), account("e2"), null]);
    const createCompactResponse = vi.fn()
      .mockRejectedValueOnce(new CodexApiError(429, "rate limited"))
      .mockRejectedValueOnce(new CodexApiError(429, "rate limited"));
    buildCodexApiMock.mockReturnValue({ createCompactResponse } as never);

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-giveup-1234",
      }),
      // ★ #83：耗尽重试放弃时同样带上最后一次失败的 cause，供事后区分
      // "账号池太小一次就放弃" vs "轮了好几个账号，都是同一类上游故障"。
    ).rejects.toMatchObject({ retryCount: 2, cause: "rate_limited" });

    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    const line = warnLines.find((l) => l.includes("phase=compact_giveup"));
    expect(line).toBeDefined();
    expect(line).toContain("tried=2");
  });

  it("phase=account_retry：现在带上 prev_status 和 tried，不只是 acct", async () => {
    const pool = makePool([account("e1"), account("e2")]);
    const createCompactResponse = vi.fn()
      .mockRejectedValueOnce(new CodexApiError(429, "rate limited"))
      .mockResolvedValueOnce({ output: [{ type: "message" }] });
    buildCodexApiMock.mockReturnValue({ createCompactResponse } as never);

    const result = await executeCompactOnly({
      accountPool: pool,
      compactRequest: compactRequest(),
      signal: new AbortController().signal,
      requestId: "rid-retry-1234",
    });
    expect(result.entryId).toBe("e2");

    const logLines = logSpy.mock.calls.map((c) => String(c[0]));
    const line = logLines.find((l) => l.includes("phase=account_retry"));
    expect(line).toBeDefined();
    expect(line).toContain("prev_status=429");
    expect(line).toContain("tried=2");
  });

  // ★ #83：classifyCompactUpstreamFailure 覆盖 handleCodexApiError 的其余
  // 分支——都走 requiredEntryId 短路（跟上面 429 的用例同一个分支），单独
  // 验证 cause 而不是重复断言 crossAccountBlocked 本身的行为（那部分已经
  // 在上面测过）。避开 500-599（会被 withRetry 自己的重试逻辑吃掉，引入
  // 真实 backoff 延迟）。
  describe("cause 分类覆盖 handleCodexApiError 的其余分支（#83）", () => {
    const cases: Array<{ label: string; status: number; body: string; cause: string }> = [
      { label: "402 quota exhausted", status: 402, body: "quota exceeded", cause: "quota_exhausted" },
      { label: "403 non-CF ban", status: 403, body: "account banned", cause: "account_banned" },
      { label: "401 deactivated", status: 401, body: "account deactivated", cause: "account_deactivated" },
      { label: "401 token invalid（非 deactivated）", status: 401, body: "token invalid", cause: "token_expired" },
      { label: "404 empty body（CF path-block）", status: 404, body: "", cause: "cf_path_block" },
      { label: "status=0 transport failure", status: 0, body: "connection reset", cause: "transport_failure" },
      { label: "400 model not supported", status: 400, body: "model not supported", cause: "model_not_supported" },
      { label: "422 未分类通用错误", status: 422, body: "some unclassified upstream error", cause: "generic_upstream_error" },
    ];

    for (const { label, status, body, cause } of cases) {
      it(`${label} → cause=${cause}`, async () => {
        const pool = makePool([account("e1")]);
        buildCodexApiMock.mockReturnValue({
          createCompactResponse: vi.fn().mockRejectedValue(new CodexApiError(status, body)),
        } as never);

        await expect(
          executeCompactOnly({
            accountPool: pool,
            compactRequest: compactRequest(),
            signal: new AbortController().signal,
            requestId: "rid-cause-classify",
            requiredEntryId: "e1",
          }),
        ).rejects.toMatchObject({ cause });
      });
    }
  });
});
