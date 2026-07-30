/**
 * 生产事故复盘（交接文档同一次事故的第二部分）：`store_unavailable` 是
 * `toStateError()` 遇到「不认识的错误」时的兜底分类，`isFatalStoreFailure()`
 * 把它判定为 store 级致命故障——原子摘掉整个 runtimeStore。此前所有测试只
 * 问过"给定输入 X，分类出的 reason 是不是 Y"（分类正确性），从没有一条
 * 问过"分类之后发生了什么"——一次故障的爆炸半径有多大。事故里一个会话
 * （`eb77c2b0`）在 49 分钟内撞了 77 次同一个 409（指数退避 8s→46s），根因
 * 至今查不到，因为原始异常从未落进结构化日志（另一半修复见
 * `opaque-compact-runtime-fault-log.ts` / `opaque-compact-denial-log.ts` 的
 * `detail` 字段）。
 *
 * 这个文件不测分类函数本身（`opaque-compact-persistence.test.ts` /
 * `opaque-compact-state.test.ts` 已经穷举过 reason 分类），只测分类之后的
 * 后果，用真实机制而不是内部 setter 抄近路：
 *
 *   1. 在 repository 边界注入一个任意的、未预料的异常（不是
 *      `OpaqueCompactRepositoryError` 的任何具名子类）——这正是
 *      `toStateError()` 兜底分支存在的理由。
 *   2. 断言 store 被全局摘掉（`getOpaqueCompactStateReadiness()` 全局
 *      not-ready），且后续请求——包括从未碰过故障 marker 的其它会话、甚至
 *      全新会话的全新 compact 请求——全部 409，不局限于触发故障的那一个
 *      请求。
 *   3. 断言没有自动恢复：多次重试（模拟事故里的指数退避重试）故障持续
 *      存在。
 *   4. 断言新增的两条结构化日志（`recordOpaqueCompactDenial` 的 `detail`
 *      字段、`recordOpaqueCompactRuntimeFault`）都真的带上了原始异常内容——
 *      同时验证 `detail` 绝不泄漏进客户端可见的响应体，只有分类后的
 *      `reason` 会出现在响应文案里。
 *
 * 这不是为了让测试变绿，是为了把「一次故障的爆炸半径」固化下来：未来谁
 * 改动 fail-closed 编排（`messages.ts` 里 readiness 早退检查的位置、
 * `reportOpaqueCompactStoreFault` 的调用时机），这条测试应该能感知到影响
 * 范围被意外缩小或放大。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type * as FsModule from "fs";
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

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { getOpaqueCompactStateReadiness } from "@src/routes/shared/opaque-compact-state.js";
import {
  startOpaqueCompactRuntime,
  type OpaqueCompactRuntimeHandle,
} from "@src/routes/shared/opaque-compact-runtime.js";
import { OpaqueCompactRepository } from "@src/routes/shared/opaque-compact-repository.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

// ★ 陷阱（同 opaque-compact-denial-log-integration.test.ts）：`e2e-setup.js`
// 全局 `vi.mock("fs", ...)` 了整个模块，`existsSync`/`readFileSync` 桩看不到
// `appendErrorLog` 真实 `appendFileSync` 写下的文件。验证落盘必须用
// `vi.importActual` 拿真实 fs。
const ERROR_LOG_PATH = resolve("/tmp/codex-e2e/data", "error-log.jsonl");
let realFs: typeof FsModule;

function readErrorLogLines(): Array<Record<string, unknown>> {
  if (!realFs.existsSync(ERROR_LOG_PATH)) return [];
  return realFs.readFileSync(ERROR_LOG_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  // 两个账号在同一个进程/同一个 accountPool 里——和生产一致：
  // OpaqueCompactStateStore 是进程级单例，不同用户的并发会话共用同一个
  // store，这正是"一次故障波及所有会话"的前提条件，不是测试的巧合设定。
  accountPool.addAccount(createValidJwt({ accountId: "acct-blast-a", email: "blast-a@test.com", planType: "plus" }));
  accountPool.addAccount(createValidJwt({ accountId: "acct-blast-b", email: "blast-b@test.com", planType: "plus" }));

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

let ctx: TestContext;
let runtime: OpaqueCompactRuntimeHandle | undefined;
let dir = "";
let keyDir = "";
let loadSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(async () => {
  realFs = await vi.importActual<typeof FsModule>("fs");
  resetTransportState();
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  realFs.mkdirSync(resolve("/tmp/codex-e2e/data"), { recursive: true });
  if (realFs.existsSync(ERROR_LOG_PATH)) realFs.rmSync(ERROR_LOG_PATH, { force: true });

  dir = mkdtempSync(resolve(tmpdir(), "opaque-blast-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-blast-keys-"));
  setClaudeCodeOpaqueCompactExperimental(true);
  // 用真实 startOpaqueCompactRuntime()（不是 makeOpaqueCompactStore() 那种
  // 直接 new 出来的自包含 store）——只有这样 runtimeFaultHandler 才会像生产
  // 一样接线，`reportOpaqueCompactStoreFault` 才会真的触发
  // `recordOpaqueCompactRuntimeFault`，而不仅仅是 `recordOpaqueCompactDenial`。
  runtime = startOpaqueCompactRuntime({
    enabled: true,
    ttlMinutes: 30,
    capacity: 128,
    maxBytes: 64 * 1024 * 1024,
    directory: dir,
    keyringFile: resolve(keyDir, "keyring.json"),
    allowKeyringBootstrap: true,
  });
  expect(runtime.ready).toBe(true);

  ctx = buildApp();
  vi.mocked(getMockTransport().post).mockClear();
});

afterEach(() => {
  loadSpy?.mockRestore();
  loadSpy = undefined;
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
  runtime?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  if (realFs.existsSync(ERROR_LOG_PATH)) realFs.rmSync(ERROR_LOG_PATH, { force: true });
});

describe("opaque compact store fault — blast radius (production incident: 94x store_unavailable / 49min stuck session)", () => {
  it("an arbitrary unexpected exception at the repository boundary globally detaches the store, 409s every session (including ones that never touched the failing marker), never self-heals, and the original exception content reaches the new structured logs without leaking into the client response", async () => {
    const compactBodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactBodies.push(JSON.parse(body) as Record<string, unknown>);
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: `opaque-blast-root-${compactBodies.length}`, summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // 前置：两个独立会话各自正常完成一次真实 compact，拿到真实签发的 marker——
    // 证明故障注入之前，store 是健康的、两个会话互不干扰。
    const resA = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history-a" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-blast-a" });
    expect(resA.status).toBe(200);
    const markerA = extractMarkerFromResponse(await resA.text());
    expect(markerA).toContain("codex-opaque-state:v1");

    const resB = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history-b" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-blast-b" });
    expect(resB.status).toBe(200);
    const markerB = extractMarkerFromResponse(await resB.text());
    expect(markerB).toContain("codex-opaque-state:v1");
    expect(compactBodies).toHaveLength(2);

    // 故障注入：在 repository 边界抛一个任意的、未预料的异常——一个普通
    // Error，不是 OpaqueCompactRepositoryError/OpaqueCompactKeyringError 等
    // 任何具名子类。toStateError() 认不出它，落进 default/兜底分支，分类成
    // store_unavailable。这正是事故的真实形状：原始异常内容此前从这里
    // 起就永久丢失。
    const INJECTED_MESSAGE =
      "ENOSPC: no space left on device, write '/var/opt/codex-proxy/opaque/state.db-wal'";
    loadSpy = vi.spyOn(OpaqueCompactRepository.prototype, "load").mockImplementation(() => {
      throw new Error(INJECTED_MESSAGE);
    });

    // 故障第一次被发现：session A 带着自己真实合法的 marker 发一个普通
    // （非 compact）后续请求，触发 resolve() → repository.load() 抛出注入
    // 的异常。
    const replayA = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "assistant", content: markerA }, { role: "user", content: "continue" }],
    }), { "x-claude-code-session-id": "session-blast-a" });
    expect(replayA.status).toBe(409);
    const replayABody = await replayA.text();
    // 安全边界：detail（原始异常文本）绝不能流入客户端可见的响应体，只有
    // 分类后的 reason 字符串可以出现在这里。
    expect(replayABody).not.toContain(INJECTED_MESSAGE);
    expect(replayABody).toContain("store_unavailable");

    // 决定性断言：全局 readiness 单例现在是 not-ready——一次故障、全局摘店，
    // 不是"只有触发故障的这一个请求"受影响。
    expect(getOpaqueCompactStateReadiness()).toEqual({
      ready: false,
      reason: "store_unavailable",
      detail: expect.stringContaining(INJECTED_MESSAGE),
    });

    // 爆炸半径跨会话：session B 从未碰过导致故障的那个 marker，用它自己的
    // 合法 marker 发一个普通请求——同样 409。
    const replayB = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "assistant", content: markerB }, { role: "user", content: "continue" }],
    }), { "x-claude-code-session-id": "session-blast-b" });
    expect(replayB.status).toBe(409);
    expect(await replayB.text()).toContain("store_unavailable");

    // 爆炸半径不局限于"曾经拿到过 marker 的会话"：一个全新会话发起全新
    // root compact（不带任何 marker）——同样被同一个全局 not-ready 状态
    // 拦下，且没有多打一次上游浪费一次真实 compact 调用。
    const compactCountBeforeFreshAttempt = compactBodies.length;
    const freshCompact = await request(ctx, defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history-c" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-blast-c-brand-new" });
    expect(freshCompact.status).toBe(409);
    expect(await freshCompact.text()).toContain("store_unavailable");
    expect(compactBodies).toHaveLength(compactCountBeforeFreshAttempt);

    // 没有自动恢复：多次后续重试（模拟事故里 49 分钟内 77 次指数退避重试）
    // 故障持续存在，reason 保持不变，不会自愈——代码里确实不存在任何自动
    // 恢复路径（这轮明确不新增）。
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = await request(ctx, defaultBody({
        stream: true,
        messages: [{ role: "assistant", content: markerA }, { role: "user", content: `retry-${attempt}` }],
      }), { "x-claude-code-session-id": "session-blast-a" });
      expect(retry.status).toBe(409);
    }
    expect(getOpaqueCompactStateReadiness().ready).toBe(false);

    // 决定性断言：新增的两条结构化日志都真的带上了原始异常内容——事故复盘
    // 的核心诉求。以前这里只有分类后的 reason，原始异常从未落盘，根因永久
    // 查不到。
    const lines = readErrorLogLines();

    const denialLines = lines.filter(
      (l) => (l.error as Record<string, unknown> | undefined)?.name === "OpaqueCompactDenied",
    );
    expect(denialLines.length).toBeGreaterThan(0);
    const denialCarriedDetail = denialLines.some((l) => {
      const ctxFields = l.context as Record<string, unknown>;
      return typeof ctxFields.detail === "string" && ctxFields.detail.includes(INJECTED_MESSAGE);
    });
    expect(denialCarriedDetail).toBe(true);

    const runtimeFaultLines = lines.filter(
      (l) => (l.error as Record<string, unknown> | undefined)?.name === "OpaqueCompactRuntimeFault",
    );
    expect(runtimeFaultLines.length).toBeGreaterThan(0);
    expect(runtimeFaultLines.some((l) => (l.context as Record<string, unknown>).phase === "runtime")).toBe(true);
    const runtimeFaultCarriedDetail = runtimeFaultLines.some((l) => {
      const ctxFields = l.context as Record<string, unknown>;
      return typeof ctxFields.detail === "string" && ctxFields.detail.includes(INJECTED_MESSAGE);
    });
    expect(runtimeFaultCarriedDetail).toBe(true);

    // 隐私护栏在故障路径下依然成立：整份日志文件不出现任何原始 marker 原文。
    const raw = realFs.readFileSync(ERROR_LOG_PATH, "utf-8");
    expect(raw).not.toContain(markerA);
    expect(raw).not.toContain(markerB);
  });
});
