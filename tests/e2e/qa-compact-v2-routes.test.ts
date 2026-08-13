/**
 * QA 路由级验证：v1/v2 双向兼容（H 组）、重试放大（I 组）、CF path-block（J 组）。
 *
 * 用 @helpers/e2e-setup.js —— 该 helper 里的 v2→v1 翻译层已在 F1 中彻底移除，
 * 所以不再需要单独维护一份「无翻译层」的 QA 专用 harness（两份 helper 会各自
 * 漂移，反而制造新的「验的不是产品」风险）。这里断言的 URL / body / 调用次数
 * 都是产品真正打出去的东西。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
  setClaudeCodeOpaqueCompactExperimental,
  setUpstreamRateLimits,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks, sseChunk } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { installInMemoryOpaqueCompactStateStore } from "@src/routes/shared/opaque-compact-state.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
  entryId: string;
}

let ctx: TestContext;

/** Claude Code 真实的 compact 提示词（与 tests/e2e/messages.test.ts 同源）。 */
const compactPrompt = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
  "This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",
  "Before providing your final summary, wrap your analysis in <analysis> tags and double-check for technical accuracy and completeness.",
  "Your summary should include the following sections:",
  "1. Primary Request and Intent:",
  "2. Key Technical Concepts:",
  "3. Files and Code Sections:",
  "4. Errors and fixes:",
  "5. Problem Solving:",
  "6. All user messages:",
  "7. Pending Tasks:",
  "Additional Instructions: preserve exact technical details.",
  "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
].join("\n");

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();

  const entryId = accountPool.addAccount(createValidJwt({
    accountId: "acct-qa-compact",
    email: "qa-compact@test.com",
    planType: "plus",
  }));

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createResponsesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool, entryId };
}

/** 记录每一次真正打到上游的请求。 */
interface UpstreamCall { url: string; body: Record<string, unknown>; }
let calls: UpstreamCall[] = [];

function recordAndReply(reply: (call: UpstreamCall) => ReturnType<typeof makeTransportResponse>) {
  setTransportPost(async (url, _headers, body) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
    const call = { url, body: parsed };
    calls.push(call);
    return reply(call);
  });
}

/** 一个成功的 v2 compact 流。 */
function v2CompactStream(encrypted = "qa-opaque"): string {
  return sseChunk("response.output_item.done", {
    item: { id: "cmp_qa", type: "compaction", encrypted_content: encrypted },
  }) + sseChunk("response.completed", {
    response: { id: "resp_qa", usage: { input_tokens: 80, output_tokens: 12 } },
  });
}

/** 流里带 N 个 compaction item。 */
function v2StreamWithNCompactions(n: number): string {
  let sse = "";
  for (let i = 0; i < n; i++) {
    sse += sseChunk("response.output_item.done", {
      item: { id: `cmp_${i}`, type: "compaction", encrypted_content: `enc_${i}` },
    });
  }
  return sse + sseChunk("response.completed", {
    response: { id: "resp_qa", usage: { input_tokens: 5, output_tokens: 1 } },
  });
}

function lastInputItem(call: UpstreamCall): unknown {
  return (call.body.input as unknown[] | undefined)?.at(-1);
}

const compactBody = {
  model: "gpt-5.4",
  instructions: "compact this",
  input: [
    { role: "user", content: "first thing I asked" },
    { role: "assistant", content: "some answer" },
    { role: "user", content: "second thing I asked" },
  ],
};

beforeEach(() => {
  resetTransportState();
  installInMemoryOpaqueCompactStateStore();
  calls = [];
  setTransportPost(async () => makeTransportResponse(buildTextStreamChunks("resp_default", "hi")));
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  vi.restoreAllMocks();
});

// ══ H 组：入站契约（外部客户端 → proxy）══════════════════════════

