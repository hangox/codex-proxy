/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicCountTokensRequestSchema, AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicCountTokensRequest, AnthropicErrorBody, AnthropicErrorType, AnthropicMessagesRequest } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { FormatAdapter } from "./shared/proxy-handler-types.js";
import { extractAnthropicClientConversationId } from "./shared/anthropic-session-id.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import {
  isPromptTooLongLike,
  normalizePromptTooLongMessage,
} from "../proxy/prompt-too-long-error.js";
import {
  CompactServiceError,
  extractClaudeCodeCompactPrompt,
  type RecompactFailureCause,
} from "./shared/codex-compact-service.js";
import {
  respondWithOpaqueCompactMarker,
  restoreOpaqueCompactRequest,
} from "./shared/opaque-compact-bridge.js";
import { recordOpaqueCompactDenial } from "./shared/opaque-compact-denial-log.js";
import { recordOpaqueCompactFallback } from "./shared/opaque-compact-fallback-log.js";
import { sanitizeFreeTextForLog } from "../logs/redact.js";
import {
  extractOpaqueCompactStateMarker,
  getOpaqueCompactStateReadiness,
  hasOpaqueCompactStateReference,
  isOpaqueCompactMarkerBindingMismatch,
  replaceIgnoredOpaqueCompactMarkerInAnthropicRequest,
  isSelfHealableOpaqueCompactStateFailure,
  isUnparseableOpaqueCompactMarker,
  replaceIgnoredOpaqueCompactMarker,
  reportOpaqueCompactStoreFault,
  OpaqueCompactStateError,
  type OpaqueCompactStateFailure,
} from "./shared/opaque-compact-state.js";

/**
 * 用户在会话内看不到 compact 是否静默降级——Claude Code 只显示"✻
 * Conversation compacted"，摘要本身不展示给用户，压缩过程中的进度条也是
 * 客户端画的，插不进任何提示。事后可查的两条腿之一（另一条是
 * `recordOpaqueCompactFallback` 落进 `error-log.jsonl` + Dashboard 展示）：
 * 给这次响应打一个诊断 header，排查时不用翻日志对时间戳，直接看这次请求
 * 的响应头就知道走没走静默降级。用户看不到，纯排查用途。
 */
const COMPACT_FALLBACK_HEADER = "x-codex-proxy-compact-fallback";

/**
 * 诊断 header 只在真的走了 root/recompact fallback 时才打——不改响应本身
 * 的 status/body/流式行为，纯附加，用户在会话内看不到，纯排查用途。两个
 * 响应分支（api-key/adapter 走 `handleDirectRequest`，其余走
 * `handleProxyRequest`）共用，避免各写一遍 `res.headers.set(...)`。
 *
 * ★ #108/#111：这里以前还顺带调用 `recordCompactOutcome` 记一条语义残缺
 * 的 `"render_started"`（"这次重试已经发出，但不知道上游接没接受、更不
 * 知道摘要有没有生成成功"）——那是 `messages.ts` 这一层的已知局限：这次
 * fallback 请求恒为流式，`proxy-error-response.ts` 对流式请求的所有同步
 * 失败分支统一返回 HTTP 200（真实状态码编码进 SSE body），`res.status`
 * 因此不管成败都一样，在这里已经无法辨别真相。
 *
 * 但"这一层看不到"不等于"整条调用链都看不到"——真正可信的完成信号在更
 * 深的调用栈里（`proxy-handler.ts` 几个从未进入流式阶段就终止的分支、
 * `streaming-handler.ts` 的 `finally` 块），那几个地方现在会各自直接调用
 * `compact-outcome-log.ts` 的 `recordCompactFallbackRenderOutcome`，用
 * 真实成败（`render_completed`/`upstream_failed`）替代这里曾经的猜测，
 * 见该函数完整文档。这个函数因此不再需要做任何记录，只剩 header。
 */
function finalizeCompactFallbackResponse(res: Response): Response {
  res.headers.set(COMPACT_FALLBACK_HEADER, "1");
  return res;
}

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

/**
 * 8.5：opaque compact 409 的用户可读文案，按 reason 分类给出可执行的下一步——
 * 禁止继续用"Run /compact again"这种笼统收尾。事故环 6 的教训是：如果建议的
 * 动作会重放同一个必然复现的失败，提示语就是一个自指陷阱。这里的原则是
 * "只建议一个真的会有不同结果的动作"：
 *
 * - `expired`/`not_found`（含内存模式的 `missing`）：都是族 A，
 *   `isSelfHealableOpaqueCompactStateFailure()` 判定为可自愈——下一次
 *   `/compact` 会走全新 root compact、拿到全新 state，不会重放同一个 409。
 *   两者文案统一建议 `/compact`，**不建议 `/clear`**。
 *
 *   ★ 8.20（生产事故复盘，真实误导过用户）：这里此前对 `not_found` 单独
 *   写了一套"没有过期状态可以刷新，语义更接近凭空新建，应该引导 /clear"
 *   的理由——**这个理由和实际代码行为不符**。`isSelfHealableOpaqueCompactStateFailure`
 *   从一开始就把 `not_found`/`expired` 分到同一个自愈族（族 A），下一次
 *   `/compact` 对两者的处理完全一样，都是全新 root compact，没有本质区别。
 *   `/clear` 建议是**错的、且代价更大**——它会清空整个会话，而用户只需要
 *   `/compact` 就能救回来（真实事故：TTL 到期后普通对话轮次撞上
 *   `not_found` 409，用户听从代码给的建议大可以直接 `/compact` 而不必
 *   `/clear`；mac-mini 会话记录证实手动 `/compact` 确实一次就成功了，
 *   没有清空历史）。
 * - 其余（store 级致命故障 + tampered/account_mismatch/comp_hash_mismatch/
 *   preserved_tail_conflict/state_too_large/stale_generation）：不承诺重试
 *   会成功（store 可能仍未恢复，或本来就是需要人工介入的异常），只给一个
 *   保底、必然可行的退出路径——这些是真的救不回来，`/clear` 措辞必须保留，
 *   不能跟着族 A 一起改。
 */
function describeOpaqueCompactUnavailable(reason: string): string {
  if (reason === "expired" || reason === "not_found" || reason === "missing") {
    return "Opaque compact state for this session has expired and will be automatically refreshed on your " +
      "next /compact. Run /compact to continue this session — no need to /clear.";
  }
  return `Opaque compact state is unavailable (${reason}). If this persists, run /clear and start a new session.`;
}

