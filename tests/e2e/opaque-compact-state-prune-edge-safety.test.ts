/**
 * ★ P1（scout 审出 #79 的阻断问题，本文件是补的两条必测回归）：
 *
 * #79 最初把"淘汰优先选废代"的判据定成"这一行是否已经有 successor"
 * （`opaque_states.predecessor_lookup` 指向它的行是否存在）。scout 指出这个
 * 判据不完整：「有 child state」≠「安全淘汰」——COMMIT 成功到客户端真正
 * 带着 child 的 marker 回来（`confirmSuccessorUsed`）之间存在窗口，这段时间
 * child 行和 parent→child 的 edge **同时存在**，parent 仍必须撑住"崩溃后
 * 旧输入重试→`findSuccessorMarker` 原样回放"这条契约。只看"有没有 child"
 * 会在这个窗口把 parent 误判成废代提前淘汰，`deleteStateWithinTransaction`
 * 里的 `stmtDeleteSuccessorByPredecessor` 会连带删掉这条尚未消费的 edge，
 * 旧输入重试直接落空——分叉场景更隐蔽：同一个 predecessor 有两条分叉，一条
 * 已送达、另一条还在等，旧算法会因为"有 child"就把 predecessor 整个删掉，
 * 连带清空还在等的那条分叉的 edge（没删 sibling state，但删了 sibling
 * 唯一赖以幂等回放的凭据，效果等价）。
 *
 * 修复后的判据（`opaque-compact-repository.ts` 的 `stmtVictimStale`）额外
 * 要求"没有任何未消费、未过期的 live outgoing edge"。这个文件用两个真实
 * 场景验证这条修复：
 *
 * (a) COMMIT 成功但 marker 没送达（模拟进程在响应发出前挂掉）+ 旁边另一个
 *     会话的持续 churn 触发 prune → 用同样的输入重试，必须原样拿到同一个
 *     marker（`successor_replay`，不重新打上游），不能因为 predecessor
 *     被误淘汰而落空。
 * (b) 同一个 predecessor 长出两条分叉，一条已送达（edge 已被
 *     `confirmSuccessorUsed` 回收）、另一条还在等 → prune 不能把 predecessor
 *     整个删掉，连带打掉还在等的那条分叉的 edge；用那条分叉的原始输入重试
 *     必须仍然原样回放。
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
  accountPool.addAccount(createValidJwt({ accountId: "acct-prune-edge", email: "prune-edge@test.com", planType: "plus" }));
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
  dir = mkdtempSync(resolve(tmpdir(), "opaque-prune-edge-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-prune-edge-keys-"));
  runtime = startOpaqueCompactRuntime({
    enabled: true,
    ttlMinutes: 10080,
    capacity,
    maxBytes: 10 * 1024 * 1024, // 只测条数驱动的淘汰，字节预算给够大。
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

describe("opaque compact state — prune must not destroy a still-pending crash-retry edge (P1 fix regression)", () => {
  it("(a) COMMIT 成功但 marker 未送达 + 旁边会话持续 churn 触发 prune → 原样输入重试仍必须 successor_replay，不重新打上游", async () => {
    setupRuntime(4);
    let compactCallCount = 0;
    setTransportPost(async (_url, _headers, body) => {
      if (isCompactV2Request(body)) {
        compactCallCount += 1;
        return makeCompactV2Response({ encryptedContent: `summary #${compactCallCount}` });
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // ① session A：root compact 拿到 A1。
    const rootRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-a-lost-marker" });
    expect(rootRes.status).toBe(200);
    const a1Marker = extractMarkerFromResponse(await rootRes.text());

    // ② session A：从 A1 recompact 出 A2——COMMIT 成功、这里拿到了响应，
    // 但**故意不再用 A2 做任何后续请求**，模拟"进程在响应真正送达客户端
    // 之前挂掉"：A1→A2 这条 edge 从此再也没人去 confirm，永远停在"待送达"
    // 状态，直到我们自己稍后用同样的输入重放它。
    const a2Request = {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: a1Marker },
        { role: "user", content: "session A follow-up that never got its response" },
        { role: "user", content: compactPrompt },
      ],
    };
    const a2Res = await request(ctx, a2Request, { "x-claude-code-session-id": "session-a-lost-marker" });
    expect(a2Res.status).toBe(200);
    const a2Marker = extractMarkerFromResponse(await a2Res.text());

    // ③ session B：独立会话持续 churn，产生货真价实、已确认送达的废代——
    // 这些才是 prune 应该优先动的对象。capacity=4，session A 已经占了 2 行
    // （A1、A2），session B 再churn 几轮必然把总数顶过 4，触发 prune。
    // 这轮 churn 会真实打好几次上游——`callCountBeforeReplay` 必须在这轮
    // churn **之后**才采样，否则会把 session B 自己的合法 compact 调用
    // 误算成"重放时又打了一次上游"。
    let bMarker: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const messages = bMarker
        ? [
            { role: "assistant", content: bMarker },
            { role: "user", content: `session B history ${i}` },
            { role: "user", content: compactPrompt },
          ]
        : [{ role: "user", content: "session B history" }, { role: "user", content: compactPrompt }];
      const res = await request(ctx, {
        model: "codex", max_tokens: 1024, stream: true, messages,
      }, { "x-claude-code-session-id": "session-b-churn" });
      expect(res.status).toBe(200);
      bMarker = extractMarkerFromResponse(await res.text());
    }

    console.log(`[prune-edge-safety-a] rows after session B churn: ${countRows()} (capacity=4)`);
    const callCountBeforeReplay = compactCallCount;

    // ④ 决定性验证：用**跟 ② 完全相同**的输入（同 session/model、同
    // predecessor=A1、同请求内容→同 compactInputDigest）重放一次。
    // 如果 A1 被误判成废代删掉了，A1→A2 这条 edge 会被
    // `stmtDeleteSuccessorByPredecessor` 连带清空，这次重放只能落到
    // "predecessor state is gone"（stale_generation）或者干脆重新打一次
    // 上游——两者都是错误的。正确行为是 `findSuccessorMarker` 命中这条
    // edge，原样交出跟 ② 一模一样的 A2 marker，且不新增一次
    // compact_start（compactCallCount 相对 ③ 之后不再增长）。
    const replayRes = await request(ctx, a2Request, { "x-claude-code-session-id": "session-a-lost-marker" });
    const replayBody = await replayRes.text();
    console.log(`[prune-edge-safety-a] replay status=${replayRes.status} body=${replayBody.slice(0, 300)}`);
    expect(replayRes.status).toBe(200);
    expect(extractMarkerFromResponse(replayBody)).toBe(a2Marker);
    expect(compactCallCount).toBe(callCountBeforeReplay); // 没有重新打上游——真的是回放，不是巧合拿到相同文本。
  }, 30_000);

  it("(b) 同一个 predecessor 的两条分叉，一条已送达、另一条还在等 → prune 不得连带清空还在等的那条分叉的 edge", async () => {
    setupRuntime(4);
    let compactCallCount = 0;
    setTransportPost(async (_url, _headers, body) => {
      if (isCompactV2Request(body)) {
        compactCallCount += 1;
        return makeCompactV2Response({ encryptedContent: `summary #${compactCallCount}` });
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    // ① session C：root compact 拿到 predecessor P。
    const rootRes = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }, { "x-claude-code-session-id": "session-c-fork" });
    expect(rootRes.status).toBe(200);
    const pMarker = extractMarkerFromResponse(await rootRes.text());

    // ② 分叉 1：从 P recompact 出 C1，内容跟分叉 2 不同（不同
    // compactInputDigest → 不同 edge_lookup，是两条独立的分叉，不是同一次
    // compact 的重试）。**送达**它：再发一条普通续接消息用掉 C1 的
    // marker——`resolve()` 会 `confirmSuccessorUsed(C1)`，回收 P→C1 这条
    // edge。到这一步 P 已经"有 child"，且它其中一条分叉的 edge 已经被
    // 正常回收。
    const fork1Req = {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: pMarker },
        { role: "user", content: "fork branch ONE — delivered" },
        { role: "user", content: compactPrompt },
      ],
    };
    const fork1Res = await request(ctx, fork1Req, { "x-claude-code-session-id": "session-c-fork" });
    expect(fork1Res.status).toBe(200);
    const c1Marker = extractMarkerFromResponse(await fork1Res.text());
    const deliverC1Res = await request(ctx, {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [{ role: "assistant", content: c1Marker }, { role: "user", content: "continuing after fork one" }],
    }, { "x-claude-code-session-id": "session-c-fork" });
    expect(deliverC1Res.status).toBe(200);
    await deliverC1Res.text();

    // ③ 分叉 2：**同样**从 P recompact（P 的 marker 没变，第二次照样能用——
    // 这正是"同一个 predecessor 合法长出多条分叉"的设计），内容跟分叉 1
    // 不同。**故意不送达**：拿到 C2 的响应后不再对它做任何事，P→C2 这条
    // edge 从此停在"待送达"状态。
    const fork2Req = {
      model: "codex", max_tokens: 1024, stream: true,
      messages: [
        { role: "assistant", content: pMarker },
        { role: "user", content: "fork branch TWO — never delivered" },
        { role: "user", content: compactPrompt },
      ],
    };
    const fork2Res = await request(ctx, fork2Req, { "x-claude-code-session-id": "session-c-fork" });
    expect(fork2Res.status).toBe(200);
    const c2Marker = extractMarkerFromResponse(await fork2Res.text());

    // ④ session D：独立 churn，制造真正的废代、把总行数顶过 capacity=4——
    // 此刻库里有 P、C1、C2 三行，session D 再 churn 几轮足够触发 prune。
    // 跟 (a) 一样，`callCountBeforeReplay` 必须在这轮 churn 之后才采样，
    // 否则会把 session D 自己的合法 compact 调用误算成"重放时又打了一次
    // 上游"。
    let dMarker: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const messages = dMarker
        ? [
            { role: "assistant", content: dMarker },
            { role: "user", content: `session D history ${i}` },
            { role: "user", content: compactPrompt },
          ]
        : [{ role: "user", content: "session D history" }, { role: "user", content: compactPrompt }];
      const res = await request(ctx, {
        model: "codex", max_tokens: 1024, stream: true, messages,
      }, { "x-claude-code-session-id": "session-d-churn" });
      expect(res.status).toBe(200);
      dMarker = extractMarkerFromResponse(await res.text());
    }

    console.log(`[prune-edge-safety-b] rows after session D churn: ${countRows()} (capacity=4)`);
    const callCountBeforeReplay = compactCallCount;

    // ⑤ 决定性验证：用**跟分叉 2 完全相同**的输入重放。如果 P 因为"有
    // child"（C1 或 C2 都满足）被整体淘汰，`deleteStateWithinTransaction`
    // 会用 `stmtDeleteSuccessorByPredecessor` 连带清空 P 的全部 outgoing
    // edge——包括还在等的 P→C2，即便 C1 那条分支早就已经送达、C2 这条分支
    // 自己完全没有任何问题。正确行为是原样交出跟 ② 里分叉 2 一模一样的
    // C2 marker，不新增 compact_start（compactCallCount 相对 ④ 之后不再
    // 增长）。
    const replayRes = await request(ctx, fork2Req, { "x-claude-code-session-id": "session-c-fork" });
    const replayBody = await replayRes.text();
    console.log(`[prune-edge-safety-b] replay status=${replayRes.status} body=${replayBody.slice(0, 300)}`);
    expect(replayRes.status).toBe(200);
    expect(extractMarkerFromResponse(replayBody)).toBe(c2Marker);
    expect(compactCallCount).toBe(callCountBeforeReplay);
  }, 30_000);
});
