/**
 * ★ #88 集成验证：真实走一次 `/v1/messages` 触发压缩，确认耗时埋点真的接上了
 * 路由层——跟 8.6/8.10 的教训一样，"分类/字段函数本身正确"和"路由层真的在
 * 正确的时刻传了正确的值"是两件不同的事，只测前者会漏掉后者。
 *
 * 用一个带人工延迟的 mock 上游，让 duration_ms/upstream_ms 有真实、可观测的
 * 非零值（而不是"测试机器够快，刚好也是 0，断言 >=0 永远为真"这种弱断言）。
 *
 * ★ 陷阱记录（沿用 opaque-compact-denial-log-integration.test.ts 同一条踩坑
 * 经验）：`@helpers/e2e-setup.js` 全局 `vi.mock("fs", ...)`，它的
 * `existsSync` 桩对任何不含 "models.yaml" 的路径一律返回 false。
 * `compact-outcome-log.ts` 自己内部的 `readCompactOutcomeLog`/
 * `clearCompactOutcomeLog` 用的正是这个被 mock 的 `existsSync`/`readFileSync`/
 * `unlinkSync`——在这个测试文件里直接调用它们只会看到"文件不存在"的假象，
 * 不管真实磁盘上到底写了什么。必须用 `vi.importActual("fs")` 拿到真实 fs
 * 直接读/删这个文件，绕开全局 mock。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { resolve } from "path";
import type * as FsModule from "fs";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { installInMemoryOpaqueCompactStateStore } from "@src/routes/shared/opaque-compact-state.js";
import {
  startOpaqueCompactRuntime,
  type OpaqueCompactRuntimeHandle,
} from "@src/routes/shared/opaque-compact-runtime.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

const OUTCOMES_PATH = resolve("/tmp/codex-e2e/data", "compact-outcomes.jsonl");
let realFs: typeof FsModule;

/** 读取真实磁盘上的 compact-outcomes.jsonl，newest-last（原始写入顺序）。 */
function readRealOutcomeLines(): Array<Record<string, unknown>> {
  if (!realFs.existsSync(OUTCOMES_PATH)) return [];
  return realFs.readFileSync(OUTCOMES_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function clearRealOutcomeFile(): void {
  if (realFs.existsSync(OUTCOMES_PATH)) realFs.rmSync(OUTCOMES_PATH, { force: true });
}

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

let ctx: TestContext;

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({
    accountId: "acct-duration-e2e",
    email: "duration-e2e@test.com",
    planType: "plus",
  }));

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  return { app, accountPool, cookieJar, proxyPool };
}