/**
 * ★ #81：`recompact_failed_original_account` 聚合桶的用户可见文案分拆。
 *
 * #83 之前，这个 409 分支不管上游真实原因是什么，一律吐同一句
 * "could not be compacted on its original account. Run /clear..."——
 * `state_too_large`（容量耗尽，save 阶段就超限）跟真正的账号失败
 * （rate_limited/banned/token_expired/...）长得一模一样，用户报告没法从
 * 这句话反推死因，这跟当时那次 409 排查绕大圈是同一个病：不同根因共用
 * 同一句文案，事后无法反推。#83 已经把 `cause` 字段做出来了，这里只是
 * "用已有的 cause 分文案"，不是重新做分类。
 *
 * 三个桶，按"用户到底能做什么"划分——不是按 cause 值本身的技术含义划分，
 * 那样会拆出一堆文案完全相同、纯粹为了"不同"而不同的分支，参考
 * `deriveRecompactFailureCause` 文档里"一对多命名分裂"同一条教训：
 *
 * 1. `state_too_large`：内容太大，save 阶段就超限——诚实的建议是"这次
 *    session 太大了"，唯一的自助手段仍然是 /clear 开一个更小的新会话。
 * 2. `stale_generation` / `preserved_tail_conflict`：并发/协议类冲突，
 *    不是"这个状态救不回来"——`stale_generation` 是这次 recompact 在跟
 *    同一会话上的另一次 compact 抢跑，输了；`preserved_tail_conflict` 是
 *    压缩期间会话历史（预期原样保留的那部分）发生了变化。两者共同点是
 *    "这一次操作跟另一件事撞车了"，不是数据/账号层面真的坏掉了——继续
 *    对话应该会自动恢复。这条 409 本身仍然保留 SDK/客户端的自动重试（
 *    #91 没有改这两个 cause 对应的状态码）——这里跟 #91 的判断是一致的：
 *    族 A 是确定性失败，必须打断自动重试；这两个是真的可以靠重试自愈，
 *    409 的默认重试语义对它们本来就是对的，不需要跟着 #91 一起动。
 * 3. 其余一切（`account_mismatch` 及所有 `RecompactFailureCause` 的上游/
 *    账号失败值——`rate_limited`/`account_banned`/`token_expired`/...）：
 *    这次 recompact 在原账号上失败了，且没有"换个方式重试就会不同"的
 *    理由（8.5 的原始论证仍然成立，见下面 `if (opaqueRestore.restored &&
 *    !isRecompactContextOverflow)` 分支的注释）——诚实的建议就是 /clear
 *    开一个新会话，跟改动前的行为一致。`account_mismatch`（记录被判定
 *    属于别的账号，是 CAS/save 边界发现的数据一致性问题，不是常规的上游
 *    账号故障）没有单独拆出来——它的自助手段和这个桶完全一样，拆出来只会
 *    多一句文案相同的判断分支，不产生任何用户可感知的差异。
 */
// ★ #81：导出——仅供测试直接断言三个桶的文案（见
// tests/unit/routes/recompact-failure-message.test.ts）。跟 #83 的
// deriveRecompactFailureCause 同一个道理：不是给其它模块复用的公共 API，
// messages.ts 内部仍然只在本文件内调用它。
export function describeRecompactFailure(cause: RecompactFailureCause | OpaqueCompactStateFailure): string {
  if (cause === "state_too_large") {
    return "This session's compacted context is too large to save. Run /clear and start a new session with a smaller working set.";
  }
  if (cause === "stale_generation" || cause === "preserved_tail_conflict") {
    return "This request conflicted with another compact operation on the same session. Continuing the " +
      "conversation should resolve it automatically — no action needed.";
  }
  return "Opaque compact state could not be compacted on its original account. Run /clear and start a new session.";
}

/**
 * ★ #83：`recompact_failed_original_account` 聚合桶的失败子因派生。
 *
 * 这个 reason 值本身**不改**（Dashboard/日志既有的过滤和统计口径依赖它），
 * 这里只是给它配一个更细的 `cause`，供事后排查区分"这次到底是哪一类失败"
 * ——之前不管上游真实原因是什么，落进这个分支就只留下同一句聚合文案，
 * 2026-08-03 那次 409 排查绕了大圈，根因正是"不同死因共用同一个标签、
 * 事后无法反推"。
 *
 * 两条信息源本来就已经结构化，这里不是重新分类，是把已经存在但被忽略的
 * 字段读出来：
 * - `CompactServiceError.cause`：`executeCompactOnly` 内部对上游/账号失败
 *   的分类（见 `codex-compact-service.ts` 的 `classifyCompactUpstreamFailure`）。
 * - `OpaqueCompactStateError.reason`：repository/CAS 层的协议失败（
 *   `stale_generation`/`preserved_tail_conflict`/`state_too_large` 等）本来
 *   就带着完整分类，只是这个聚合点此前没有读它。
 *
 * ★ 经 team-lead 请 scout 仲裁确认：这里**直接原样透传 `error.reason`**，
 * 不另造一套 `state_save_*` 前缀等价名——同一个 CAS 失败只应该有一个
 * machine-readable 名字，另造前缀版是"一对多命名分裂"，跟 #83 本身要治的
 * "多对一聚合丢分类"是同一个病的镜像，只是方向反过来，一样会导致以后
 * 漂移（两套名字总有一套先被改、另一套被忘）。
 *
 * 两者都没有（比如非 CodexApiError 的意外异常被原样 rethrow）才落到
 * `unexpected_error`——不强凑一个更精确但没有依据的值。
 */
// ★ #83：导出——仅供测试用穷尽性守卫锁住 OpaqueCompactStateFailure 的分类
// （见 tests/unit/routes/recompact-failure-cause-exhaustiveness.test.ts）。
// 不是给其它路由/模块复用的公共 API，messages.ts 内部仍然只在本文件内调用它。
export function deriveRecompactFailureCause(error: unknown): RecompactFailureCause | OpaqueCompactStateFailure {
  if (error instanceof OpaqueCompactStateError) return error.reason;
  if (error instanceof CompactServiceError) return error.cause ?? "generic_upstream_error";
  return "unexpected_error";
}