describe("QA-H 入站兼容", () => {
  it("QA-H1 旧客户端打 /v1/responses/compact：端点仍在，对外返回体仍是 {output, usage} 契约", async () => {
    recordAndReply(() => makeTransportResponse(v2CompactStream()));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { output: unknown[]; usage?: Record<string, number> };

    // 对外契约不变
    expect(Array.isArray(json.output)).toBe(true);
    expect(json.output.at(-1)).toMatchObject({ type: "compaction", encrypted_content: "qa-opaque" });
    expect(json.usage).toMatchObject({ input_tokens: 80, output_tokens: 12 });
    // 保留的是 user 消息，assistant 不保留
    expect(JSON.stringify(json.output)).toContain("first thing I asked");
    expect(JSON.stringify(json.output)).not.toContain("some answer");

    // 对内确实走 v2
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(lastInputItem(calls[0])).toEqual({ type: "compaction_trigger" });
  });

  it("QA-H2 新客户端自带 compaction_trigger 打 /v1/responses：proxy 原样透传，不吞不改不报错", async () => {
    recordAndReply(() => makeTransportResponse(v2CompactStream("passthrough-opaque")));

    const res = await ctx.app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: [
          { role: "user", content: "please compact" },
          { type: "compaction_trigger" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    expect(calls).toHaveLength(1);
    // sentinel 必须原样到达上游，且仍在末尾
    expect(lastInputItem(calls[0])).toEqual({ type: "compaction_trigger" });
    expect((calls[0].body.input as unknown[]).filter(
      (i) => (i as { type?: string }).type === "compaction_trigger",
    )).toHaveLength(1);
    // proxy 不得凭空追加第二个 sentinel
    expect(JSON.stringify(calls[0].body).match(/compaction_trigger/g)).toHaveLength(1);
    // 上游的 compaction item 要能原样回到客户端
    expect(text).toContain("passthrough-opaque");
  });

  it("QA-H3 /v1/messages（Anthropic 格式）opaque compact bridge 仍能出 marker 并在下一轮恢复", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    recordAndReply((call) => lastInputItem(call) !== undefined
      && (lastInputItem(call) as { type?: string }).type === "compaction_trigger"
      ? makeTransportResponse(v2CompactStream("bridge-opaque"))
      : makeTransportResponse(buildTextStreamChunks("resp_next", "continued")));

    const compactRes = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claude-code-session-id": "qa-session-h3",
      },
      body: JSON.stringify({
        model: "codex",
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "user", content: "old history" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: compactPrompt },
        ],
      }),
    });

    expect(compactRes.status).toBe(200);
    const compactText = await compactRes.text();
    const marker = compactText
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return (JSON.parse(l.slice(6)) as { delta?: { text?: string } }).delta?.text ?? "";
        } catch { return ""; }
      })
      .join("");

    console.log(`[QA-H3] compact 轮上游调用 ${calls.length} 次，URL=${calls[0]?.url}`);
    console.log(`[QA-H3] 拿到 opaque marker = ${marker.includes("codex-opaque-state:v1")}`);

    // compact 轮：走 v2
    expect(calls[0].url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(lastInputItem(calls[0])).toEqual({ type: "compaction_trigger" });
    expect(marker).toContain("codex-opaque-state:v1");

    // 下一轮：带 marker 回来，应当恢复出 compaction item 而不是重放旧历史
    const replay = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claude-code-session-id": "qa-session-h3",
      },
      body: JSON.stringify({
        model: "codex",
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "assistant", content: marker },
          { role: "user", content: "continue" },
        ],
      }),
    });

    expect(replay.status).toBe(200);
    await replay.text();
    const replayInput = calls[1].body.input as unknown[];
    console.log(`[QA-H3] 恢复轮 input items = ${JSON.stringify(replayInput).slice(0, 200)}`);
    expect(replayInput).toContainEqual(expect.objectContaining({
      type: "compaction",
      encrypted_content: "bridge-opaque",
    }));
    expect(JSON.stringify(replayInput)).not.toContain("old answer");
  });
});

// ══ I 组：重试放大（reviewer F2 blocker）═════════════════════════

