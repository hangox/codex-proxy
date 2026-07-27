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
  reportOpaqueCompactStoreFault,
} from "./shared/opaque-compact-state.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
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
      c.status(409);
      return c.json(makeError(
        "invalid_request_error",
        "Opaque compact state requires the original Claude Code session and Codex account route. Run /compact again.",
      ));
    }
    if (hasOpaqueReference && opaqueStateReference === null) {
      c.status(409);
      return c.json(makeError(
        "invalid_request_error",
        "Opaque compact state marker is malformed. Run /compact again.",
      ));
    }

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
    if (opaqueMarkerCandidate && !opaqueCompactEnabled) {
      c.status(409);
      return c.json(makeError(
        "invalid_request_error",
        "Opaque compact state support is disabled. Run /compact again.",
      ));
    }
    // 已开启但 store 未就绪：把结构化 reason 一并给出，便于区分锁/密钥/schema/损坏。
    if (opaqueMarkerCandidate && opaqueCompactEnabled) {
      const readiness = getOpaqueCompactStateReadiness();
      if (!readiness.ready) {
        c.status(409);
        return c.json(makeError(
          "invalid_request_error",
          `Opaque compact state is unavailable (${readiness.reason}). Run /compact again.`,
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

    const opaqueRestore = opaqueCompactEnabled && clientConversationId !== null && !allowUnauthenticated
      ? restoreOpaqueCompactRequest({
          req,
          translated: codexRequest,
          clientConversationId,
          requestId,
          // 数据密钥按账号派生，解封需要本实例已知的账号集合。
          accountCandidates: accountPool.getAllEntries().map((entry) => entry.id),
        })
      : { restored: false };
    if (opaqueRestore.error) {
      // store 级故障（损坏/密钥/schema）与单请求语义错误（session 不匹配、
      // marker 过期）走同一个出口，但前者要同时把 runtime 转成 NOT_READY，
      // 让 /health 与后续请求给出同一个 reason。
      reportOpaqueCompactStoreFault(opaqueRestore.error);
      c.status(409);
      return c.json(makeError(
        "invalid_request_error",
        `Opaque compact state is unavailable (${opaqueRestore.error.reason}). Run /compact again.`,
      ));
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
        return c.json(makeError(
          "invalid_request_error",
          `Opaque compact state store is unavailable (${readiness.reason}). Run /compact again after the proxy recovers.`,
        ));
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
          return c.json(makeError(
            "invalid_request_error",
            `Opaque compact state store is unavailable (${faultReason}). Run /compact again after the proxy recovers.`,
          ));
        }
        console.warn(
          `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=fallback` +
            ` error=${error instanceof Error ? error.name : "UnknownError"}`,
        );
        if (opaqueRestore.restored) {
          c.status(409);
          return c.json(makeError(
            "invalid_request_error",
            "Opaque compact state could not be compacted on its original account. Try again or start a new session.",
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