function checkProxyApiKey(c: Context, accountPool: AccountPool): Response | null {
  const config = getConfig();
  if (!config.server.proxy_api_key) return null;

  const xApiKey = c.req.header("x-api-key");
  const authHeader = c.req.header("Authorization");
  const bearerKey = authHeader?.replace("Bearer ", "");
  const providedKey = xApiKey ?? bearerKey;

  if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
    c.status(401);
    return c.json(makeError("authentication_error", "Invalid API key"));
  }

  return null;
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkMatches = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = Math.max(0, trimmed.length - cjkCount);

  return Math.ceil(nonCjkCount / 4) + cjkCount;
}

function estimateUnknownTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return estimateTextTokens(String(value));
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateUnknownTokens(item), 0) + value.length;
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, item]) => sum + estimateTextTokens(key) + estimateUnknownTokens(item),
      2,
    );
  }
  return estimateTextTokens(String(value));
}

function estimateMessageContentTokens(content: AnthropicMessagesRequest["messages"][number]["content"]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((sum, block) => sum + estimateUnknownTokens(block), 0);
}

function estimateCountTokens(req: AnthropicCountTokensRequest): number {
  const modelTokens = estimateTextTokens(req.model);
  const systemTokens = req.system ? estimateUnknownTokens(req.system) + 4 : 0;
  const messageTokens = req.messages.reduce(
    (sum, message) =>
      sum +
      4 +
      estimateTextTokens(message.role) +
      estimateMessageContentTokens(message.content),
    0,
  );
  const toolTokens = (req.tools ?? []).reduce(
    (sum, tool) => sum + 16 + estimateUnknownTokens(tool),
    0,
  );
  const toolChoiceTokens = req.tool_choice ? estimateUnknownTokens(req.tool_choice) : 0;
  const thinkingTokens = req.thinking ? estimateUnknownTokens(req.thinking) : 0;

  return Math.max(1, modelTokens + systemTokens + messageTokens + toolTokens + toolChoiceTokens + thinkingTokens + 3);
}

function makeAnthropicProtocolError(status: number, message: string): AnthropicErrorBody {
  if (isPromptTooLongLike(message)) {
    return makeError("invalid_request_error", normalizePromptTooLongMessage(message));
  }
  // ★ #81: 529 → overloaded_error is not cosmetic. respondWithNoAccount's
  // self-heal buckets (concurrency saturated / quota window) deliberately
  // use status 529 specifically to mirror Anthropic's own real overloaded
  // response, and this repo's own binary-extracted retry logic (see #81
  // investigation notes) treats `type: "overloaded_error"` as a signal
  // distinct from generic `api_error` in at least one code path. Losing
  // this mapping when respondWithNoAccount switched from a dedicated
  // formatNoAccount() to the shared formatError() would have silently
  // reverted the self-heal buckets' retry-friendly semantics to generic
  // errors. 403 (the needs_human bucket's status) is deliberately NOT
  // added here — it must fall through to "api_error", not
  // "overloaded_error", which is the whole point of that bucket existing.
  if (status === 429) return makeError("rate_limit_error", message);
  if (status === 529) return makeError("overloaded_error", message);
  return makeError("api_error", message);
}

