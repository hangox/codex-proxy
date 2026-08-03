/**
 * ★ 8.20（team-lead 派发，task #78 续）：TTL 从 12h 放到 7 天之后，
 * predecessor state 从不显式删除（只靠 LRU/TTL 自然回收）意味着存量条数
 * 按 ~14 倍累积——`capacity`(1024) 可能先于 `maxBytes`(64MiB) 触顶
 * （实测 byte_size≈48.8KB < 64MiB/1024=64KB，按 team-lead 的判据，条数
 * 上限确实先到）。
 *
 * 这个文件回答两个具体问题（本地测，不碰生产）：
 *
 * 1. 每次 recompact 净增几条？有没有上界，还是无限累积到 capacity？
 * 2. 顶到 capacity 之后是什么后果——正常 LRU 逐出（会话优雅降级，200 继续
 *    可用）还是 `state_too_large` 抛错回滚（压缩当场硬失败）？
 *    `opaque-compact-repository.ts` 的 `pruneWithinTransaction` 里
 *    `victim === undefined → throw` 分支只在"受保护的行本身就超过
 *    capacity"时触发（当前写入的新行 + 它的 predecessor 两行永远受保护，
 *    不参与淘汰）——正常 capacity（1024，或者这里为了快速复现调小到 8）
 *    远大于这个保护下限（2），预期是优雅降级；capacity 小到 1 才会真的
 *    触发硬失败分支，用来确认"万一真的顶到"时客户端看到的是什么。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

function buildApp(): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  accountPool.addAccount(createValidJwt({ accountId: "acct-capacity", email: "capacity@test.com", planType: "plus" }));
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
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

let ctx: TestContext;
let runtime: OpaqueCompactRuntimeHandle | undefined;
let dir = "";
let keyDir = "";

function setupRuntime(capacity: number) {
  dir = mkdtempSync(resolve(tmpdir(), "opaque-capacity-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-capacity-keys-"));
  runtime = startOpaqueCompactRuntime({
    enabled: true,
    ttlMinutes: 10080,
    capacity,
    // maxBytes 给够大——这个文件只测条数上限的行为，不希望字节预算提前
    // 介入把两个变量混在一起。
    maxBytes: 10 * 1024 * 1024,
    directory: dir,
    keyringFile: resolve(keyDir, "keyring.json"),
  });
  expect(runtime.ready).toBe(true);
  ctx = buildApp();
}

function countRows(): number {
  const db = new DatabaseSync(resolve(dir, "state.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  resetTransportState();
  setClaudeCodeOpaqueCompactExperimental(true);
});

afterEach(() => {
  ctx?.cookieJar.destroy();
  ctx?.proxyPool.destroy();
  ctx?.accountPool.destroy();
  runtime?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

describe("opaque compact state — capacity growth under repeated recompact (task #78 续)", () => {
  it("每次 recompact 净增一条（predecessor 不删），持续超过 capacity 后行数被 LRU 收敛到 capacity 附近，请求全部优雅成功（不硬失败）", async () => {
    setupRuntime(8);
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

    const sessionId = "session-capacity-growth";
    let marker: string | null = null;
    const rowCounts: number[] = [];
    const statuses: number[] = [];

    // 15 次连续 recompact（第一次是 root），capacity=8——中途一定会触顶。
    for (let i = 0; i < 15; i += 1) {
      const messages = marker
        ? [
            { role: "assistant", content: marker },
            { role: "user", content: `more history ${i}` },
            { role: "user", content: compactPrompt },
          ]
        : [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }];

      const res = await request(ctx, {
        model: "codex", max_tokens: 1024, stream: true, messages,
      }, { "x-claude-code-session-id": sessionId });
      statuses.push(res.status);
      if (res.status === 200) {
        marker = extractMarkerFromResponse(await res.text());
      }
      rowCounts.push(countRows());
    }

    console.log(`[capacity-growth] row counts after each of 15 recompacts: ${rowCounts.join(", ")}`);
    console.log(`[capacity-growth] statuses: ${statuses.join(", ")}`);

    // 决定性断言 1：全部 15 次都优雅成功——顶到 capacity 不等于压缩失败，
    // 是"存不下的旧记录被挤掉"，不是"这次请求失败"。
    expect(statuses.every((s) => s === 200)).toBe(true);
    // 决定性断言 2：行数被 LRU 收敛在 capacity 附近，不会无限增长。
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(8);
    // 决定性断言 3：真的顶到过上限（不是因为 15 次不够多才没触发）。
    expect(rowCounts[rowCounts.length - 1]).toBe(8);
  }, 30_000);

  it("capacity 小于'受保护行数下限'（=2：当前写入行+它的 predecessor）时，recompact 真的会硬失败——确认客户端看到的是 409 而不是崩溃或静默丢数据", async () => {
    setupRuntime(1);
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

    const sessionId = "session-capacity-hard-limit";
    const rootRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": sessionId });
    expect(rootRes.status).toBe(200);
    expect(countRows()).toBe(1); // root：capacity=1 刚好放得下唯一一条。
    const marker = extractMarkerFromResponse(await rootRes.text());

    // recompact：这次写入需要同时保护"新行"和它的 predecessor（旧的 root
    // 行）共 2 行，但 capacity=1——受保护行数本身就超过 capacity，
    // pruneWithinTransaction 找不到可淘汰的 victim，事务回滚。
    const recompactRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: "more history" },
        { role: "user", content: compactPrompt },
      ],
    }, { "x-claude-code-session-id": sessionId });
    const body = await recompactRes.text();
    console.log(`[capacity-hard-limit] recompact status=${recompactRes.status} body=${body.slice(0, 300)}`);

    // 决定性断言：不是静默丢数据（行数没变，事务确实回滚了，root 记录完好），
    // 也不是进程崩溃/500——是一个结构化的 409（走 messages.ts 里
    // `opaqueRestore.restored && !isRecompactContextOverflow` 这条既有分支，
    // reason 仍然是 `recompact_failed_original_account`）。
    // ★ #81：`pruneWithinTransaction` 找不到可淘汰 victim 时抛的正是
    // `state_too_large`（见 opaque-compact-repository.ts 该分支的注释——
    // "capacity or byte budget cannot be satisfied without evicting
    // protected records"，跟单条记录本身超过 maxBytes 是同一个用户可感知
    // 情况："这次要保存的东西放不下"），`deriveRecompactFailureCause` 会把
    // `OpaqueCompactStateError.reason` 原样透传成 `cause`，因此这条请求
    // 拿到的文案是 #81 新拆出来的"容量耗尽"桶，不再是账号失败那句——这正是
    // 当初报给 team-lead 的那个问题（容量耗尽和账号失败共用同一句用户
    // 文案，用户分不出是哪一种），现在已经修了。
    expect(recompactRes.status).toBe(409);
    expect(body).toContain("too large to save");
    expect(body).not.toContain("could not be compacted on its original account");
    expect(countRows()).toBe(1); // 事务回滚——root 记录原封不动，没有半写状态。
  }, 30_000);
});