describe("QA-I 重试放大：v2 的 502 不该被 withRetry 当成可重试的传输错误", () => {
  it("QA-I1 上游返回 0 个 compaction item → 上游只能被请求 1 次", async () => {
    recordAndReply(() => makeTransportResponse(
      sseChunk("response.output_item.done", { item: { type: "message", role: "assistant", content: [] } })
      + sseChunk("response.completed", { response: { id: "r", usage: { input_tokens: 5, output_tokens: 1 } } }),
    ));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    console.log(`[QA-I1] status=${res.status} 上游实际请求次数=${calls.length}`);
    expect(calls.length).toBe(1);
  });

  it("QA-I2 上游返回 2 个 compaction item → 上游只能被请求 1 次", async () => {
    recordAndReply(() => makeTransportResponse(v2StreamWithNCompactions(2)));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    console.log(`[QA-I2] status=${res.status} 上游实际请求次数=${calls.length}`);
    expect(calls.length).toBe(1);
  });

  it("QA-I3 stream 提前 EOF（无 response.completed）→ 上游只能被请求 1 次", async () => {
    recordAndReply(() => makeTransportResponse(
      sseChunk("response.output_item.done", {
        item: { id: "cmp", type: "compaction", encrypted_content: "enc" },
      }),
    ));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    console.log(`[QA-I3] status=${res.status} 上游实际请求次数=${calls.length}`);
    expect(calls.length).toBe(1);
  });

  it("QA-I4 客户端 abort 后，withRetry 不得在 sleep 醒来后继续打上游", async () => {
    const controller = new AbortController();
    let seen = 0;
    setTransportPost(async (url, _h, body) => {
      seen += 1;
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
      calls.push({ url, body: parsed });
      // 第一次上游请求返回可重试的 5xx，同时客户端在这一刻挂断
      if (seen === 1) controller.abort();
      return makeErrorTransportResponse(503, JSON.stringify({ error: { message: "boom" } }));
    });

    await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
      signal: controller.signal,
    }).catch(() => { /* abort 会让 fetch 侧抛错，这里只关心上游调用次数 */ });

    // 给 withRetry 的 backoff（1s / 2s）留出足够时间证明它没有醒来再打
    await new Promise((r) => setTimeout(r, 3500));
    console.log(`[QA-I4] abort 后上游总请求次数=${calls.length}`);
    expect(calls.length).toBe(1);
  });

  it("QA-I5 对照组：真正的上游 5xx 仍然可以重试（别修过头）", async () => {
    recordAndReply(() => makeErrorTransportResponse(
      503, JSON.stringify({ error: { message: "upstream temporarily unavailable" } }),
    ));

    await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    console.log(`[QA-I5] 真实 5xx 的上游请求次数=${calls.length}`);
    expect(calls.length).toBeGreaterThan(1);
  });
});

// ══ J 组：CF path-block 自愈（reviewer F3 major）═════════════════

describe("QA-J CF path-block（空 body 404）不该被吞成 v2 unavailable", () => {
  it("QA-J1/J2 空 body 404 → 应走 CF 恢复路径（清 cookie jar），且不得白调一次 v1", async () => {
    // cookie jar 按 entryId 分区，不是 accountId —— 用错 key 会误判成「没清」
    ctx.cookieJar.set(ctx.entryId, { __cf_bm: "stale-token" });
    expect(ctx.cookieJar.get(ctx.entryId)).toMatchObject({ __cf_bm: "stale-token" });

    recordAndReply(() => makeErrorTransportResponse(404, ""));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    const v1Calls = calls.filter((c) => c.url.includes("/codex/responses/compact"));
    const cookiesAfter = ctx.cookieJar.get(ctx.entryId);
    console.log(`[QA-J] status=${res.status} 全部上游调用=${JSON.stringify(calls.map((c) => c.url))}`);
    console.log(`[QA-J] entryId=${ctx.entryId}`);
    console.log(`[QA-J] v1 端点被调次数=${v1Calls.length} cookie jar 残留=${JSON.stringify(cookiesAfter)}`);

    // J2（本 PR 范围）：不得因为误判 v2 不可用而白调一次已经 404 的 v1 端点。
    // CF path-block 的判据是「404 且 body 为空」，而 isCompactV2Unavailable 对
    // 404 无条件判 v2 不可用 —— 两者在这里撞车，CF 那条先被吞了。
    expect(v1Calls).toHaveLength(0);
  });

  it("QA-J3 ★既存问题，非本 PR 引入★ /v1/responses/compact 路由的 CF 分支打了「cleared cookies」但其实没清", async () => {
    ctx.cookieJar.set(ctx.entryId, { __cf_bm: "stale-token" });
    recordAndReply(() => makeErrorTransportResponse(404, ""));

    await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });

    // 根因：responses.ts:776 调 handleCodexApiError 时没传第 7 个参数 cookieJar，
    // 而 CF 分支里是 `cookieJar?.clear(entryId)` —— 可选链把它静默变成 no-op，
    // 但紧跟着的 console.warn 照常打印「cleared cookies and retrying」。
    // 已核对 master 同一处代码逐字相同（git show master:src/routes/responses.ts），
    // 所以这条是既存缺陷，developer 不必把它算进本 PR 的回归。
    // 对比：codex-compact-service.ts:1487 是传了 cookieJar 的，/v1/messages 那条路没问题。
    console.log(`[QA-J3] cookie jar 残留=${JSON.stringify(ctx.cookieJar.get(ctx.entryId))}`);
    expect(ctx.cookieJar.get(ctx.entryId)).toBeNull();
  });
});

