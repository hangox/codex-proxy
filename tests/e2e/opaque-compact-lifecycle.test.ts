/**
 * Reviewer Finding #3：本仓库所有 `tests/e2e/*.test.ts` 的 opaque compact 用例
 * 此前全部跑在 `installInMemoryOpaqueCompactStateStore()` 上——包括 8.1 自愈
 * 的 T+31min 用例本身。持久化路径的 `not_found`（`opaque-compact-state.ts`
 * 的 `loadPersisted`）与内存路径的 `missing` 是两条不同代码路径
 * （`repository.load()` vs `loadFromMemory`），"分类函数对、路由编排对"和
 * "真实持久化路径也对"从未被同一条用例同时验证过——这正是交接文档第 2 节
 * 那个教训的同款形状：验证范围的形状本身有盲区，而不是某一行代码错了。
 *
 * 这个文件把「真实 SQLite repository + 真实 Hono 路由 + 可控 now」三者叠加，
 * 只覆盖内存版 e2e 测不到的两类场景：
 *   1. 持久化路径下 T+31min 自愈仍然成立（matrix #1/#7 的持久化对照）；
 *   2. E3：跨账号访问在持久化路径下仍然 fail-closed，不会被自愈误伤
 *      （`account_mismatch` 不在任何"不该 409"族里——见
 *      `isOpaqueCompactMarkerBindingMismatch` 的文档；这条只有持久化路径能
 *      触发，内存模式的 `resolve()` 根本不检查账号绑定）。
 *
 * 其余已经在内存版 e2e（`tests/e2e/messages.test.ts`）和 repository 单测
 * （`tests/unit/routes/opaque-compact-persistence.test.ts`）里分别覆盖过的
 * 场景（session/model/variant_mismatch、malformed、开关关闭、schema 迁移、
 * 密钥轮换……）不在这里重复——这个文件只补"两者叠加"这一个组合缺口。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
  setClaudeCodeOpaqueCompactExperimental,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";
import {
  makeOpaqueCompactStore,
  type OpaqueCompactStoreHandle,
} from "@helpers/opaque-compact-store.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import {
  setOpaqueCompactStateStore,
  getOpaqueCompactStateReadiness,
  isSelfHealableOpaqueCompactStateFailure,
  isUnparseableOpaqueCompactMarker,
  isOpaqueCompactMarkerBindingMismatch,
} from "@src/routes/shared/opaque-compact-state.js";
import { startOpaqueCompactRuntime } from "@src/routes/shared/opaque-compact-runtime.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

function buildApp(accountId: string, email: string): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({ accountId, email, planType: "plus" }));

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  return { app, accountPool, cookieJar, proxyPool };
}

function request(ctx: TestContext, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

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

function parseAnthropicSSE(text: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    results.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
  }
  return results;
}

function extractMarkerFromResponse(responseText: string): string {
  return parseAnthropicSSE(responseText)
    .filter((event) => event.event === "content_block_delta")
    .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
    .join("");
}

let handle: OpaqueCompactStoreHandle | undefined;
let now = 1_000_000;

beforeEach(() => {
  resetTransportState();
  now = 1_000_000;
  handle = makeOpaqueCompactStore({ ttlMs: 30 * 60_000, now: () => now });
  setOpaqueCompactStateStore(handle.store);
  setTransportPost(async () => makeTransportResponse(buildTextStreamChunks("resp_msg_1", "Hello!")));
  vi.mocked(getMockTransport().post).mockClear();
});

afterEach(() => {
  setOpaqueCompactStateStore(null);
  handle?.close();
  handle = undefined;
});

describe("opaque compact lifecycle — real SQLite repository + real routes (Reviewer Finding #3)", () => {
  it("persisted path: self-heals an expired marker into a brand-new root compact (matrix #1/#7, persisted-path counterpart)", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const ctx = buildApp("acct-lifecycle-self-heal", "lifecycle-self-heal@test.com");
    const compactBodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactBodies.push(JSON.parse(body) as Record<string, unknown>);
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-persisted-root", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const compactRes = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-persisted-self-heal" });
    expect(compactRes.status).toBe(200);
    const marker = extractMarkerFromResponse(await compactRes.text());
    expect(marker).toContain("codex-opaque-state:v1");
    expect(compactBodies).toHaveLength(1);
    // 行确实落盘了（真实 SQLite，不是内存 Map）。
    expect(handle!.repository.stats().count).toBe(1);

    now += 31 * 60_000; // 跨过持久化 store 的 30 分钟 TTL

    const replay = await request(ctx, defaultBody({
      stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-persisted-self-heal" });

    // 8.1：持久化路径下过期 marker + compact 请求同样必须自愈为全新 root
    // compact，不得 409——这是内存版 e2e 测不到的：持久化路径的 expired 由
    // repository.load() 的真实 TTL 判定产生，不是内存 Map 的 expiresAt 字段。
    expect(replay.status).toBe(200);
    expect(compactBodies).toHaveLength(2);
    const replayMarker = extractMarkerFromResponse(await replay.text());
    expect(replayMarker).toContain("codex-opaque-state:v1");
    expect(replayMarker).not.toBe(marker);

    ctx.cookieJar.destroy();
    ctx.proxyPool.destroy();
    ctx.accountPool.destroy();
  });

  it("E3: cross-account access remains fail-closed even on a fresh /compact request (account_mismatch is not in any self-heal/ignore family)", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const owner = buildApp("acct-lifecycle-owner", "lifecycle-owner@test.com");
    setTransportPost(async (url) => url.endsWith("/codex/responses/compact")
      ? makeErrorTransportResponse(200, JSON.stringify({ output: [{ type: "message", role: "assistant", content: [] }] }))
      : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

    const compactRes = await request(owner, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-cross-account" });
    expect(compactRes.status).toBe(200);
    const marker = extractMarkerFromResponse(await compactRes.text());
    expect(handle!.repository.stats().count).toBe(1);
    owner.cookieJar.destroy();
    owner.proxyPool.destroy();
    owner.accountPool.destroy();

    // 一个全新的 app/accountPool，从未见过 owner 账号——accountCandidates 因此
    // 不包含记录所属账号，repository.load() 的账号绑定循环找不到匹配，
    // 抛 binding_mismatch → toStateError 映射成 account_mismatch。复用同一个
    // 持久化 store（setOpaqueCompactStateStore 是进程级单例，两个 app 共享）。
    const stranger = buildApp("acct-lifecycle-stranger", "lifecycle-stranger@test.com");
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // 刻意构造成一次"新的 /compact 请求"（带 compactPrompt）——这是
    // isSelfHealableOpaqueCompactStateFailure 唯一会放行的前提条件。如果
    // account_mismatch 被错误地归进了自愈族，这里就会 200 而不是 409，
    // 且会悄悄把 owner 的 output 泄露给 stranger 的请求上下文。
    const replay = await request(stranger, defaultBody({
      stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-cross-account" });

    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("account_mismatch");
    // fail-closed：从未打过一次上游请求去"顺便"完成什么自愈或新 compact。
    expect(urls).toHaveLength(0);

    stranger.cookieJar.destroy();
    stranger.proxyPool.destroy();
    stranger.accountPool.destroy();
  });

  it("route-layer guard: a fatal store failure (store_locked) 409s even when the request looks exactly like a legitimate self-heal continuation (readiness check must run before self-heal, and this must stay true across future refactors of messages.ts)", async () => {
    // qa 覆盖率盘点发现的盲区：C3（store readiness fail-closed）+ D 组（store
    // 级致命故障）里，没有一条路由层用例把"store 未 ready"和"这是一个
    // compact 请求"拼在一起断言仍然 409。当前顺序是对的——readiness 检查
    // （messages.ts 里 `!readiness.ready` 那个分支）确实写在自愈逻辑
    // （`isSelfHealableOpaqueCompactStateFailure` 那段编排）之前，但这个
    // 正确性此前只由源码的书写顺序保证，没有任何测试锁死它。未来谁重构
    // messages.ts（这一整轮我们自己就动了它七八次）把顺序挪反，不会有任何
    // 测试变红——后果是 store 故障时，一个"看起来合法"的请求会被自愈逻辑
    // 误判成"良性可自愈"而放行，安全边界在没人注意的情况下被打开。
    //
    // 用真实的 D 组致命故障（store_locked）构造，不是直接调用内部 setter
    // 抄近路：第二个 startOpaqueCompactRuntime 实例去抢同一把文件锁失败，
    // 是这个 reason 在生产里真实产生的唯一路径（跟
    // opaque-compact-persistence.test.ts 里"第二实例被拒绝并给出
    // store_locked"那条用例同一套真实机制），失败路径内部调用的
    // setOpaqueCompactStateUnavailable 把全局 readiness 单例覆盖成
    // not-ready——从这一刻起路由层看到的就是一个真实致命故障的 store。
    //
    // ★ 红/绿验证补充发现（写下来，比只留一条断言更有价值）：这条边界
    // 实际上是三层独立防御，不是单点：① messages.ts 里这条显式 readiness
    // 早退检查；② `getOpaqueCompactStateStore()` 自身在 `runtimeStore ===
    // null` 时的兜底 throw（即便 ① 被整段删掉，任何后续访问 store 的代码
    // 路径依然会在这里炸出同一个 reason）；③ `isSelfHealableOpaqueCompactStateFailure`
    // 的分类结果本身——但 store 级致命 reason（store_locked 等）设计上根本
    // 不会走到这个分类函数：它们在 compactPrompt 被计算之前、在任何
    // per-marker resolve() 发生之前就已经被 ① 拦截，分类函数只处理"store
    // 健康但某个具体 marker resolve 失败"这一类不同性质的失败。手工验证过
    // 单独破坏 ①（把早退检查短路掉）不会让这条请求泄漏成 200——② 接住了；
    // 单独破坏 ③（让 store_locked 被错误分类为可自愈）也不会——因为 ①
    // 根本不看分类函数，直接按 readiness 早退。这条测试锁的是"最终对外
    // 可观察行为"这个契约，不依赖某一层具体防御机制的实现细节；真正会让
    // 这条防线失守的重构，需要同时破坏 ① 和 ②（比如把 early check 删掉、
    // 同时把 `getOpaqueCompactStateStore()` 的 null 检查也删掉），这是一次
    // 明显更大、更容易被 review 抓到的改动，但"需要更大改动才能破坏"不等于
    // "不需要测试"——这条护栏依然值得留着，且额外验证了 ②③ 两层各自独立
    // 生效，不是纸面推测。
    setClaudeCodeOpaqueCompactExperimental(true);

    const dir = mkdtempSync(resolve(tmpdir(), "opaque-e2e-lockguard-"));
    const keyDir = mkdtempSync(resolve(tmpdir(), "opaque-e2e-lockguard-keys-"));
    const lockGuardConfig = {
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
      allowKeyringBootstrap: true,
    };

    const first = startOpaqueCompactRuntime(lockGuardConfig);
    expect(first.ready).toBe(true);

    const ctx = buildApp("acct-lifecycle-lockguard", "lifecycle-lockguard@test.com");
    const compactBodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactBodies.push(JSON.parse(body) as Record<string, unknown>);
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-lockguard-root", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // 先拿一个真实、合法签发过的 marker——不是手工拼出来的假 marker。这样
    // 下面"请求看起来完全符合自愈条件"这句话不是靠猜的，是真的。
    const compactRes = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-lockguard" });
    expect(compactRes.status).toBe(200);
    const marker = extractMarkerFromResponse(await compactRes.text());
    expect(marker).toContain("codex-opaque-state:v1");
    expect(compactBodies).toHaveLength(1);

    // 第二个"实例"抢同一把锁失败——真实生产路径，不是测试后门。
    const second = startOpaqueCompactRuntime(lockGuardConfig);
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("store_locked");
    expect(getOpaqueCompactStateReadiness()).toEqual({ ready: false, reason: "store_locked" });
    // 决定性断言：store_locked 落在"致命族"——不是良性可自愈族，也不是
    // "marker 不适用于本次请求"的族 B，是三族分类里穷举排除法之后唯一
    // 剩下的那一族。这条不是重新发明 isFatalStoreFailure，是从它的两个
    // 姊妹分类函数（都已导出）反向验证 store_locked 确实不属于它们，
    // 从而确认它落在"既不自愈也不忽略"的致命族里。
    expect(isSelfHealableOpaqueCompactStateFailure("store_locked")).toBe(false);
    expect(isUnparseableOpaqueCompactMarker("store_locked")).toBe(false);
    expect(isOpaqueCompactMarkerBindingMismatch("store_locked")).toBe(false);

    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // 这条请求的形状完全符合"应该被自愈"的表面条件：带 compactPrompt
    // （一次新的 /compact 请求）、历史里带一个真实合法签发过的 marker。
    // 唯一的差别是 store 现在处于致命故障。如果 readiness 检查被未来某次
    // 重构挪到了自愈逻辑之后，这条请求会被自愈放行成 200——且不会有任何
    // 既有用例发现，因为其余用例覆盖的都是"store 健康、marker 有问题"或
    // "store 故障、请求里根本没有 marker"，唯独没有"store 故障 + marker
    // 和请求形状都完全正常"这一个组合。
    const replay = await request(ctx, defaultBody({
      stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-lockguard" });

    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("store_locked");
    // fail-closed：从未打过一次上游请求去"顺便"完成自愈或新 compact，
    // 且没有产生第二条 compact 请求——自愈分支根本没有被进入。
    expect(urls).toHaveLength(0);
    expect(compactBodies).toHaveLength(1);

    ctx.cookieJar.destroy();
    ctx.proxyPool.destroy();
    ctx.accountPool.destroy();
    first.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  });
});
