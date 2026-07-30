/**
 * qa 实测：compact 响应带真实 usage（`{input_tokens, input_tokens_details:
 * {cached_tokens}, output_tokens, output_tokens_details:{reasoning_tokens},
 * total_tokens}`），但 `CodexCompactResponse` 此前只声明了 `output`——usage
 * 被自己的类型遮蔽，`executeCompactOnly` 六处 `releaseAccount` 调用全部传
 * `undefined`。同账号同规模复现：1 次 compact 记 `window_request_count +1`、
 * `window_input_tokens +0`；1 次普通请求记 `window_request_count +1`、
 * `window_input_tokens +41756`。影响最大的是按 token 用量决策的账号轮转——
 * compact 重的账号会被系统性低估、持续被选中，直到突然撞限流。
 *
 * 这里不用 `codex-compact-service-diagnostics.test.ts` 那个假 `AccountPool`
 * mock（那个文件只测"日志打印对不对"，`pool.release` 是个 `vi.fn()`，看到
 * 调用参数对不代表底层真的记进去了）。这个文件用**真实** `AccountPool` +
 * 真实 `AccountRegistry`（同 `account-pool.test.ts` 的构造方式），只 mock
 * `buildCodexApi`（网络边界）——断言的是 `pool.getAccounts()[0].usage.window_input_tokens`
 * 这个真实累积出来的数字，不是"某个 mock 被调用过"。这是团队明确要求的
 * 验证形状："必须有一条测试能证明「记进去了」，而不只是「代码改了」"。
 *
 * 六处 `releaseAccount` 调用里只有一处（`for` 循环里 compact 成功返回前）
 * 拿到过真实响应体，其余五处全部在失败/中止/重试分支上，从未有响应体可传，
 * `undefined` 在那五处本来就是对的——这里只测"成功路径确实记了"和
 * "失败路径确实没有凭空记出数字"两类，不重复穷举六个分支各自的日志行为
 * （那是 `codex-compact-service-diagnostics.test.ts` 的范围）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CodexCompactRequest, CodexCompactResponse } from "@src/proxy/codex-types.js";

// ── 与 tests/unit/auth/account-pool.test.ts 相同的构造方式：真实 AccountPool
//    + 真实 AccountRegistry，只隔离 fs/paths/config/jwt-utils/jitter/model-store
//    这些外部边界。──────────────────────────────────────────────
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
      max_concurrent_per_account: 1,
      // executeCompactOnly → staggerIfNeeded 读这个字段；null 短路，不真的睡。
      request_interval_ms: null,
    },
    quota: { skip_exhausted: true },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn(() => ({ email: "test@example.com", chatgpt_plan_type: "free" })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
  jitterInt: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

// executeCompactOnly 的唯一真实网络边界：mock 掉 API 客户端构造，
// createCompactResponse() 直接返回测试构造的 CodexCompactResponse。
vi.mock("@src/routes/shared/proxy-handler-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/routes/shared/proxy-handler-utils.js")>();
  return { ...actual, buildCodexApi: vi.fn() };
});

const { AccountPool } = await import("@src/auth/account-pool.js");
const { executeCompactOnly } = await import("@src/routes/shared/codex-compact-service.js");
const { CodexApiError } = await import("@src/proxy/codex-types.js");
const proxyHandlerUtils = await import("@src/routes/shared/proxy-handler-utils.js");
const buildCodexApiMock = vi.mocked(proxyHandlerUtils.buildCodexApi);

function compactRequest(overrides: Partial<CodexCompactRequest> = {}): CodexCompactRequest {
  return { model: "gpt-5.4", input: [{ type: "message", role: "user", content: [] } as never], instructions: "", ...overrides };
}

describe("executeCompactOnly — compact usage 真实记进账号池统计", () => {
  let pool: InstanceType<typeof AccountPool>;

  beforeEach(() => {
    buildCodexApiMock.mockReset();
    pool = new AccountPool();
    pool.addAccount("token-compact-usage");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功路径：qa 实测的真实 usage 形状（41808/41344/335/0）被完整记进 window_input_tokens/window_output_tokens/window_cached_tokens", async () => {
    const compactResponse: CodexCompactResponse = {
      output: [{ type: "reasoning", encrypted_content: "opaque", summary: [] } as never],
      usage: {
        input_tokens: 41808,
        output_tokens: 335,
        cached_tokens: 41344,
        reasoning_tokens: 0,
      },
    };
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockResolvedValue(compactResponse),
    } as unknown as ReturnType<typeof proxyHandlerUtils.buildCodexApi>);

    const result = await executeCompactOnly({
      accountPool: pool,
      compactRequest: compactRequest(),
      signal: new AbortController().signal,
      requestId: "rid-usage-success-1",
    });
    expect(result.output).toEqual(compactResponse.output);

    const accounts = pool.getAccounts();
    expect(accounts).toHaveLength(1);
    const usage = accounts[0]!.usage;
    // 决定性断言：不是"mock 被调用过"，是真实累积出来的账号池统计——
    // 事故复盘里被系统性低估的正是这几个 window_* 字段。
    expect(usage.window_request_count).toBe(1);
    expect(usage.window_input_tokens).toBe(41808);
    expect(usage.window_output_tokens).toBe(335);
    expect(usage.window_cached_tokens).toBe(41344);
    // 生命周期累计字段（同一批数据，另一条独立统计）同样要对得上。
    expect(usage.input_tokens).toBe(41808);
    expect(usage.output_tokens).toBe(335);
    expect(usage.cached_tokens).toBe(41344);
  });

  it("upstream 省略 usage 字段：不崩、不凭空编数字——加法整段跳过，window_input_tokens 停在初始值 0，不是被写进 41808 那样的假数字", async () => {
    const compactResponse: CodexCompactResponse = {
      output: [{ type: "reasoning", encrypted_content: "opaque", summary: [] } as never],
      // 没有 usage 字段——parseNormalizedHostModelUsage 会返回 undefined，
      // 而不是 codex-api.ts 自己编一个 {input_tokens:0, output_tokens:0}。
    };
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockResolvedValue(compactResponse),
    } as unknown as ReturnType<typeof proxyHandlerUtils.buildCodexApi>);

    // 计数器本身是"累加和"，天生没有"未知"这个状态——token 计数器不管
    // 加不加都是个 number，光看"这次之后是不是 0"分不清"确实没加"和
    // "凭空加了个 0"这两种情况。所以先用一次真实成功的 release 把基线
    // 垫高到一个非零、可辨识的值，再验证"这次之后基线完全没变"——
    // 这才是"加法压根没发生过"的决定性证据，不是巧合等于 0。
    const seed = pool.acquire()!;
    pool.release(seed.entryId, { input_tokens: 999, output_tokens: 111, cached_tokens: 50 });

    await executeCompactOnly({
      accountPool: pool,
      compactRequest: compactRequest(),
      signal: new AbortController().signal,
      requestId: "rid-usage-missing-1",
    });

    const usage = pool.getAccounts()[0]!.usage;
    // request_count 必须仍然 +1（这次请求确实发生了、账号确实被占用过），
    // 但 token 基线一位没变——recordUsage() 收到 usage=undefined 时整段
    // 加法直接跳过（见 account-registry.ts recordUsage 的 `if (usage) {...}`
    // 守卫），不是被写成某个凭空编的数字（哪怕是"看起来无害"的 0）。
    expect(usage.window_request_count).toBe(2);
    expect(usage.window_input_tokens).toBe(999);
    expect(usage.window_output_tokens).toBe(111);
    expect(usage.input_tokens).toBe(999);
  });

  it("失败路径（上游返回不可重试错误）：不记录任何 usage，即便上游错误响应体里恰好带着看起来像 token 数字的内容", async () => {
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockRejectedValue(new CodexApiError(400, "Bad request")),
    } as unknown as ReturnType<typeof proxyHandlerUtils.buildCodexApi>);

    // 同上：先垫一个非零基线，才能区分"没加"和"巧合加了 0"。
    const seed = pool.acquire()!;
    pool.release(seed.entryId, { input_tokens: 777, output_tokens: 88 });

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: new AbortController().signal,
        requestId: "rid-usage-failure-1",
      }),
    ).rejects.toThrow();

    const usage = pool.getAccounts()[0]!.usage;
    // 决定性断言：失败路径 request_count 仍然 +1（账号确实被占用过一次），
    // 但 token 基线原样保留——不能把失败凭空记成"0 token 的成功请求"，
    // 那会让轮转策略误判"这个账号刚才免费用了一次"。
    expect(usage.window_request_count).toBe(2);
    expect(usage.window_input_tokens).toBe(777);
    expect(usage.window_output_tokens).toBe(88);
  });

  it("abort 路径：signal 中止时同样不记录 usage", async () => {
    const controller = new AbortController();
    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }),
    } as unknown as ReturnType<typeof proxyHandlerUtils.buildCodexApi>);

    const seed = pool.acquire()!;
    pool.release(seed.entryId, { input_tokens: 321, output_tokens: 22 });

    await expect(
      executeCompactOnly({
        accountPool: pool,
        compactRequest: compactRequest(),
        signal: controller.signal,
        requestId: "rid-usage-abort-1",
      }),
    ).rejects.toThrow();

    const usage = pool.getAccounts()[0]!.usage;
    expect(usage.window_input_tokens).toBe(321);
  });
});
