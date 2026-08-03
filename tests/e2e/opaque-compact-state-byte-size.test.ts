/**
 * ★ 8.20（team-lead 派发，task #78，生产事故复盘的第三步）：真正落盘加密
 * 存储的是 `compact.output`（模型返回的摘要本身）+ `preservedTail`（compact
 * 请求之后紧跟着的少量消息，通常很小），**不是** compact 请求发出去的
 * 原始 input（真实事故里那 27 万 token 的历史对话）。所以不需要真的构造
 * 一个 27 万 token 的输入去打 compact——只需要让 mock 的上游返回一段和
 * 真实场景 postTokens 同量级、且密度贴近真实摘要（不是"一句话总结"）的
 * 输出，直接读 sqlite 的 `byte_size` 列。
 *
 * 参照物（mac-mini 会话原文，真实观测）：两次自动压缩 postTokens 分别是
 * 10393 / 20646——这是这次生成的摘要文本要对齐的量级，取上限（更保守，
 * 不低估）。
 *
 * AES-256-GCM 不压缩，`byte_size = ciphertext.length(==plaintext.length)
 * + nonce(12) + tag(16)`（见 `opaque-compact-repository.ts:878`）——所以
 * 内容本身是不是"真的技术摘要"不影响加密后字节数，起决定作用的只有
 * **序列化后的字符长度**（含 JSON 转义开销，换行符会被转义成 `\n` 占两个
 * 字符）。这里仍然构造贴近真实结构的内容（分段、代码块、文件路径），
 * 主要是为了让换行/引号密度贴近真实摘要，不因为"纯平铺文本没有换行"而
 * 低估 JSON 转义开销。
 *
 * 完全本地、不碰生产：`startOpaqueCompactRuntime()` + 临时目录 sqlite，
 * upstream 全部 mock。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  setTransportPost,
  resetTransportState,
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
import {
  startOpaqueCompactRuntime,
  type OpaqueCompactRuntimeHandle,
} from "@src/routes/shared/opaque-compact-runtime.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

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

/**
 * 生成一段贴近真实 Claude Code 7 段式摘要结构的文本，目标 token 量级取
 * mac-mini 真实观测的上限（20646）并留一点余量（约 21000 token ≈
 * 21000*2.2 ≈ 46200 字符，仓库自己校准过的 chars/token≈2.2）。分段、
 * 代码块、文件路径都是真实结构，不是纯平铺重复字符串。
 */
function buildRealisticCompactSummary(targetChars: number): string {
  const codeBlock = [
    "```ts",
    "export function resolveWindowCutoffMs(windowHours: number | \"all\", nowMs: number): number | null {",
    "  return windowHours === \"all\" ? null : nowMs - windowHours * 3600_000;",
    "}",
    "```",
  ].join("\n");
  const paragraph = (i: number) => [
    `${i}. File \`src/routes/shared/opaque-compact-repository${i}.ts\` — pruneWithinTransaction() enforces`,
    `   capacity/maxBytes via LRU ordered by last_used_at ASC, created_at ASC; TTL never drives bulk`,
    `   deletion, only per-read authenticated expiry checks. Fixed bug where eviction candidate ${i}`,
    `   selection skipped protected rows incorrectly under concurrent writers (session_${i}, account_${i}).`,
    "",
    codeBlock,
    "",
    `   Follow-up: verified nearest-rank clamping and tie-to-lower semantics hold for model gpt-5.${i % 9}.`,
    "",
  ].join("\n");
  const sections = [
    "<analysis>\nReviewed full conversation history across " + "many" + " turns, focusing on state transitions.\n</analysis>",
    "<summary>",
    "1. Primary Request and Intent:\n   User asked to diagnose and fix a production incident involving opaque compact 409s, " +
      "distinguishing manual vs automatic trigger paths, and to implement a TTL/observability fix without touching production.",
    "2. Key Technical Concepts:\n   - Opaque compact state TTL and LRU eviction\n   - AES-256-GCM sealed records\n   - Account binding via requiredEntryId\n   - Self-healable failure families (not_found/expired)",
    "3. Files and Code Sections:",
  ];
  let body = sections.join("\n\n");
  let i = 0;
  while (body.length < targetChars) {
    i += 1;
    body += "\n\n" + paragraph(i);
  }
  body += "\n\n4. Errors and fixes:\n   Documented each fix with root cause and verification.\n\n" +
    "5. Problem Solving:\n   Cross-referenced production error-log entries with client transcript timestamps.\n\n" +
    "6. All user messages:\n   (verbatim requests preserved for continuity)\n\n" +
    "7. Pending Tasks:\n   Verify max_bytes headroom under concurrent multi-agent usage.\n</summary>";
  return body;
}