// ── QA-M：F9 那条缝（回调透传 → 真的写进账号池） ──────────────────
//
// F9 的两端各自有覆盖：codex-api 单测验「onRateLimits 被透传出去」、
// proxy-rate-limit 单测验「applyParsedRateLimits 会写进账号池」。**中间那道缝
// 没有端到端验证**——回调有没有真的接到写入侧。此前根本测不了，因为 e2e 的
// ws mock 签名只有 5 个参数、没有 onRateLimits 这一档（已补第 6 个参数）。
//
// 「两端有覆盖、中间没有」正是这轮反复在修的形状，所以这条缝要有自己的用例。
describe("QA-M compact 的上游配额帧真的写进账号池（F9 端到端）", () => {
  it("QA-M1 v2 compact 期间上游发的 rate limit 帧 → 账号池 cachedQuota 被更新", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    // 先确认起点是「没有配额信息」，否则断言可能被上一条用例的残留喂饱。
    expect(ctx.accountPool.getEntry(ctx.entryId)?.cachedQuota ?? null).toBeNull();

    setUpstreamRateLimits([{
      primary: { used_percent: 73.5, window_minutes: 300, reset_at: null },
      secondary: null,
    }]);
    recordAndReply(() => makeTransportResponse(v2CompactStream("opaque-qa-m1")));

    const res = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": "session-qa-m1" },
      body: JSON.stringify({
        model: "codex", max_tokens: 1024, stream: true,
        messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const quota = ctx.accountPool.getEntry(ctx.entryId)?.cachedQuota;
    console.log(`[QA-M1] compact 之后 cachedQuota.rate_limit = ${JSON.stringify(quota?.rate_limit)}`);
    // 决定性断言：配额真的落到了账号池，不只是回调被调用过。
    expect(quota).toBeTruthy();
    expect(quota?.rate_limit?.used_percent).toBe(73.5);
    expect(quota?.rate_limit?.limit_window_seconds).toBe(300 * 60);
    // 只发生了一次上游请求，配额不是被别的请求顺带写进去的。
    expect(calls).toHaveLength(1);
  });

  // ★ 配额记录有**两个**路由层调用点，M1 只覆盖 /v1/messages 那个。
  // 实测：单独删掉 /v1/responses/compact 这个调用点，tests/e2e + tests/unit/proxy
  // 共 532 条**全绿**——同一道缝，只是换了条路由。所以这条必须单独钉。
  it("QA-M3 /v1/responses/compact 路由的配额帧同样写进账号池（第二个调用点）", async () => {
    expect(ctx.accountPool.getEntry(ctx.entryId)?.cachedQuota ?? null).toBeNull();
    setUpstreamRateLimits([{
      primary: { used_percent: 61.25, window_minutes: 60, reset_at: null },
      secondary: null,
    }]);
    recordAndReply(() => makeTransportResponse(v2CompactStream("opaque-qa-m3")));

    const res = await ctx.app.request("/v1/responses/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compactBody),
    });
    expect(res.status).toBe(200);
    await res.json();

    const quota = ctx.accountPool.getEntry(ctx.entryId)?.cachedQuota;
    console.log(`[QA-M3] /v1/responses/compact 之后 cachedQuota.rate_limit = ${JSON.stringify(quota?.rate_limit)}`);
    expect(quota).toBeTruthy();
    expect(quota?.rate_limit?.used_percent).toBe(61.25);
  });

  it("QA-M2 对照组：上游没发 rate limit 帧时不会凭空写出配额", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    setUpstreamRateLimits([]);
    recordAndReply(() => makeTransportResponse(v2CompactStream("opaque-qa-m2")));

    const res = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": "session-qa-m2" },
      body: JSON.stringify({
        model: "codex", max_tokens: 1024, stream: true,
        messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // 没有帧就不该有配额——防止实现里塞了个「反正写个默认值」的兜底。
    expect(ctx.accountPool.getEntry(ctx.entryId)?.cachedQuota ?? null).toBeNull();
  });
});
