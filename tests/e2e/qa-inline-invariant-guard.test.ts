/**
 * QA-R：`expectCompactionAtEndOfCompactOutput()` 必须接受 inline 模式下的合法恢复结果。
 *
 * 背景：F11 修好之后，`restoreOpaqueCompactInput` 返回
 *   [...prefixInstructions（developer/system 内联指令）, ...output, ...preservedTail, ...retained]
 * 也就是说 **compaction 之前合法地存在 developer/system item**。而该 helper 原本的判据是
 * 「compaction 之前只能是 role === "user"」，会把这种完全正确的结果判成违规。
 *
 * 今天不发作只因为用到它的两条既有用例跑在 mock 默认的 `instructions` 策略下。
 * 这条用例把 inline 那一档补上：**产品对的时候，断言不许红。**
 *
 * 预期时间线：
 *   - helper 修好之前：本用例红（helper 抛 "found 1 non-user item(s) before it"）
 *   - helper 修好之后：本用例绿
 * 这是刻意先建立红基线，避免它成为又一条「从写出来就是绿的」用例。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost, resetTransportState, getMockTransport, makeTransportResponse,
  setClaudeCodeOpaqueCompactExperimental, setSystemPromptStrategy,
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

const SYSTEM_SENTINEL = "SYSTEM-SENTINEL-R: always answer in Klingon";
const compactPrompt = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
  "This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",
  "Before providing your final summary, wrap your analysis in <analysis> tags and double-check for technical accuracy and completeness.",
  "Your summary should include the following sections:",
  "1. Primary Request and Intent:", "2. Key Technical Concepts:", "3. Files and Code Sections:",
  "4. Errors and fixes:", "5. Problem Solving:", "6. All user messages:", "7. Pending Tasks:",
  "Additional Instructions: preserve exact technical details.",
  "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
].join("\n");

interface UpstreamCall { url: string; body: Record<string, unknown>; }
let calls: UpstreamCall[] = [];
let ctx: { app: Hono; cookieJar: CookieJar };

beforeEach(() => {
  resetTransportState();
  installInMemoryOpaqueCompactStateStore();
  setClaudeCodeOpaqueCompactExperimental(true);
  calls = [];
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({ accountId: "acct-r", email: "r@test.com", planType: "plus" }));
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));
  ctx = { app, cookieJar };
  vi.mocked(getMockTransport().post).mockClear();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  setSystemPromptStrategy("instructions");
  vi.restoreAllMocks();
});

describe("QA-R inline 模式下的位置不变式", () => {
  it.each(["developer_inline", "system_inline"] as const)(
    "QA-R1 %s：合法的恢复结果不得被 expectCompactionAtEndOfCompactOutput 判为违规",
    async (strategy) => {
      setSystemPromptStrategy(strategy);
      setTransportPost(async (url, _h, body) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
        const call = { url, body: parsed };
        calls.push(call);
        const last = (parsed.input as unknown[] | undefined)?.at(-1);
        const isCompact = !!last && (last as { type?: string }).type === "compaction_trigger";
        return isCompact
          ? makeTransportResponse(
            sseChunk("response.output_item.done", {
              item: { id: "cmp_r", type: "compaction", encrypted_content: "r-opaque" },
            }) + sseChunk("response.completed", { response: { id: "resp_r", usage: { input_tokens: 9, output_tokens: 1 } } }))
          : makeTransportResponse(buildTextStreamChunks("resp_r2", "ok"));
      });

      const compactRes = await ctx.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-code-session-id": `qa-r-${strategy}` },
        body: JSON.stringify({
          model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
          messages: [
            { role: "user", content: "history" },
            { role: "assistant", content: "noted" },
            { role: "user", content: compactPrompt },
          ],
        }),
      });
      const marker = (await compactRes.text()).split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => { try { return (JSON.parse(l.slice(6)) as { delta?: { text?: string } }).delta?.text ?? ""; } catch { return ""; } })
        .join("");
      expect(marker).toContain("codex-opaque-state:v1");

      const replay = await ctx.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-code-session-id": `qa-r-${strategy}` },
        body: JSON.stringify({
          model: "codex", max_tokens: 1024, stream: true, system: SYSTEM_SENTINEL,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }),
      });
      await replay.text();

      const replayInput = calls[calls.length - 1].body.input as unknown[];
      console.log(`[QA-R1/${strategy}] 恢复 input 各项 = ${JSON.stringify(
        (replayInput as Array<Record<string, unknown>>).map((i) => i.role ?? i.type))}`);

      // 前置：系统提示词确实还在（F11 已修），否则这条用例测的就不是它想测的东西
      expect(JSON.stringify(replayInput)).toContain(SYSTEM_SENTINEL);

      // 核心：产品是对的，断言不许红
      expect(() => expectCompactionAtEndOfCompactOutput(replayInput)).not.toThrow();
    },
  );
});