let ctx: { app: Hono; accountPool: AccountPool; cookieJar: CookieJar; proxyPool: ProxyPool };
let runtime: OpaqueCompactRuntimeHandle | undefined;
let dir = "";
let keyDir = "";

beforeAll(() => {
  resetTransportState();
  dir = mkdtempSync(resolve(tmpdir(), "opaque-byte-size-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-byte-size-keys-"));
  setClaudeCodeOpaqueCompactExperimental(true);
  runtime = startOpaqueCompactRuntime({
    enabled: true,
    ttlMinutes: 10080,
    capacity: 1024,
    maxBytes: 64 * 1024 * 1024,
    directory: dir,
    keyringFile: resolve(keyDir, "keyring.json"),
  });
  expect(runtime.ready).toBe(true);

  loadStaticModels();
  const accountPool = new AccountPool();
  accountPool.addAccount(createValidJwt({ accountId: "acct-byte-size", email: "byte-size@test.com", planType: "plus" }));
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  ctx = { app, accountPool, cookieJar, proxyPool };
});

afterAll(() => {
  ctx?.cookieJar.destroy();
  ctx?.proxyPool.destroy();
  ctx?.accountPool.destroy();
  runtime?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("opaque compact state byte_size — real-scale measurement (task #78)", () => {
  it("measures byte_size for a compact output matching real-world postTokens (~21k tokens / ~46k chars) and reports maxBytes headroom", async () => {
    const summaryText = buildRealisticCompactSummary(46_200);
    // 记录实际字符数，供换算——不同分段拼接后长度会略超目标，如实记录。
    console.log(`[byte-size-measurement] generated summary length = ${summaryText.length} chars`);

    setTransportPost(async (url) => url.endsWith("/codex/responses/compact")
      ? makeErrorTransportResponse(200, JSON.stringify({
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: summaryText }] },
          ],
        }))
      : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

    const res = await request({
      model: "codex",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-byte-size-measurement" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("codex-opaque-state:v1");

    // 直接开临时 sqlite 读 byte_size 列——不经过任何抽象层，读的是
    // OpaqueCompactRepository.save() 真实落盘的那一行。
    const db = new DatabaseSync(resolve(dir, "state.db"), { readOnly: true });
    const row = db.prepare("SELECT byte_size FROM opaque_states ORDER BY created_at DESC LIMIT 1").get() as
      | { byte_size: number }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    const byteSize = Number(row!.byte_size);
    const maxBytes = 64 * 1024 * 1024;
    const statesPerBudget = Math.floor(maxBytes / byteSize);

    console.log(`[byte-size-measurement] byte_size = ${byteSize} bytes for ~${summaryText.length} char summary`);
    console.log(`[byte-size-measurement] 64MiB / byte_size = ${statesPerBudget} states fit in current maxBytes budget`);
    console.log(`[byte-size-measurement] bytes per summary char ≈ ${(byteSize / summaryText.length).toFixed(3)}`);

    // 断言留出宽松区间——这条测试的价值是打印真实测量值供人工决策，不是
    // 卡死一个精确数字（摘要生成器的具体字符数会随内容微调变化）。
    expect(byteSize).toBeGreaterThan(30_000);
    expect(byteSize).toBeLessThan(120_000);
  });
});
