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
    ).rejects.toMatchObject({ status: 503, retryCount: 0 });

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
    ).rejects.toMatchObject({ status: 409, retryCount: 1 });

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
    ).rejects.toMatchObject({ status: 409, retryCount: 1 });

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
    ).rejects.toMatchObject({ retryCount: 2 });

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
});