function extractMessageText(content: AnthropicMessagesRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if ("type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("\n");
}

function isAgentTeamSilentInitialization(req: AnthropicMessagesRequest): boolean {
  const message = req.messages.at(-1);
  if (!message) return false;
  if (message.role !== "user") return false;

  const text = extractMessageText(message.content);
  if (!text.includes("<teammate-message")) return false;
  if (!text.includes("本条初始化消息的处理规则")) return false;
  if (!text.includes("这是一条初始化消息")) return false;
  if (!text.includes("直接停止输出")) return false;

  // 真实任务会附带 mailbox JSON；初始化规则说明里的文字示例不能算。
  return !/\{\s*"type"\s*:\s*"task_assignment"/.test(text);
}

function makeEmptyAnthropicMessage(model: string) {
  return {
    id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "message" as const,
    role: "assistant" as const,
    content: [],
    model,
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function formatAnthropicSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function formatAnthropicStreamError(status: number, message: string): string {
  return formatAnthropicSse("error", makeAnthropicProtocolError(status, message));
}

function makeSilentInitializationResponse(req: AnthropicMessagesRequest, model: string): Response {
  const message = makeEmptyAnthropicMessage(model);
  if (!req.stream) {
    return Response.json(message);
  }

  const body =
    formatAnthropicSse("message_start", { type: "message_start", message }) +
    formatAnthropicSse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: message.usage,
    }) +
    formatAnthropicSse("message_stop", { type: "message_stop" });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function makeAnthropicFormat(wantThinking: boolean): FormatAdapter {
  return {
    tag: "Messages",
    // ★ #81: this format uses 529 for the self-heal buckets where
    // responses.ts/chat.ts/gemini.ts all use 503 — that split predates #81
    // (present since the original multi-protocol commit d0eb8b9, never
    // explained in a commit message or comment there). Current understanding
    // is that 529 mirrors Anthropic's own real `overloaded_error` response
    // exactly (same code, same body `type`, see makeAnthropicProtocolError
    // below), which the other three formats have no equivalent "overloaded"
    // code for in their real upstream APIs — but this is inferred from the
    // pattern, not confirmed from any commit/comment/design doc. Do not
    // treat it as settled design intent; if it's ever disproven, correct
    // this comment rather than leaving it stale.
    noAccountStatus: 529 as StatusCode,
    // ★ #81: 403 — not on Claude Code 2.1.220's retry whitelist except one
    // narrow case tied to a specific OAuth-revocation error phrase our
    // needs_human message never produces — see FormatAdapter
    // .needsHumanStatus's doc comment for the exact trigger string (kept
    // out of this file on purpose so a raw source-text safety-net test can
    // assert no needs_human-bucket file ever contains it verbatim).
    needsHumanStatus: 403 as StatusCode,
    format429: (msg) => makeError("rate_limit_error", msg),
    formatError: (status, msg) => makeAnthropicProtocolError(status, msg),
    formatStreamError: (status, msg) => formatAnthropicStreamError(status, msg),
    streamTranslator: ({
      api,
      response,
      model,
      onUsage,
      onResponseId,
      onResponseCompleted,
      usageHint,
      onResponseMetadata,
    }) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking, usageHint, onResponseMetadata, onResponseCompleted),
    collectTranslator: ({
      api,
      response,
      model,
      usageHint,
      onResponseMetadata,
    }) =>
      collectCodexToAnthropicResponse(api, response, model, wantThinking, usageHint, onResponseMetadata),
  };
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();

  app.post("/v1/messages/count_tokens", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }

    const parsed = AnthropicCountTokensRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }

    const authError = checkProxyApiKey(c, accountPool);
    if (authError) return authError;

    return c.json({ input_tokens: estimateCountTokens(parsed.data) });
  });

  app.post("/v1/messages", async (c) => {
    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;
    // 8.6：requestId 提到函数顶部——两个早期 opaque 409（缺 session 上下文 /
    // 开关已开但 store 未就绪）此前发生在原来的 requestId 声明之前，落不了
    // 结构化日志。这里只是把已有的"取 c.get 或生成"逻辑挪早，取值方式不变。
    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    // ★ #88：跟 requestId 一起提到最早——这个时刻到任意一次
    // recordOpaqueCompactDenial 之间的耗时，就是这次 fail-closed 决策
    // 花了多久（族 A 撞在非 compact 请求上是 400，其余是 409，见 #91——
    // 不管哪个状态码，理应都是毫秒级，耗时数字本身就是排查线索）。
    const requestStartedAt = Date.now();

    const routeMatch = upstreamRouter?.resolveMatch(req.model);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const hasOpaqueReference = hasOpaqueCompactStateReference(req);
    const opaqueStateReference = extractOpaqueCompactStateMarker(req);
    // 只要**任一**检测认为请求里带 opaque 内容，就按敏感请求处理。
    // 两个函数对"什么算 opaque 引用"的判定可能分歧（严格 marker vs 宽松包含），
    // 日志侧必须取并集，否则分歧就是一条完整 body 落盘的通道。
    const opaqueSensitive = hasOpaqueReference || opaqueStateReference !== null;
    const clientConversationId = extractAnthropicClientConversationId(
      req,
      c.req.header("x-claude-code-session-id"),
    );
    if (hasOpaqueReference && (allowUnauthenticated || clientConversationId === null)) {
      // 8.5：这条不能建议"再跑一次 /compact"——缺 session id / 走的是无鉴权
      // 路由是结构性问题，重放同一个请求会重现一模一样的缺口，不会自愈。
      recordOpaqueCompactDenial({
        requestId,
        reason: "missing_session_context",
        clientConversationId,
        marker: opaqueStateReference,
        // displayModel 还没算出来（在模型解析之前）——用原始 req.model，
        // 只供 Dashboard 统计使用，不影响这里的 409 决策。
        model: req.model,
        httpStatus: 409,
        durationMs: Date.now() - requestStartedAt,
      });
      c.status(409);
      return c.json(makeError(
        "invalid_request_error",
        "Opaque compact state requires the original Claude Code session and Codex account route, and this " +
          "request is missing that context. It cannot be automatically recovered — start a new conversation.",
      ));
    }
    // 8.3：解析不出严格 marker（malformed）不再 409。`hasOpaqueReference`
    // （松检测，见上面的 opaqueSensitive）与 `opaqueStateReference`（严解析）
    // 口径刻意不同——前者只驱动"这条请求是否按敏感请求做日志脱敏"，后者才
    // 是唯一允许驱动状态恢复/新建 compact 的信号。两者不一致时（松命中、严
    // 解析为 null）说明消息里出现了形似 marker 但不可信的文本：不是我们签发
    // 的、被截断的、或被引用/包裹改变了位置——按普通文本继续处理即可，
    // 严解析为 null 已经保证它不会被当成恢复凭据使用。

    // Auth check
    if (!allowUnauthenticated && !accountPool.hasAnyActiveAccount()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    const authError = checkProxyApiKey(c, accountPool);
    if (authError) return authError;

    const modelConfig = getConfig().model;
    const opaqueCompactEnabled = modelConfig.claude_code_opaque_compact_experimental;
    const opaqueMarkerCandidate = clientConversationId !== null
      ? opaqueStateReference
      : null;
    // 8.2：关开关是运维唯一的非回滚止血阀。marker 存在但功能已关闭时，忽略
    // marker、把请求当普通文本继续（下面 opaqueCompactEnabled=false 会让
    // restoreOpaqueCompactRequest 整体短路，不会再碰 store），不要 409——
    // 事故复盘显示这里曾经 409，止血阀因此形同虚设（关了开关会话照样报错）。
    // 先记下这枚被忽略的 marker，等 codexRequest 翻译出来后统一做占位替换
    // （见下方 replaceIgnoredOpaqueCompactMarker）——此时还没有 codexRequest。
    const ignoredMarkerFromDisabledSwitch = opaqueMarkerCandidate && !opaqueCompactEnabled
      ? opaqueMarkerCandidate
      : null;
    // 已开启但 store 未就绪：把结构化 reason 一并给出，便于区分锁/密钥/schema/损坏。
    if (opaqueMarkerCandidate && opaqueCompactEnabled) {
      const readiness = getOpaqueCompactStateReadiness();
      if (!readiness.ready) {
        // 8.5：这条不特定于 compact 请求（任何带 marker 的请求都可能撞上），
        // 且此刻 store 处于 NOT_READY——建议"再跑 /compact"等于建议重放同一个
        // 会撞同一个 NOT_READY 的动作。给一个不依赖 store 恢复的退出路径。
        recordOpaqueCompactDenial({
          requestId,
          reason: readiness.reason ?? "store_unavailable",
          clientConversationId,
          marker: opaqueMarkerCandidate,
          // 排查生产事故补的字段：readiness.detail 只允许流向这里（结构化
          // 日志），绝不能拼进下面的客户端响应文案——见
          // getOpaqueCompactStateReadiness() 的文档注释。
          detail: readiness.detail,
          model: req.model,
          httpStatus: 409,
          durationMs: Date.now() - requestStartedAt,
        });
        c.status(409);
        return c.json(makeError(
          "invalid_request_error",
          `Opaque compact state is unavailable (${readiness.reason}). If this persists, run /clear and start a new session.`,
        ));
      }
    }
    const compactPrompt = opaqueCompactEnabled &&
      req.stream === true &&
      clientConversationId !== null
      ? extractClaudeCodeCompactPrompt(req)
      : null;

    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const fmt = makeAnthropicFormat(wantThinking);

    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: compactPrompt
        ? {
            body_type: "anthropic.messages",
            model: req.model,
            stream: req.stream,
            messages: req.messages.length,
            compact_bridge: true,
            compact_mode: opaqueCompactEnabled ? "opaque_state" : "render",
            ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
          }
        // 判定条件用 opaqueSensitive 而非 opaqueMarkerCandidate：后者额外要求
        // clientConversationId 非空，于是"带 marker 但无 conversationId"的请求
        // 会两个分支都不命中，落到下面把完整 body 写盘。
        : opaqueSensitive
          ? {
              body_type: "anthropic.messages",
              model: req.model,
              stream: req.stream,
              messages: req.messages.length,
              opaque_state_resume: true,
              ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
            }
          : summarizeRequestForLog("messages", req, {
              ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
              headers: Object.fromEntries(c.req.raw.headers.entries()),
            }),
    });

    if (isAgentTeamSilentInitialization(req)) {
      enqueueLogEntry({
        requestId,
        direction: "egress",
        method: "POST",
        path: "/codex/responses",
        model: displayModel,
        provider: "codex",
        status: 200,
        latencyMs: 0,
        stream: req.stream,
        request: {
          model: req.model,
          stream: req.stream,
          bypass: "agent-team-silent-initialization",
        },
      });
      console.log(`[Messages] rid=${requestId.slice(0, 8)} | agent-team silent initialization bypass`);
      return makeSilentInitializationResponse(req, displayModel);
    }

    const codexRequest = translateAnthropicToCodexRequest(req, undefined, {
      injectHostedWebSearch: !allowUnauthenticated,
      mapClaudeCodeWebSearch: !allowUnauthenticated && clientConversationId !== null,
      requestId,
    });
    // CODEX_PROXY_DISABLE_WS=1 临时绕开 ws 路径上游阻断（incident 2026-05-07）
    if (!allowUnauthenticated && process.env.CODEX_PROXY_DISABLE_WS !== "1") {
      codexRequest.useWebSocket = true;
    }
    if (clientConversationId !== null && !codexRequest.prompt_cache_key) {
      codexRequest.prompt_cache_key = clientConversationId;
    }

    let opaqueRestore = opaqueCompactEnabled && clientConversationId !== null && !allowUnauthenticated
      ? restoreOpaqueCompactRequest({
          req,
          translated: codexRequest,
          clientConversationId,
          requestId,
          // 数据密钥按账号派生，解封需要本实例已知的账号集合。
          accountCandidates: accountPool.getAllEntries().map((entry) => entry.id),
        })
      : { restored: false };
    // 被忽略（不放行到自愈、但也不 409）的 marker，最终统一在下面对
    // codexRequest.input 做占位替换——见 replaceIgnoredOpaqueCompactMarker
    // 的文档：不能让它原样透传给上游，那是把回滚事故里"静默上下文丢失"
    // 那一环从"仅回滚期间"搬进日常路径。
    let ignoredMarker: string | null = ignoredMarkerFromDisabledSwitch;
    // Reviewer Finding #2：族 A 自愈会走全新 root compact，但
    // buildClaudeCodeOpaqueCompactRequest 直接从 req.messages 重新派生 compact
    // 输入，完全不经过 codexRequest.input——不清理 req 本身，"全新"的 compact
    // 依然会把死掉的 marker 原文当真实历史一起送进去。effectiveReq 默认等于
    // req；只有自愈命中时才会被替换成清理过的副本（见下方）。
    let effectiveReq: AnthropicMessagesRequest = req;
    if (opaqueRestore.error) {
      // store 级故障（损坏/密钥/schema）与单请求语义错误（session 不匹配、
      // marker 过期）走同一个出口，但前者要同时把 runtime 转成 NOT_READY，
      // 让 /health 与后续请求给出同一个 reason。下面几个分类函数判定为
      // "不致命"时这里是 no-op；判定致命时仍然原子转 NOT_READY。
      reportOpaqueCompactStoreFault(opaqueRestore.error);
      const reason = opaqueRestore.error.reason;
      // 排查生产事故补的字段：只有 store 级致命故障才会真的有内容
      // （isFatalStoreFailure 之外的 reason，比如 session_mismatch，
      // detail 从 toStateError() 那一步就是 undefined），非致命场景
      // 传 undefined 给 recordOpaqueCompactDenial 不会强凑内容。
      const detail = opaqueRestore.error.detail;
      const errorMarker = opaqueRestore.marker ?? null;
      // 8.1 + 8.3：三条独立、互斥的"不该 409"族，收口在
      // opaque-compact-state.ts 的分类函数里（完整分区说明见该文件的
      // isSelfHealableOpaqueCompactStateFailure 文档），这里只做编排，不再
      // 散落 reason === "..." 比较：
      //   - 族 A / isSelfHealableOpaqueCompactStateFailure（8.1）：marker
      //     合法但 state 没了（not_found/expired/missing）。★ 红线：只在
      //     这一族放行，且额外要求本次确实是 compact 请求——store 级致命
      //     故障（锁/密钥/schema/quarantine/AEAD 校验失败）永远落在
      //     isFatalStoreFailure 那一族，这里恒为 false，仍然 fail-closed。
      //   - 族 B / isUnparseableOpaqueCompactMarker + isOpaqueCompactMarkerBindingMismatch
      //     （8.3 + 团队三族裁决）：压根没解析出合法 marker，或验签通过但
      //     session/model/variant 绑定对不上——两者都说明这枚 marker 与
      //     本次请求无关，不需要是 compact 请求，任何请求都当普通文本。
      //     ★ 红线：account_mismatch **不**在这一族里，是跨账号访问边界，
      //     继续 409（见 isOpaqueCompactMarkerBindingMismatch 文档）。
      // 命中后都丢弃 error/marker/output 等字段，视为"从未找到过状态"：
      // 不能把这枚已经失效、解析不出来或绑定不对的旧 marker 当
      // previousMarker 传给全新 root compact 分支，那会让它去尝试幂等回放
      // 一个不存在或不属于本次请求的 predecessor edge。
      const selfHealable = isSelfHealableOpaqueCompactStateFailure(reason);
      const notApplicableToRequest = isUnparseableOpaqueCompactMarker(reason) ||
        isOpaqueCompactMarkerBindingMismatch(reason);
      const treatAsNoMarker = selfHealable ? compactPrompt !== null : notApplicableToRequest;
      if (treatAsNoMarker) {
        console.log(
          `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)}` +
            ` phase=${selfHealable ? "self_heal" : "ignored_not_applicable_marker"} reason=${reason}`,
        );
        if (!selfHealable) {
          // 族 B：会原样进入普通转发路径，占位替换施加在 codexRequest.input 上
          // （见下方 replaceIgnoredOpaqueCompactMarker 调用）。
          ignoredMarker = errorMarker ?? ignoredMarker;
        } else if (errorMarker !== null) {
          // 族 A 自愈（Reviewer Finding #2）：全新 root compact 的输入必须先
          // 清理掉旧 marker，否则 buildClaudeCodeOpaqueCompactRequest 会把它
          // 当真实历史送进这次"全新"的 compact，压缩出来的摘要不干净，且
          // 用户永远不会知道。清理作用于 Anthropic 层的 req（不是 Codex 层
          // 的 codexRequest.input，那个对这条分支不生效，见函数文档）。
          effectiveReq = replaceIgnoredOpaqueCompactMarkerInAnthropicRequest(req, errorMarker);
        }
        opaqueRestore = { restored: false };
      } else {
        // 8.6：restoreOpaqueCompactRequest 的 error 分支不带 requiredEntryId/
        // generation（那两个只在成功恢复时才有意义），因此这里不填账号/代数。
        recordOpaqueCompactDenial({
          requestId,
          reason,
          clientConversationId,
          marker: errorMarker,
          detail,
          model: displayModel,
          // ★ #91/#96：状态码跟下面 if (selfHealable) 分支保持同一个判据，
          // 不在这里重新推导——一旦两处判据分叉，Dashboard 记录的 http_status
          // 就会跟客户端实际收到的不一致，比完全不记录更糟。
          httpStatus: selfHealable ? 400 : 409,
          durationMs: Date.now() - requestStartedAt,
        });
        // ★ #91：这个 else 分支不是族 A 专用出口——`treatAsNoMarker` 为
        // false 时，族 A（not_found/expired/missing，且这次不是 compact
        // 请求）和"既不可自愈也不是族 B"的一切（tampered/account_mismatch/
        // comp_hash_mismatch/9 个 isFatalStoreFailure 致命 store 故障）都会
        // 走到这里，`selfHealable` 是唯一能把两者分开的判据。
        //
        // 族 A 命中时这个失败是确定性的——底层行已经不存在，不会因为客户端
        // 重试而改变。但状态码一直是 409，Anthropic SDK 和 Claude Code 自己
        // 的重试逻辑都把 409 当"可重试的锁冲突"无条件重试（生产实测：单个
        // 会话最多 134s 静默等待、~10 次指数退避重试，每次重传全部上下文，
        // 用户在此期间完全看不到 describeOpaqueCompactUnavailable 已经给出
        // 的、本来正确的"运行 /compact 就能恢复"提示）。这个分支的 body 本来
        // 就是 `invalid_request_error`——对应 Anthropic 规范里的 400，不是
        // 409，现状 status 和 body 语义早就不一致，改成 400 不是发明新码，
        // 是把已经写在 body 里的语义和状态码对齐。
        //
        // ★ 红线：只有族 A 改 400。其余原因（tampered/account_mismatch/
        // comp_hash_mismatch/致命 store 故障）语义是"服务端状态有问题"，
        // 不是"你的请求有问题"——继续用 409 保留这层区分，且不加
        // `x-should-retry`（这些确实救不回来，但不该被误读成客户端参数
        // 错误）。
        //
        // `x-should-retry: false` 是 @anthropic-ai/sdk 自己的机制（
        // client.ts 的 shouldRetry() 在状态码判断之前先读这个头，覆盖后续
        // 判断）——跟状态码改动双保险：400 对所有遵循 Anthropic 规范的客户端
        // 生效，这个头额外覆盖任何只按状态码硬编码判断、不看 body 语义的
        // 边缘重试层。任一条失效，另一条依然生效。
        if (selfHealable) {
          c.header("x-should-retry", "false");
          c.status(400);
        } else {
          c.status(409);
        }
        return c.json(makeError("invalid_request_error", describeOpaqueCompactUnavailable(reason)));
      }
    }
    if (ignoredMarker) {
      codexRequest.input = replaceIgnoredOpaqueCompactMarker(codexRequest.input, ignoredMarker);
    }

    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream,
      clientConversationId: clientConversationId ?? undefined,
      ...(opaqueRestore.requiredEntryId ? { requiredAccountEntryId: opaqueRestore.requiredEntryId } : {}),
    };

    // 见 COMPACT_FALLBACK_HEADER 的文档注释。
    let compactFallbackOccurred = false;
    // ★ #108/#111：render 的 duration_ms 起点——只在 compactFallbackOccurred
    // 置真的同一行赋值，见下面赋值处的完整理由（不能跟 opaque 尝试自己的
    // 耗时重叠计算）。
    let fallbackDecidedAt: number | undefined;
    if (compactPrompt && clientConversationId !== null && req.stream === true && !allowUnauthenticated && opaqueCompactEnabled) {
      // store 不可用时必须在打上游之前 fail-closed：否则会白花一次 compact 调用，
      // 拿到 output 后却无处保存，最终仍要报错。
      // reason 透传 runtime 的真实原因（锁/密钥/schema/损坏），不折叠成一个笼统值——
      // 运维要靠它区分"第二实例抢锁"和"密钥丢了"。
      const readiness = getOpaqueCompactStateReadiness();
      if (!readiness.ready) {
        recordOpaqueCompactDenial({
          requestId,
          reason: readiness.reason ?? "store_unavailable",
          clientConversationId,
          marker: opaqueRestore.marker,
          accountEntryId: opaqueRestore.requiredEntryId,
          generation: opaqueRestore.generation,
          detail: readiness.detail,
          model: displayModel,
          httpStatus: 409,
          durationMs: Date.now() - requestStartedAt,
        });
        c.status(409);
        return c.json(makeError("invalid_request_error", describeOpaqueCompactUnavailable(readiness.reason ?? "store_unavailable")));
      }
      try {
        return await respondWithOpaqueCompactMarker({
          c,
          accountPool,
          cookieJar,
          proxyPool,
          // Reviewer Finding #2：族 A 自愈时这是清理过 marker 的副本，
          // 其余情况下等于原始 req（见 effectiveReq 声明处的说明）。
          req: effectiveReq,
          translated: codexRequest,
          compactPrompt,
          clientConversationId,
          model: displayModel,
          requestId,
          ...(opaqueRestore.marker ? { previousMarker: opaqueRestore.marker } : {}),
          ...(opaqueRestore.output ? { previousOutput: opaqueRestore.output } : {}),
          ...(opaqueRestore.preservedTail ? { previousPreservedTail: opaqueRestore.preservedTail } : {}),
          ...(opaqueRestore.requiredEntryId ? { requiredEntryId: opaqueRestore.requiredEntryId } : {}),
          ...(opaqueRestore.generation !== undefined ? { expectedGeneration: opaqueRestore.generation } : {}),
          ...(opaqueRestore.stateId ? { previousStateId: opaqueRestore.stateId } : {}),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) throw error;
        // store 级故障必须原子转 NOT_READY，并且当前请求返回同一个机器码。
        // 否则会出现"当前请求泛化 409、/health 仍显示 ready"，且失败可能被
        // 降级成 classic/普通路径继续跑——那等于把持久化保证悄悄丢掉。
        const fault = reportOpaqueCompactStoreFault(error);
        if (fault !== null) {
          const { reason: faultReason, detail: faultDetail } = fault;
          console.warn(
            `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=store_fault reason=${faultReason}` +
              (faultDetail != null ? ` detail=${sanitizeFreeTextForLog(faultDetail)}` : ""),
          );
          recordOpaqueCompactDenial({
            requestId,
            reason: faultReason,
            clientConversationId,
            marker: opaqueRestore.marker,
            accountEntryId: opaqueRestore.requiredEntryId,
            generation: opaqueRestore.generation,
            detail: faultDetail,
            model: displayModel,
            httpStatus: 409,
            durationMs: Date.now() - requestStartedAt,
          });
          c.status(409);
          return c.json(makeError("invalid_request_error", describeOpaqueCompactUnavailable(faultReason)));
        }
        const fallbackErrorName = error instanceof Error ? error.name : "UnknownError";
        const fallbackErrorMessage = error instanceof Error ? error.message : String(error);
        // retryCount 只有 CompactServiceError 才带（executeCompactOnly 内部
        // 显式赋值，见 codex-compact-service.ts）；其他错误类型（非
        // CodexApiError 的意外异常、store 级故障已经在上面分支处理掉）没有
        // 这个概念，undefined 就是诚实的缺省值，不强行凑一个 0。
        const fallbackRetryCount = error instanceof CompactServiceError ? error.retryCount : undefined;
        console.warn(
          `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=fallback` +
            ` error=${fallbackErrorName}` +
            (fallbackRetryCount !== undefined ? ` retry_count=${fallbackRetryCount}` : "") +
            ` message=${sanitizeFreeTextForLog(fallbackErrorMessage)}`,
        );
        // ★ 8.7（task #25）：prompt-too-long 从 409 改判成可降级——不是"再试
        // 一次同一个 compact"（8.5 那条理由仍然成立，重放同一个 compact 确实
        // 没有意义），而是换一个端点（普通生成）。生产实测这条失败 100% 是
        // "会话大到连 compact 自己都塞不下"，不是账号/网络故障；`opaque-compact-
        // bridge.ts` 的预算预判会在多数情况下提前拦截、连上游都不打就抛出这个
        // 分类；少数估算失准的情况下真的打了上游、拿到真实 400，也会在这里
        // 落到同一个判断——两条来源统一处理，调用方不需要关心是哪一种。
        // 旧 marker 不会被这次失败作废：`save()`（真正推进 generation 的那步）
        // 在 `executeCompactOnly`/预算预判之后才会被调用，两者都没走到就抛错，
        // 旧记录原封不动，下一轮仍然可以正常 resolve。
        // ★ 8.10：改成读 `CompactServiceError.promptTooLong` 结构化字段，
        // 不再对 `fallbackErrorMessage` 做 `isPromptTooLongLike` 字符串匹配——
        // reviewer 复审 task #24/#25 时提过这个建议，这次 Dashboard 需求
        // （区分 budget_exceeded/upstream_failed）撞上了第二个用例，一并解决。
        // 非 CompactServiceError 的错误没有这个字段，保守当 false（继续走
        // 409），和字符串匹配失配时的行为一致。
        const isRecompactContextOverflow = opaqueRestore.restored &&
          error instanceof CompactServiceError && error.promptTooLong;
        if (opaqueRestore.restored && !isRecompactContextOverflow) {
          // 8.5：不建议"再试一次同一个 compact"——刚才这次已经在原账号上失败了，
          // 没有理由认为立即重放会不同。给一个必然可行的退出路径（除了 #81
          // 拆出来的 stale_generation/preserved_tail_conflict 两个并发/协议类
          // 例外——那两个的正确建议是"继续对话，重试应该自愈"，见
          // describeRecompactFailure 文档）。
          const cause = deriveRecompactFailureCause(error);
          recordOpaqueCompactDenial({
            requestId,
            reason: "recompact_failed_original_account",
            clientConversationId,
            marker: opaqueRestore.marker,
            accountEntryId: opaqueRestore.requiredEntryId,
            generation: opaqueRestore.generation,
            // ★ #83：reason 本身不变（既有 Dashboard/日志过滤口径依赖它），
            // cause 是新增的子因，供事后区分"这次到底是哪一类失败"。
            cause,
            model: displayModel,
            // ★ #96：这个聚合桶的状态码从不随 cause 变——#81 只拆了文案，
            // #91 没有动这个分支，恒为 409（跟下面 c.status(409) 保持一致）。
            httpStatus: 409,
            // ★ #88：CompactServiceError 已经带着更精确的 durationMs（从
            // respondWithOpaqueCompactMarker 入口算起，见该字段文档）——
            // 优先用它；不是 CompactServiceError（比如 OpaqueCompactStateError
            // 的 CAS 失败）时退化用整条请求的耗时，仍然是诚实的度量，只是
            // 粒度粗一点（多算了一点前面 restore marker 的时间）。
            durationMs: error instanceof CompactServiceError && error.durationMs !== undefined
              ? error.durationMs
              : Date.now() - requestStartedAt,
            upstreamMs: error instanceof CompactServiceError ? error.upstreamMs : undefined,
          });
          c.status(409);
          // ★ #81：按 cause 分文案，不再是不管死因都吐同一句话——见
          // describeRecompactFailure 的三桶划分文档。状态码不变（仍然
          // 409，#91 没有动这条聚合桶），这次只动文案本身。
          return c.json(makeError("invalid_request_error", describeRecompactFailure(cause)));
        }
        // 走到这里有两种情况，处理方式相同：
        // 1. root compact（未曾 restored 过）——这里不是 store 级故障、也不是
        //    "原账号重新 compact 失败"，行为上仍然按原样跌出 if、继续走下面
        //    的普通生成路径——这一点没有变。这部分新增的只是结构化日志，让
        //    19% 的静默降级第一次有 error.message 可查；是否要改这个 fallback
        //    行为本身是另一件事，等有了这份数据再决策。
        // 2. ★ 8.7 新增：recompact 撞上 `isRecompactContextOverflow`——会话
        //    大到连 compact 自己都塞不下，换普通生成端点可能吃得下（详见
        //    `opaque-compact-bridge.ts` 预算预判处的注释）；旧 marker 未被
        //    这次失败作废，见上面 `isRecompactContextOverflow` 分支的注释。
        // `generation` 字段天然区分这两种情况（root 时是初始值，recompact
        // 时 ≥1），查日志时不需要额外字段就能分开统计两条 population。
        recordOpaqueCompactFallback({
          requestId,
          model: displayModel,
          inputItems: codexRequest.input.length,
          clientConversationId,
          accountEntryId: opaqueRestore.requiredEntryId,
          generation: opaqueRestore.generation,
          errorName: fallbackErrorName,
          errorMessage: fallbackErrorMessage,
          retryCount: fallbackRetryCount,
          // ★ 8.10：透传结构化分类，供 Dashboard 快速压缩成功率区分
          // budget_exceeded（预算预判提前拦下）和 upstream_failed（真打了
          // 上游被拒）——见 recordOpaqueCompactFallback 的字段文档。
          ...(error instanceof CompactServiceError
            ? {
                classification: {
                  skippedUpstream: error.skippedUpstream,
                  estimatedTokens: error.estimatedTokens,
                  budgetTokens: error.budgetTokens,
                  // ★ #97：估算可信度三件套，见 CompactServiceErrorClassification
                  // 各自的字段文档——只传 estimateSource 不传 processedFraction
                  // 会让"精确算完的"和"熔断后外推的"共用同一个标签，是这轮
                  // 改动本身要治的病，不能在这里漏传。
                  estimateSource: error.estimateSource,
                  processedFraction: error.processedFraction,
                  cheapEstimateTokens: error.cheapEstimateTokens,
                  // ★ #115：内容画像三件套，同样整条链路一起接，不留半截
                  // ——见 CompactServiceError 的字段文档。
                  hasImage: error.hasImage,
                  imageBytes: error.imageBytes,
                  textBytes: error.textBytes,
                  // ★ #88：耗时埋点，见 CompactServiceError 的字段文档。
                  durationMs: error.durationMs,
                  upstreamMs: error.upstreamMs,
                },
              }
            : {}),
        });
        compactFallbackOccurred = true;
        // ★ team-lead 复核指出的问题：如果这里仍然用 requestStartedAt
        // （整个请求进来那一刻，opaque 尝试**之前**）当 render 的耗时起点，
        // opaque 尝试自己花的时间会被重复计入 render 的 duration_ms——多数
        // 情况下 opaque 失败很快（几十毫秒）可以忽略，但如果 opaque 是被
        // 上游拖到超时才失败（数十秒量级），render 的耗时会严重失真，而
        // 那恰恰是最需要看清"降级之后到底花了多久"的场景。用户会把 opaque
        // 那条和 render 那条并排对比，两条不能重叠计时。这里改成"降级决定
        // 这一刻"——`recordOpaqueCompactFallback` 落盘之后立刻捕获，是 render
        // 真正开始（跌出 if、准备调用 handleProxyRequest/handleDirectRequest）
        // 之前最后一个时间点，跟 opaque 尝试自己的耗时不再重叠。
        fallbackDecidedAt = Date.now();
      }
    }

    // ★ #108/#111：只在真的降级时才挂上这个上下文——`proxy-handler.ts`/
    // `streaming-handler.ts` 靠它判断"这次请求要不要在终止点记一条
    // fallback_render 结果"，见 `ProxyRequest.compactFallbackRender` 和
    // `recordCompactFallbackRenderOutcome` 的文档。`proxyReq` 在
    // `compactFallbackOccurred` 判定之前就已经构建好（对象字面量类型不含
    // 这个可选字段），这里用一次浅拷贝补上，不改 `proxyReq` 本身。
    // `startedAt` 用 `fallbackDecidedAt`（降级决定那一刻），不是
    // `requestStartedAt`（整个请求进来那一刻）——不能让 opaque 尝试自己的
    // 耗时重叠计进 render 的 duration_ms，见上面赋值处的注释。
    const proxyReqWithFallbackContext = compactFallbackOccurred
      ? { ...proxyReq, compactFallbackRender: { requestId, startedAt: fallbackDecidedAt ?? requestStartedAt } }
      : proxyReq;

    // 诊断 header 只在真的走了上面这条 root compact fallback 时才打——
    // 不改响应本身的 status/body/流式行为，纯附加。
    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directModel = routeMatch.resolvedModel ?? req.model;
      const directReq = {
        ...proxyReqWithFallbackContext,
        model: directModel,
        codexRequest: { ...codexRequest, model: directModel },
      };
      const res = await handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt });
      if (compactFallbackOccurred) {
        return finalizeCompactFallbackResponse(res);
      }
      return res;
    }

    const res = await handleProxyRequest({ c, accountPool, cookieJar, req: proxyReqWithFallbackContext, fmt, proxyPool });
    if (compactFallbackOccurred) {
      return finalizeCompactFallbackResponse(res);
    }
    return res;
  });

  return app;
}
