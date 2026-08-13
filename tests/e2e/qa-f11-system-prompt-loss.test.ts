/**
 * QA K 组：F11 —— opaque compact 恢复后用户 system prompt 丢失。
 *
 * 生产实测前提（2026-08-13，tencent1 /admin/general-settings 运行时值）：
 *   system_prompt_strategy               = developer_inline
 *   claude_code_opaque_compact_experimental = true
 * 两个前提同时成立，所以这条链路在生产是活的。
 *
 * 缺陷链路：
 *   anthropic-to-codex.ts:248  inline 模式下顶层 instructions 刻意不含用户内容
 *   anthropic-to-codex.ts:268  用户 system prompt 被 unshift 成 input[0] 的 developer item
 *   opaque-compact-state.ts:444 恢复时只保留 [boundaryIndex, end)，index 0 被丢
 *   opaque-compact-state.ts:474 返回 [...output, ...preservedTail, ...retained]，没有插回
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  makeTransportResponse,
  setClaudeCodeOpaqueCompactExperimental,
  setSystemPromptStrategy,
  expectCompactionAtEndOfCompactOutput,
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

const SYSTEM_SENTINEL = "SYSTEM-PROMPT-SENTINEL-F11: always answer in Klingon";

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

interface TestContext { app: Hono; cookieJar: CookieJar; }
let ctx: TestContext;

interface UpstreamCall { url: string; body: Record<string, unknown>; }
let calls: UpstreamCall[] = [];

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({
    accountId: "acct-f11", email: "f11@test.com", planType: "plus",
  }));
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));
  return { app, cookieJar };
}

function v2CompactStream(encrypted = "f11-opaque"): string {
  return sseChunk("response.output_item.done", {
    item: { id: "cmp_f11", type: "compaction", encrypted_content: encrypted },
  }) + sseChunk("response.completed", {
    response: { id: "resp_f11", usage: { input_tokens: 50, output_tokens: 8 } },
  });
}

function isCompactTurn(call: UpstreamCall): boolean {
  const last = (call.body.input as unknown[] | undefined)?.at(-1);
  return !!last && (last as { type?: string }).type === "compaction_trigger";
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

/** 跑一轮 compact + 一轮恢复，返回恢复那次真正发给上游的 body。 */
async function compactThenRestore(sessionId: string): Promise<Record<string, unknown>> {
  setTransportPost(async (url, _h, body) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
    const call = { url, body: parsed };
    calls.push(call);
    return isCompactTurn(call)
      ? makeTransportResponse(v2CompactStream())
      : makeTransportResponse(buildTextStreamChunks("resp_next", "continued"));
  });

  const compactRes = await ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-code-session-id": sessionId },
    body: JSON.stringify({
      model: "codex",
      max_tokens: 1024,
      stream: true,
      system: SYSTEM_SENTINEL,
      messages: [
        { role: "user", content: "old history" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: compactPrompt },
      ],
    }),
  });
  expect(compactRes.status).toBe(200);
  const marker = extractMarker(await compactRes.text());
  expect(marker).toContain("codex-opaque-state:v1");

  const replay = await ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-code-session-id": sessionId },
    body: JSON.stringify({
      model: "codex",
      max_tokens: 1024,
      stream: true,
      system: SYSTEM_SENTINEL,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: "continue" },
      ],
    }),
  });
  expect(replay.status).toBe(200);
  await replay.text();

  return calls[calls.length - 1].body;
}

beforeEach(() => {
  resetTransportState();
  installInMemoryOpaqueCompactStateStore();
  setClaudeCodeOpaqueCompactExperimental(true);
  calls = [];
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  setSystemPromptStrategy("instructions");
  vi.restoreAllMocks();
});