function messagesRequest(body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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

beforeEach(async () => {
  realFs = await vi.importActual<typeof FsModule>("fs");
  resetTransportState();
  installInMemoryOpaqueCompactStateStore();
  setTransportPost(async () => makeTransportResponse(buildTextStreamChunks("resp_msg_1", "Hello!")));
  vi.mocked(getMockTransport().post).mockClear();
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  realFs.mkdirSync(resolve("/tmp/codex-e2e/data"), { recursive: true });
  clearRealOutcomeFile();
  setClaudeCodeOpaqueCompactExperimental(true);
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  clearRealOutcomeFile();
});

describe("#88: compact-outcomes.jsonl 的耗时埋点真的接上了路由层", () => {
  it("真实成功压缩：duration_ms/upstream_ms 都是非零真实值，upstream_ms <= duration_ms", async () => {
    const UPSTREAM_DELAY_MS = 60;
    setTransportPost(async (url) => {
      if (url.endsWith("/codex/responses/compact")) {
        // 人工延迟，让 upstream_ms 有一个测试机器速度快慢都不会碰巧变成 0
        // 的、可靠的下界——不是在测"到底花了多少毫秒"这种脆弱的精确值，
        // 是在测"这个数字反映了真实等待时间，不是写死的占位符"。
        await new Promise((r) => setTimeout(r, UPSTREAM_DELAY_MS));
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const res = await messagesRequest({
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-duration-success" });
    expect(res.status).toBe(200);
    await res.text();

    const lines = readRealOutcomeLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.outcome).toBe("success");
    expect(entry.duration_ms as number).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS);
    expect(entry.upstream_ms as number).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS);
    // upstream_ms 是 duration_ms 的子集（bridge 层还有 digest/预算裁剪/save
    // 的额外开销），不能反过来。
    expect(entry.upstream_ms as number).toBeLessThanOrEqual(entry.duration_ms as number);
  });

  it("recompact 撞 429 被跨账号闸门拒绝：denied 事件带上真实 duration_ms/upstream_ms", async () => {
    let compactCallCount = 0;
    setTransportPost(async (url) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactCallCount += 1;
        if (compactCallCount === 1) {
          return makeErrorTransportResponse(200, JSON.stringify({
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
          }));
        }
        await new Promise((r) => setTimeout(r, 30));
        return makeErrorTransportResponse(429, JSON.stringify({ error: { message: "rate limited" } }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const rootRes = await messagesRequest({
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-duration-denied" });
    expect(rootRes.status).toBe(200);
    const markerMatch = /codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}/.exec(
      (await rootRes.text()).replace(/\\n/g, "\n"),
    );
    expect(markerMatch).not.toBeNull();
    const marker = `<analysis>Opaque compact state retained locally.</analysis>\n<summary>${markerMatch![0]}</summary>`;
    clearRealOutcomeFile(); // 只关心 recompact 这一次的 denied 记录。

    const recompactRes = await messagesRequest({
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: "more history" },
        { role: "user", content: compactPrompt },
      ],
    }, { "x-claude-code-session-id": "session-duration-denied" });
    expect(recompactRes.status).toBe(409);
    await recompactRes.text();

    const lines = readRealOutcomeLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.outcome).toBe("denied");
    expect(entry.reason).toBe("recompact_failed_original_account");
    expect(entry.duration_ms as number).toBeGreaterThanOrEqual(30);
    expect(entry.upstream_ms as number).toBeGreaterThanOrEqual(30);
  });
});

// ★ 幂等回放（successor_replay/edge 命中）只在**持久化**模式下存在——
// `OpaqueCompactStateStore.findSuccessorMarker()` 第一行就是
// `if (!this.persistent) return null;`，内存模式压根没有这个概念，同一个
// 输入重放两次永远是两次真实 compact。这条测试因此不能用上面共享的
// `installInMemoryOpaqueCompactStateStore()`，需要独立的持久化 runtime，
// 单独开一个 describe block、自己的 beforeEach/afterEach 覆盖外层的 store。
describe("#88: 幂等回放命中的耗时埋点（需要持久化 store）", () => {
  let runtime: OpaqueCompactRuntimeHandle | undefined;
  let dir = "";
  let keyDir = "";

  beforeEach(async () => {
    realFs = await vi.importActual<typeof FsModule>("fs");
    resetTransportState();
    dir = mkdtempSync(resolve(tmpdir(), "opaque-duration-"));
    keyDir = mkdtempSync(resolve(tmpdir(), "opaque-duration-keys-"));
    runtime = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 10080,
      capacity: 128,
      maxBytes: 10 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
    });
    expect(runtime.ready).toBe(true);
    vi.mocked(getMockTransport().post).mockClear();
    process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
    realFs.mkdirSync(resolve("/tmp/codex-e2e/data"), { recursive: true });
    clearRealOutcomeFile();
    setClaudeCodeOpaqueCompactExperimental(true);
    ctx = buildApp();
  });

  afterEach(() => {
    ctx.cookieJar.destroy();
    ctx.proxyPool.destroy();
    ctx.accountPool.destroy();
    delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
    clearRealOutcomeFile();
    runtime?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  it("幂等回放命中：只有 duration_ms（没有真正联系上游），upstream_ms 缺省", async () => {
    let compactCallCount = 0;
    setTransportPost(async (url) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactCallCount += 1;
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `summary #${compactCallCount}` }] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const body = {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    };
    const first = await messagesRequest(body, { "x-claude-code-session-id": "session-duration-replay" });
    expect(first.status).toBe(200);
    await first.text();
    clearRealOutcomeFile(); // 只关心重放这一次的耗时记录。

    const replay = await messagesRequest(body, { "x-claude-code-session-id": "session-duration-replay" });
    expect(replay.status).toBe(200);
    await replay.text();
    expect(compactCallCount).toBe(1); // 确认第二次真的是回放，没有再打一次上游。

    const lines = readRealOutcomeLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.outcome).toBe("success");
    expect(entry.replayed).toBe(true);
    expect(entry.duration_ms).toBeDefined();
    expect(entry.upstream_ms).toBeUndefined();
  });
});
