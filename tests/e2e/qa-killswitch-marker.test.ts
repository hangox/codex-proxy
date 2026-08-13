/**
 * QA-L：关掉 claude_code_opaque_compact_experimental（运维止血阀）之后，
 * 客户端手里的**存量 marker** 打进来会发生什么。
 *
 * ★ 实测结论（2026-08-13）：**关开关并不能止住 F11**。
 *
 * 根因是共享代码路径 —— 关开关走的是 `replaceIgnoredOpaqueCompactMarker()`
 * （messages.ts:801），而它内部 `return restoreOpaqueCompactInput(...)`
 * （opaque-compact-state.ts:503），正是 F11 那个从 boundaryIndex 起步、
 * 把 input[0] 一起裁掉的函数。所以「忽略 marker」这条路同样丢系统提示词。
 *
 * 连带推论：F11 的修复必须落在 `restoreOpaqueCompactInput` 本身（或覆盖它
 * 全部三个调用点），只补 messages.ts 的恢复分支不够 —— 三个调用点是：
 *   opaque-compact-bridge.ts:215（root compact 复用上一枚 marker）
 *   opaque-compact-bridge.ts:474（恢复路径，F11 最初描述的那条）
 *   opaque-compact-state.ts:503（关开关 / marker 不适用 / marker 损坏）
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  setClaudeCodeOpaqueCompactExperimental,
  setSystemPromptStrategy,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks, sseChunk } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { installInMemoryOpaqueCompactStateStore } from "@src/routes/shared/opaque-compact-state.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

const SYSTEM_SENTINEL = "SYSTEM-SENTINEL-OPTB: always answer in Klingon";
const HISTORY_SENTINEL = "HISTORY-SENTINEL-OPTB-the-db-port-is-5433";

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

interface UpstreamCall { url: string; body: Record<string, unknown>; }
let calls: UpstreamCall[] = [];
let ctx: { app: Hono; cookieJar: CookieJar };

function buildApp() {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({
    accountId: "acct-optb", email: "optb@test.com", planType: "plus",
  }));
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));
  return { app, cookieJar };
}

function isCompactTurn(call: UpstreamCall): boolean {
  const last = (call.body.input as unknown[] | undefined)?.at(-1);
  return !!last && (last as { type?: string }).type === "compaction_trigger";
}

function record() {
  setTransportPost(async (url, _h, body) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
    const call = { url, body: parsed };
    calls.push(call);
    return isCompactTurn(call)
      ? makeTransportResponse(
        sseChunk("response.output_item.done", {
          item: { id: "cmp_optb", type: "compaction", encrypted_content: "optb-opaque" },
        }) + sseChunk("response.completed", {
          response: { id: "resp_optb", usage: { input_tokens: 50, output_tokens: 8 } },
        }),
      )
      : makeTransportResponse(buildTextStreamChunks("resp_optb_next", "continued"));
  });
}

function extractMarker(sseText: string): string {
  return sseText.split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try { return (JSON.parse(l.slice(6)) as { delta?: { text?: string } }).delta?.text ?? ""; }
      catch { return ""; }
    })
    .join("");
}

beforeEach(() => {
  resetTransportState();
  installInMemoryOpaqueCompactStateStore();
  setSystemPromptStrategy("developer_inline");
  calls = [];
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  setSystemPromptStrategy("instructions");
  vi.restoreAllMocks();
});

describe("QA-L 关开关（止血阀）后存量 marker 的行为", () => {
  it("QA-L1 关开关后：不 409、不走恢复、marker 不泄漏 —— 但系统提示词同样会丢", async () => {
    // ── 阶段一：开关开着，正常 compact 出 marker ──
    setClaudeCodeOpaqueCompactExperimental(true);
    record();

    const compactRes = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": "qa-optb" },
      body: JSON.stringify({
        model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
        messages: [
          { role: "user", content: HISTORY_SENTINEL },
          { role: "assistant", content: "noted" },
          { role: "user", content: compactPrompt },
        ],
      }),
    });
    expect(compactRes.status).toBe(200);
    const marker = extractMarker(await compactRes.text());
    expect(marker).toContain("codex-opaque-state:v1");

    // ── 阶段二：关掉开关（模拟运维止血），拿同一个 marker 再发一轮 ──
    setClaudeCodeOpaqueCompactExperimental(false);
    calls = [];

    const afterDisable = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": "qa-optb" },
      body: JSON.stringify({
        model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
        messages: [
          { role: "assistant", content: marker },
          { role: "user", content: "continue" },
        ],
      }),
    });

    const body = calls[calls.length - 1]?.body ?? {};
    const inputJson = JSON.stringify(body.input ?? []);
    const instructions = String(body.instructions ?? "");

    const hasSystem = inputJson.includes(SYSTEM_SENTINEL) || instructions.includes(SYSTEM_SENTINEL);
    const hasCompaction = inputJson.includes("compaction");
    const hasPlaceholder = inputJson.includes("could not be restored");
    const leaksRawMarker = inputJson.includes("codex-opaque-state:v1");

    console.log(`[OPT-B] HTTP 状态 = ${afterDisable.status}（409 = 止血阀形同虚设）`);
    console.log(`[OPT-B] 上游请求次数 = ${calls.length}`);
    console.log(`[OPT-B] 系统提示词还在 = ${hasSystem}`);
    console.log(`[OPT-B] 走了恢复路径（出现 compaction item）= ${hasCompaction}`);
    console.log(`[OPT-B] 用占位文案替换了 marker = ${hasPlaceholder}`);
    console.log(`[OPT-B] 原始 marker 泄漏进上游 = ${leaksRawMarker}`);
    console.log(`[OPT-B] 被压缩掉的历史（${HISTORY_SENTINEL.slice(0, 20)}...）还在 = ${inputJson.includes(HISTORY_SENTINEL)}`);
    console.log(`[OPT-B] instructions 前 120 字 = ${instructions.slice(0, 120)}`);
    console.log(`[OPT-B] input 全文前 400 字 = ${inputJson.slice(0, 400)}`);
    console.log(`[OPT-B] input 各项 role/type = ${JSON.stringify(
      (body.input as Array<Record<string, unknown>> ?? []).map((i) => i.role ?? i.type),
    )}`);

    // B-1：不得 409
    expect(afterDisable.status).toBe(200);
    // B-2：不得再走恢复路径
    expect(hasCompaction).toBe(false);
    // 系统提示词必须回来（这正是选项 B 想达成的止血效果）
    expect(hasSystem).toBe(true);
    // 原始 marker 不能原文泄漏给上游
    expect(leaksRawMarker).toBe(false);
  });
});