describe("QA-K F11：opaque compact 恢复后系统提示词是否丢失", () => {
  it.each([
    ["developer_inline", "developer"],
    ["system_inline", "system"],
  ] as const)("QA-K2 %s：恢复轮里系统提示词还在吗", async (strategy, _role) => {
    setSystemPromptStrategy(strategy);
    const restored = await compactThenRestore(`qa-f11-${strategy}`);

    const input = restored.input as Array<Record<string, unknown>>;
    const instructions = String(restored.instructions ?? "");
    const inputHasSentinel = JSON.stringify(input).includes(SYSTEM_SENTINEL);
    const instructionsHasSentinel = instructions.includes(SYSTEM_SENTINEL);

    console.log(`[QA-K2/${strategy}] input 里有系统提示词 = ${inputHasSentinel}`);
    console.log(`[QA-K2/${strategy}] instructions 里有系统提示词 = ${instructionsHasSentinel}`);
    console.log(`[QA-K2/${strategy}] instructions 长度 = ${instructions.length}`);
    console.log(`[QA-K2/${strategy}] input[0] = ${JSON.stringify(input[0]).slice(0, 160)}`);
    console.log(`[QA-K2/${strategy}] input 各项 role/type = ${JSON.stringify(
      input.map((i) => i.role ?? i.type),
    )}`);

    // 对照：compact 那一轮（第一次上游请求）系统提示词本来是在的
    const compactTurn = calls.find(isCompactTurn)!;
    console.log(`[QA-K2/${strategy}] 对照 — compact 轮 input 里有系统提示词 = ${
      JSON.stringify(compactTurn.body.input).includes(SYSTEM_SENTINEL)}`);

    // 期望：恢复轮必须仍然带着用户系统提示词（在 input 或 instructions 任一处）
    expect(inputHasSentinel || instructionsHasSentinel).toBe(true);
  });

  it.each([
    ["developer_inline"],
    ["system_inline"],
  ] as const)("QA-K4 %s 丢失是持续的还是只丢一轮：同一会话里连续三轮恢复", async (strategy) => {
    setSystemPromptStrategy(strategy);
    setTransportPost(async (url, _h, body) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
      const call = { url, body: parsed };
      calls.push(call);
      return isCompactTurn(call)
        ? makeTransportResponse(v2CompactStream())
        : makeTransportResponse(buildTextStreamChunks("resp_n", "ok"));
    });

    const compactRes = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": `qa-f11-multi-${strategy}` },
      body: JSON.stringify({
        model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
        messages: [
          { role: "user", content: "old history" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: compactPrompt },
        ],
      }),
    });
    const marker = extractMarker(await compactRes.text());

    // 客户端在后续每一轮都会继续带着这个 marker（Claude Code 的实际行为）
    const results: boolean[] = [];
    for (let round = 1; round <= 3; round += 1) {
      const res = await ctx.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-code-session-id": `qa-f11-multi-${strategy}` },
        body: JSON.stringify({
          model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
          messages: [
            { role: "assistant", content: marker },
            { role: "user", content: `follow-up ${round}` },
          ],
        }),
      });
      await res.text();
      const body = calls[calls.length - 1].body;
      const present = JSON.stringify(body.input).includes(SYSTEM_SENTINEL)
        || String(body.instructions ?? "").includes(SYSTEM_SENTINEL);
      results.push(present);
    }

    console.log(`[QA-K4/${strategy}] 连续 3 轮恢复，系统提示词是否还在 = ${JSON.stringify(results)}`);
    expect(results).toEqual([true, true, true]);
  });

  it.each([
    ["developer_inline", "developer"],
    ["system_inline", "system"],
  ] as const)("QA-K2-control %s 下普通一轮（不经 compact）：系统提示词本来是在 input[0] 的", async (strategy, expectedRole) => {
    setSystemPromptStrategy(strategy);
    setTransportPost(async (url, _h, body) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
      calls.push({ url, body: parsed });
      return makeTransportResponse(buildTextStreamChunks("resp_plain", "hi"));
    });

    const res = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-code-session-id": "qa-f11-control" },
      body: JSON.stringify({
        model: "codex",
        max_tokens: 1024,
        stream: true,
        system: SYSTEM_SENTINEL,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const input = calls[0].body.input as Array<Record<string, unknown>>;
    console.log(`[QA-K2-control/${strategy}] input[0] = ${JSON.stringify(input[0]).slice(0, 200)}`);
    console.log(`[QA-K2-control/${strategy}] instructions 长度 = ${String(calls[0].body.instructions ?? "").length}`);

    // 这条必须过 —— 否则说明 inline 策略本身就没工作，
    // 那 K2 的丢失就不能归因给 opaque compact 恢复路径
    expect(input[0]).toMatchObject({ role: expectedRole });
    expect(JSON.stringify(input[0])).toContain(SYSTEM_SENTINEL);
  });

  it("QA-K3 instructions 策略：同样条件下是否触发", async () => {
    setSystemPromptStrategy("instructions");
    const restored = await compactThenRestore("qa-f11-instructions");

    const input = restored.input as Array<Record<string, unknown>>;
    const instructions = String(restored.instructions ?? "");
    const inputHasSentinel = JSON.stringify(input).includes(SYSTEM_SENTINEL);
    const instructionsHasSentinel = instructions.includes(SYSTEM_SENTINEL);

    console.log(`[QA-K3] input 里有系统提示词 = ${inputHasSentinel}`);
    console.log(`[QA-K3] instructions 里有系统提示词 = ${instructionsHasSentinel}`);
    console.log(`[QA-K3] input 各项 role/type = ${JSON.stringify(
      input.map((i) => i.role ?? i.type),
    )}`);

    expect(inputHasSentinel || instructionsHasSentinel).toBe(true);
  });
});

