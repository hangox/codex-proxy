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
  buildClaudeCodeCompactRequest,
  buildClaudeCodeRenderRequest,
  executeCompactRender,
  extractClaudeCodeCompactPrompt,
  respondWithCompactRender,
} from "./shared/codex-compact-service.js";
import {
  respondWithOpaqueCompactMarker,
  restoreOpaqueCompactRequest,
} from "./shared/opaque-compact-bridge.js";
import {
  extractOpaqueCompactStateMarker,
  getOpaqueCompactStateReadiness,
  hasOpaqueCompactStateReference,
  isOpaqueCompactMarkerBindingMismatch,
  isSelfHealableOpaqueCompactStateFailure,
  isUnparseableOpaqueCompactMarker,
  replaceIgnoredOpaqueCompactMarker,
  reportOpaqueCompactStoreFault,
} from "./shared/opaque-compact-state.js";

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
 * - `expired`：8.1 已经让 /compact 真正自愈，这里建议 /compact 是诚实的——
 *   下一次 /compact 会拿到全新 state，不会重放同一个 409。
 * - `not_found`（含内存模式的 `missing`）：没有"过期状态"可以刷新，/compact
 *   在语义上更接近凭空新建；给用户更明确的"这段历史已经不可恢复"信号，
 *   引导 `/clear` 而不是暗示还有东西能救回来。
 * - 其余（store 级致命故障 + tampered/account_mismatch/comp_hash_mismatch/
 *   preserved_tail_conflict/state_too_large/stale_generation）：不承诺重试
 *   会成功（store 可能仍未恢复，或本来就是需要人工介入的异常），只给一个
 *   保底、必然可行的退出路径。
 */
function describeOpaqueCompactUnavailable(reason: string): string {
  if (reason === "expired") {
    return "Opaque compact state has expired and will be automatically refreshed on your next /compact. " +
      "Run /compact to continue this session.";
  }
  if (reason === "not_found" || reason === "missing") {
    return "The compact state for this session could not be found and cannot be recovered. " +
      "Run /clear and start a new session.";
  }
  return `Opaque compact state is unavailable (${reason}). If this persists, run /clear and start a new session.`;
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
  return makeError(status === 429 ? "rate_limit_error" : "api_error", message);
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
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: () =>
      makeError(
        "overloaded_error",
        "No available accounts. All accounts are expired or rate-limited.",
      ),
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
    const compactBridgeEnabled = modelConfig.claude_code_compact_bridge;
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
        c.status(409);
        return c.json(makeError(
          "invalid_request_error",
          `Opaque compact state is unavailable (${readiness.reason}). If this persists, run /clear and start a new session.`,
        ));
      }
    }
    const compactPrompt = (compactBridgeEnabled || opaqueCompactEnabled) &&
      req.stream === true &&
      clientConversationId !== null
      ? extractClaudeCodeCompactPrompt(req)
      : null;

    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const fmt = makeAnthropicFormat(wantThinking);

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
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
    // 那一环从"仅回滚期间"搬进日常路径。自愈（selfHealable）成功的分支
    // 走全新 root compact，不在这里处理（见下方该分支单独的说明）。
    let ignoredMarker: string | null = ignoredMarkerFromDisabledSwitch;
    if (opaqueRestore.error) {
      // store 级故障（损坏/密钥/schema）与单请求语义错误（session 不匹配、
      // marker 过期）走同一个出口，但前者要同时把 runtime 转成 NOT_READY，
      // 让 /health 与后续请求给出同一个 reason。下面几个分类函数判定为
      // "不致命"时这里是 no-op；判定致命时仍然原子转 NOT_READY。
      reportOpaqueCompactStoreFault(opaqueRestore.error);
      const reason = opaqueRestore.error.reason;
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
        // 族 A 自愈：全新 root compact 会产出一份全新摘要，旧 marker 文本
        // 是"这次 compact 输入"的噪音而非"直接透传给用户对话"的内容，
        // 占位替换的收益小、复杂度高（respondWithOpaqueCompactMarker 内部
        // 另外用 req 重新构建 compact 请求），本轮范围内不处理，只处理会
        // 原样进入普通转发路径的族 B。
        if (!selfHealable) ignoredMarker = errorMarker ?? ignoredMarker;
        opaqueRestore = { restored: false };
      } else {
        c.status(409);
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

    if (compactPrompt && clientConversationId !== null && req.stream === true && !allowUnauthenticated && opaqueCompactEnabled) {
      // store 不可用时必须在打上游之前 fail-closed：否则会白花一次 compact 调用，
      // 拿到 output 后却无处保存，最终仍要报错。
      // reason 透传 runtime 的真实原因（锁/密钥/schema/损坏），不折叠成一个笼统值——
      // 运维要靠它区分"第二实例抢锁"和"密钥丢了"。
      const readiness = getOpaqueCompactStateReadiness();
      if (!readiness.ready) {
        c.status(409);
        return c.json(makeError("invalid_request_error", describeOpaqueCompactUnavailable(readiness.reason ?? "store_unavailable")));
      }
      try {
        return await respondWithOpaqueCompactMarker({
          c,
          accountPool,
          cookieJar,
          proxyPool,
          req,
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
        const faultReason = reportOpaqueCompactStoreFault(error);
        if (faultReason !== null) {
          console.warn(
            `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=store_fault reason=${faultReason}`,
          );
          c.status(409);
          return c.json(makeError("invalid_request_error", describeOpaqueCompactUnavailable(faultReason)));
        }
        console.warn(
          `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=fallback` +
            ` error=${error instanceof Error ? error.name : "UnknownError"}`,
        );
        if (opaqueRestore.restored) {
          // 8.5：不建议"再试一次同一个 compact"——刚才这次已经在原账号上失败了，
          // 没有理由认为立即重放会不同。给一个必然可行的退出路径。
          c.status(409);
          return c.json(makeError(
            "invalid_request_error",
            "Opaque compact state could not be compacted on its original account. " +
              "Run /clear and start a new session.",
          ));
        }
      }
    }

    if (compactPrompt && clientConversationId !== null && req.stream === true && !allowUnauthenticated && compactBridgeEnabled) {
      const abortController = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      const compactRequest = buildClaudeCodeCompactRequest(req, codexRequest);
      const renderTemplate = buildClaudeCodeRenderRequest(
        codexRequest,
        [],
        compactPrompt,
        codexRequest.useWebSocket === true,
      );
      try {
        const lease = await executeCompactRender({
          accountPool,
          cookieJar,
          proxyPool,
          compactRequest,
          renderTemplate,
          compactPrompt,
          signal: abortController.signal,
          requestId,
        });
        return respondWithCompactRender({
          c,
          accountPool,
          lease,
          fmt,
          model: displayModel,
          requestId,
          abortController,
        });
      } catch (error) {
        if (abortController.signal.aborted) throw error;
        console.warn(
          `[ClaudeCompactBridge] rid=${requestId.slice(0, 8)} phase=fallback` +
            ` error=${error instanceof Error ? error.name : "UnknownError"}`,
        );
        // Fail safely: the original parsed request is untouched, so the normal
        // Anthropic -> Codex path below can process it exactly as before.
      }
    }

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directModel = routeMatch.resolvedModel ?? req.model;
      const directReq = {
        ...proxyReq,
        model: directModel,
        codexRequest: { ...codexRequest, model: directModel },
      };
      return handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt, proxyPool });
  });

  return app;
}
