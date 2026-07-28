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
import { setOpaqueCompactStateStore } from "@src/routes/shared/opaque-compact-state.js";
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
});
