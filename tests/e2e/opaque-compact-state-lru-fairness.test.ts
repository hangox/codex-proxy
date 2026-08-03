/**
 * ★ 8.20（team-lead 派发，比 capacity 数值本身更重要的那条假设）：
 *
 * `pruneWithinTransaction` 按 `last_used_at ASC` **全局**排序淘汰，不区分
 * "结构上已经死掉的废弃历史代"（没有任何 incoming edge，纯粹是 recompact
 * 链条上被超越的旧记录）和"某个会话当前仍然有效、只是用户没碰"的活跃
 * state。
 *
 * ★★ 读代码发现的关键机制（比假设本身更实锤）：`OpaqueCompactRepository
 * .load()` 实现了 8.4 sliding TTL——**任何一次成功 resolve（含 recompact
 * 时读取 predecessor 来合并 preservedTail）都会把该行的 `last_used_at`
 * 和 `expires_at` 一起顺延到 `now() + slideTtlMs`**（见该文件 1341-1352
 * 行注释）。这意味着：
 *
 * - 一个**忙碌**会话，只要还在收发消息/反复 recompact，它自己的
 *   `last_used_at` 会被不断刷新到"现在"，从 LRU 的角度看永远不会变旧。
 * - 一个**闲置但仍然有效**（没有 TTL 过期）的会话，`last_used_at` 冻结在
 *   最后一次被摸到的时刻，会随着时间流逝稳定变成全局最旧的那一批——
 *   跟它内容有没有价值、TTL 到没到期完全无关。
 *
 * **结论如果成立**：仅仅调大 `capacity`/`max_bytes` 只是推迟问题——只要
 * 团队总体活跃量相对 capacity 足够高，闲置几天但仍在 TTL 有效期内的会话
 * 依然会被更"新鲜"的忙碌会话的历史废代挤出去，症状和 TTL 过期一模一样
 * （`not_found` 409），只是死因换了。
 *
 * 这个文件本地实测这个具体场景（不碰生产）：一个刻意"闲置 3 天但仍在 7
 * 天 TTL 内"的会话，会不会先于"3 天里持续产生废代"的忙碌会话的历史记录
 * 被逐出。
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
  accountPool.addAccount(createValidJwt({ accountId: "acct-fairness", email: "fairness@test.com", planType: "plus" }));
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

function countRows(dir: string): number {
  const db = new DatabaseSync(resolve(dir, "state.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

let ctx: TestContext;
let runtime: OpaqueCompactRuntimeHandle | undefined;
let dir = "";
let keyDir = "";

afterEach(() => {
  ctx?.cookieJar.destroy();
  ctx?.proxyPool.destroy();
  ctx?.accountPool.destroy();
  runtime?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetTransportState();
  setClaudeCodeOpaqueCompactExperimental(true);
});

describe("opaque compact state — LRU fairness: idle-but-alive vs. busy churn (team-lead's sliding-TTL hypothesis)", () => {
  it("一个闲置 3 天、但仍在 7 天 TTL 内的会话，会先于其它会话更新鲜的废弃历史代被逐出——症状和 TTL 过期一样是 not_found", async () => {
    let clock = 1_700_000_000_000; // 固定基准时刻，不用真实 Date.now()，全程手动推进。
    const now = () => clock;

    dir = mkdtempSync(resolve(tmpdir(), "opaque-fairness-"));
    keyDir = mkdtempSync(resolve(tmpdir(), "opaque-fairness-keys-"));
    runtime = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 10080, // 7 天，和这次要上线的新默认值一致。
      capacity: 5, // 调小快速复现，不用真跑到 1024。
      maxBytes: 10 * 1024 * 1024, // 给够大，只测条数驱动的淘汰。
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
      now,
    });
    expect(runtime.ready).toBe(true);
    ctx = buildApp();

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

    // ① t=0：闲置会话做一次 root compact，此后再也不碰它——last_used_at
    // 冻结在 t=0，直到测试结束都不再被刷新。
    const idleRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-idle-but-alive" });
    expect(idleRes.status).toBe(200);
    const idleMarker = extractMarkerFromResponse(await idleRes.text());
    expect(countRows(dir)).toBe(1);

    // ② 推进 3 天——闲置会话此时仍然完全在 7 天 TTL 有效期内（还剩 4 天）。
    clock += 3 * 24 * 3600_000;

    // ③ 忙碌会话：root + 连续 6 次 recompact，每次间隔 1 小时（模拟同一
    // 团队里另一个人手上真的在持续工作），每次 recompact 都会读取
    // predecessor（sliding TTL 顺延它的 last_used_at），旧的那一代随后
    // 变成结构上的废代（不再有 incoming edge），但它最后一次被摸到的
        // 时间点仍然比"闲置会话"新得多。capacity=5，这轮churn 会持续触发淘汰。
    let busyMarker: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const messages = busyMarker
        ? [
            { role: "assistant", content: busyMarker },
            { role: "user", content: `more history ${i}` },
            { role: "user", content: compactPrompt },
          ]
        : [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }];
      const res = await request(ctx, {
        model: "codex", max_tokens: 1024, stream: true, messages,
      }, { "x-claude-code-session-id": "session-busy-churning" });
      expect(res.status).toBe(200);
      busyMarker = extractMarkerFromResponse(await res.text());
      clock += 3600_000; // +1 小时
    }

    console.log(`[lru-fairness] rows after busy churn: ${countRows(dir)} (capacity=5)`);

    // ④ 决定性验证：闲置会话的用户此刻回来了（仍在自己 7 天 TTL 窗口内，
    // 只过去了 3 天），带着 idleMarker 发一条**普通消息**（不是 compact
    // 请求——这正是真实事故复现的形状：treatAsNoMarker 的自愈只在
    // "这次请求本身就是压缩请求"时放行，普通续接消息撞上死掉的 state
    // 直接 409，见 messages.ts 的 `compactPrompt !== null` 判断）。
    const idleReturnRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "assistant", content: idleMarker }, { role: "user", content: "I'm back, continue where we left off" }],
    }, { "x-claude-code-session-id": "session-idle-but-alive" });
    const idleReturnBody = await idleReturnRes.text();
    console.log(`[lru-fairness] idle session return: status=${idleReturnRes.status} body=${idleReturnBody.slice(0, 300)}`);

    // 核心断言：闲置会话在自己 TTL 窗口内回来，却已经被挤掉——409，
    // 不是 200。这就是"仅仅调大 capacity 只是推迟问题"的实锤：只要总体
    // churn 速度相对 capacity 足够高，任何 idle-但仍在 TTL 内的会话迟早
    // 会被更"新鲜"的废代挤掉，和 capacity 具体设多大无关，只是时间早晚。
    // ★ 文案用的是 8.20 那次已经修过的新版本（not_found/expired 统一建议
    // /compact，不再是旧的"could not be found and cannot be recovered"
    // + 建议 /clear）——这里断言的是"确实 409 了"这个事实，不重复断言
    // 文案内容本身（那条已经有专门的 e2e 测试锁住）。
    expect(idleReturnRes.status).toBe(409);
    expect(idleReturnBody).toContain("Run /compact to continue this session");
  }, 30_000);
});