// ── 断言本身的回归测试（防止判据与产品形状再次脱节） ─────────────
//
// `expectCompactionAtEndOfCompactOutput` 的判据原来是「compaction 之前只能是
// user」，那是 F11 修复**之前**的形状。F11 修好之后 inline 模式下一个完全正确
// 的恢复结果（前缀有 developer/system 指令项）会被判成违规——而用到它的用例
// 恰好都跑在默认的 instructions 策略下，所以不发作。
//
// 这类「断言绿着、但钉的位置是错的」没有任何机制会暴露，只能靠给断言本身写
// 用例。下面同时钉住两个方向：该放行的放行、该拦住的仍然拦住。
describe("expectCompactionAtEndOfCompactOutput 判据本身", () => {
  const C = { type: "compaction", encrypted_content: "opaque" };

  it("放行：inline 前缀指令 + 保留的 user 消息（F11 修好后的真实形状）", () => {
    expect(expectCompactionAtEndOfCompactOutput([
      { role: "developer", content: [{ type: "input_text", text: "指令" }] },
      { role: "user", content: "history" },
      C,
      { role: "user", content: "continue" },
    ])).toBe(2);
    expect(expectCompactionAtEndOfCompactOutput([
      { role: "system", content: [{ type: "input_text", text: "指令" }] },
      { role: "user", content: "history" },
      C,
    ])).toBe(2);
  });

  it("放行：instructions 模式（前缀里没有指令项）", () => {
    expect(expectCompactionAtEndOfCompactOutput([{ role: "user", content: "h" }, C])).toBe(1);
  });

  it("仍然拦住：指令项混在历史中间（不是开头连续的前缀）", () => {
    expect(() => expectCompactionAtEndOfCompactOutput([
      { role: "user", content: "h" },
      { role: "developer", content: "混在中间" },
      { role: "user", content: "h2" },
      C,
    ])).toThrow();
  });

  it("仍然拦住：assistant 历史出现在 compaction 之前", () => {
    expect(() => expectCompactionAtEndOfCompactOutput([
      { role: "user", content: "h" },
      { role: "assistant", content: "不该在这" },
      C,
    ])).toThrow();
  });

  it("仍然拦住：compaction 数量不是 1", () => {
    expect(() => expectCompactionAtEndOfCompactOutput([{ role: "user", content: "h" }])).toThrow();
    expect(() => expectCompactionAtEndOfCompactOutput([C, C])).toThrow();
  });
});
