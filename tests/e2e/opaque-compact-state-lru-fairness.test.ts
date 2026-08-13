/**
 * ★ 8.20/8.21（team-lead 派发）：先实测复现根因，再验证修复。
 *
 * 根因（8.20 实测确认，比假设本身更实锤）：`OpaqueCompactRepository.load()`
 * 实现了 8.4 sliding TTL——**任何一次成功 resolve（含 recompact 时读取
 * predecessor 来合并 preservedTail）都会把该行的 `last_used_at` 和
 * `expires_at` 一起顺延到 `now() + slideTtlMs`**（见该文件 load() 的注释）。
 * 这意味着：
 *
 * - 一个**忙碌**会话，只要还在收发消息/反复 recompact，它自己的
 *   `last_used_at` 会被不断刷新到"现在"，从 LRU 的角度看永远不会变旧。
 * - 一个**闲置但仍然有效**（没有 TTL 过期）的会话，`last_used_at` 冻结在
 *   最后一次被摸到的时刻，会随着时间流逝稳定变成全局最旧的那一批——
 *   跟它内容有没有价值、TTL 到没到期完全无关。
 *
 * 8.20 版本的这个文件曾经实测证明：`pruneWithinTransaction` 按
 * `last_used_at ASC` **全局**排序淘汰，不区分"结构上已经死掉的废弃历史代"
 * （已经有 successor，纯粹是 recompact 链条上被超越的旧记录）和"某个会话
 * 当前仍然有效、只是用户没碰"的活跃 state——闲置会话的唯一一条记录会先于
 * 忙碌会话新产生的历史废代被逐出，仅仅调大 capacity/max_bytes 只是推迟
 * 问题，不解决它。
 *
 * ★ 8.21 修复：`pruneWithinTransaction` 现在优先淘汰"已经有 successor"的
 * 废代（见该方法文档），只有这一层耗尽才退化到原来的全局 LRU。这个文件
 * 现在验证的是**修复后的行为**：一个刻意"闲置 3 天但仍在 7 天 TTL 内"的
 * 会话，即使旁边有另一个会话持续产生"更新鲜"的历史废代，也不会被优先
 * 淘汰——废代会先被挤掉。
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
  setClaudeCodeOpaqueCompactExperimental,
  isCompactV2Request,
  makeCompactV2Response,
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

describe("opaque compact state — LRU fairness: idle-but-alive vs. busy churn (8.21 淘汰分层修复)", () => {
  it("一个闲置 3 天、但仍在 7 天 TTL 内的会话，不会被其它会话更新鲜的废弃历史代提前淘汰——废代会先被挤掉", async () => {
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
    setTransportPost(async (_url, _headers, body) => {
      if (isCompactV2Request(body)) {
        compactCallCount += 1;
        return makeCompactV2Response({ encryptedContent: `summary #${compactCallCount}` });
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

    // ③ 忙碌会话：root + 连续 5 次 recompact，每次间隔 1 小时（模拟同一
    // 团队里另一个人手上真的在持续工作）。每次 recompact 都会先读取
    // predecessor（sliding TTL 顺延它的 last_used_at），随后这一代就有了
    // 自己的 successor——变成 8.21 意义上结构确定的"废代"，理应先于闲置
    // 会话的唯一一条记录被淘汰，即使它最后一次被摸到的时间点比闲置会话
    // 新得多。capacity=5，这轮 churn 会持续触发淘汰。
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
    // 请求——这正是真实事故复现的形状：治愈前，普通续接消息撞上被误逐出
    // 的 state 会直接 409，见 messages.ts 的 `compactPrompt !== null`
    // 判断；治愈后这里应该正常 200 地恢复出原来那一条 root 记录）。
    const idleReturnRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "assistant", content: idleMarker }, { role: "user", content: "I'm back, continue where we left off" }],
    }, { "x-claude-code-session-id": "session-idle-but-alive" });
    const idleReturnBody = await idleReturnRes.text();
    console.log(`[lru-fairness] idle session return: status=${idleReturnRes.status} body=${idleReturnBody.slice(0, 300)}`);

    // 核心断言（8.21 修复生效）：闲置会话在自己 TTL 窗口内回来，能正常
    // 200 恢复——即使旁边的忙碌会话在这 3 天里持续产生了"更新鲜"的历史
    // 记录，容量压力也应该先落在忙碌会话自己的废代上，而不是这条唯一、
    // 从未被超越过的 root 记录。`generation=1` 的日志（见上面 stdout）
    // 同时证明这确实是同一条原始记录被 resolve，不是某种巧合的重建。
    expect(idleReturnRes.status).toBe(200);
    expect(idleReturnBody).not.toContain("error");

    // 容量上限本身仍然守住：修复只改变淘汰顺序，不改变淘汰是否发生。
    expect(countRows(dir)).toBeLessThanOrEqual(5);
  }, 30_000);
});
