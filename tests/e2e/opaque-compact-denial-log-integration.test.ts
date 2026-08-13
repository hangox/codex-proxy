/**
 * 8.6 集成验证：真实走一次 `/v1/messages` 撞上 opaque 409，确认
 * `recordOpaqueCompactDenial` 真的被 messages.ts 调用到了，而不仅仅是
 * 单元测试里孤立验证过函数本身正确——路由层的编排（在哪个分支调用、
 * 传什么参数）同样需要覆盖，否则"分类函数对、日志函数对，两者接线对不对"
 * 这道题就没人答过（本次事故反复出现的漏测形状）。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
  setClaudeCodeOpaqueCompactExperimental,
  isCompactV2Request,
  makeCompactV2Response,
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
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

const ERROR_LOG_PATH = resolve("/tmp/codex-e2e/data", "error-log.jsonl");

// ★ 陷阱记录：`@helpers/e2e-setup.js` 为了拦截 models.yaml / index.html 等
// 固定 fixture，全局 `vi.mock("fs", ...)` 了整个模块——它的 `existsSync` 桩
// 对任何不含 "models.yaml" 的路径一律返回 false，`writeFileSync`/`mkdirSync`
// 也是空操作。`error-log.ts` 真正写盘用的 `appendFileSync` 没被这个 mock
// 覆盖（透传到真实 fs），所以落盘本身是真的——但如果这个测试文件也用
// `import { existsSync, readFileSync } from "fs"` 去验证，读到的会是同一个
// 桩，永远看不到刚写的文件（现象：怎么看都是"文件不存在"，即便已经真实落
// 盘）。验证 error-log.jsonl 必须用 `vi.importActual` 拿真实 fs，绕开这个
// 全局 mock，不能假设"文件 I/O 断言"在这个测试文件里是无副作用的直觉操作。
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

let ctx: TestContext;

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({
    accountId: "acct-denial-log-e2e",
    email: "denial-log@test.com",
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
  if (realFs.existsSync(ERROR_LOG_PATH)) realFs.rmSync(ERROR_LOG_PATH, { force: true });
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  if (realFs.existsSync(ERROR_LOG_PATH)) realFs.rmSync(ERROR_LOG_PATH, { force: true });
});

describe("8.6: opaque compact denial log — real /v1/messages integration", () => {
  it("an ordinary request with an expired marker writes a whitelisted denial-log entry with zero raw marker leakage", async () => {
    let now = 1_000_000;
    installInMemoryOpaqueCompactStateStore({ ttlMs: 30 * 60_000, now: () => now });
    setClaudeCodeOpaqueCompactExperimental(true);
    setTransportPost(async (_url, _headers, body) => isCompactV2Request(body)
      ? makeCompactV2Response()
      : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

    const compactRes = await messagesRequest({
      model: "codex",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-denial-log-e2e" });
    const compactText = await compactRes.text();
    const markerMatch = /codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}/.exec(
      compactText.replace(/\\n/g, "\n"),
    );
    expect(markerMatch, "compact response must contain a marker token").not.toBeNull();
    const markerToken = markerMatch![0];
    const marker =
      `<analysis>Opaque compact state retained locally.</analysis>\n<summary>${markerToken}</summary>`;

    now += 31 * 60_000; // 跨过 30 分钟 TTL

    // 普通（非 compact）请求带着过期 marker：族 A 不自愈（compactPrompt===null）
    // ——★ #91：这条路径改成 400 + x-should-retry: false（不再是 409）。
    // 这个失败是确定性的（底层行已经不存在，重试不会有不同结果），旧的 409
    // 会被 Anthropic SDK / Claude Code 自己的重试逻辑当"可重试的锁冲突"
    // 无条件重试、静默等待数十秒到数分钟；body 本来就是 invalid_request_error
    // （对应规范里的 400），400 只是把状态码和已经写在 body 里的语义对齐。
    // 这条路径仍然应该落一条结构化日志——状态码变了不代表 denial-log 的
    // 记录职责跟着变。
    const replay = await messagesRequest({
      model: "codex",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
    }, { "x-claude-code-session-id": "session-denial-log-e2e" });
    expect(replay.status).toBe(400);
    expect(replay.headers.get("x-should-retry")).toBe("false");
    await replay.text();

    // recordOpaqueCompactDenial() 内部是纯同步的 appendFileSync，写入与
    // app.request() 的 await 在同一条同步调用链上完成，不需要轮询等待。
    const lines = readErrorLogLines();
    const denialLines = lines.filter((l) => (l.error as Record<string, unknown> | undefined)?.name === "OpaqueCompactDenied");
    expect(denialLines).toHaveLength(1);

    const entry = denialLines[0]!;
    expect(entry.source).toBe("server");
    const err = entry.error as Record<string, unknown>;
    expect(err.message).toBe("expired");

    const ctxFields = entry.context as Record<string, unknown>;
    // ★ #83：新增 cause 字段（这条路径的 recordOpaqueCompactDenial 调用没有
    // 传 cause——不是 recompact_failed_original_account 聚合桶，"expired"
    // 本身就是完整分类——所以理应是 null，跟 detail 一样）。
    expect(Object.keys(ctxFields).sort()).toEqual(
      ["account_hash", "cause", "conv_hash", "detail", "generation", "marker_length", "reason", "rid"].sort(),
    );
    expect(ctxFields.reason).toBe("expired");
    // "expired" 是良性分类（族 A，自愈候选），不是 store 级致命故障——
    // detail 只在 toStateError() 的兜底分支才有内容，这里理应是 null。
    expect(ctxFields.detail).toBeNull();
    expect(ctxFields.cause).toBeNull();
    expect(typeof ctxFields.rid).toBe("string");
    expect(typeof ctxFields.conv_hash).toBe("string");
    expect(ctxFields.conv_hash).toMatch(/^[0-9a-f]{8}$/);
    expect(ctxFields.marker_length).toBe(marker.length);

    // 硬禁止：整条落盘的原始文件里不出现 marker 的任何一段、session id 原文。
    const rawFile = realFs.readFileSync(ERROR_LOG_PATH, "utf-8");
    expect(rawFile).not.toContain(markerToken);
    const [stateId, compHash, signature] = markerToken.split(":").slice(2);
    expect(rawFile).not.toContain(stateId!);
    expect(rawFile).not.toContain(compHash!);
    expect(rawFile).not.toContain(signature!);
    expect(rawFile).not.toContain("session-denial-log-e2e");
  });

  // ★ #83 集成验证：不满足于两处单元测试（executeCompactOnly 的 cause
  // 分类、recordOpaqueCompactDenial 的字段透传）各自正确——路由层把两者
  // 接起来这一步同样需要覆盖，跟本文件开头那条 8.6 的教训是同一类问题。
  it("recompact 在原账号上撞上 429，denial log 的 reason 仍是聚合桶，但 cause 精确到 rate_limited", async () => {
    installInMemoryOpaqueCompactStateStore();
    setClaudeCodeOpaqueCompactExperimental(true);

    let compactCallCount = 0;
    setTransportPost(async (_url, _headers, body) => {
      if (isCompactV2Request(body)) {
        compactCallCount += 1;
        // 第一次（root）成功，第二次（recompact）撞 429——429 按
        // handleCodexApiError 的分类本来是 action:"retry"，但这个账号池
        // 只有一个账号、且 marker 已把这次 recompact 钉死在它上面，
        // requiredEntryId 短路成立即放弃，走 crossAccountBlocked 分支。
        if (compactCallCount === 1) {
          return makeCompactV2Response({ encryptedContent: "summary" });
        }
        return makeErrorTransportResponse(429, JSON.stringify({ error: { message: "rate limited" } }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const rootRes = await messagesRequest({
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-cause-e2e" });
    expect(rootRes.status).toBe(200);
    const markerMatch = /codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}/.exec(
      (await rootRes.text()).replace(/\\n/g, "\n"),
    );
    expect(markerMatch, "root compact response must contain a marker token").not.toBeNull();
    const marker =
      `<analysis>Opaque compact state retained locally.</analysis>\n<summary>${markerMatch![0]}</summary>`;

    const recompactRes = await messagesRequest({
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: "more history" },
        { role: "user", content: compactPrompt },
      ],
    }, { "x-claude-code-session-id": "session-cause-e2e" });
    expect(recompactRes.status).toBe(409);
    await recompactRes.text();

    const lines = readErrorLogLines();
    const denialLines = lines.filter((l) => (l.error as Record<string, unknown> | undefined)?.name === "OpaqueCompactDenied");
    expect(denialLines).toHaveLength(1);
    const ctxFields = denialLines[0]!.context as Record<string, unknown>;
    // reason 本身没变——既有 Dashboard/日志过滤口径依赖它，这条聚合桶
    // 语义不动。cause 才是这次要验证的新信息：429 没有在跨账号闸门改写
    // message/status 时被一起丢掉。
    expect(ctxFields.reason).toBe("recompact_failed_original_account");
    expect(ctxFields.cause).toBe("rate_limited");
  });
});
