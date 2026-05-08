/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType, AnthropicMessagesRequest } from "../types/anthropic.js";
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
  handleDirectRequest,
  type FormatAdapter,
  type ResponseMetadata,
  type UsageHint,
} from "./shared/proxy-handler.js";
import { extractAnthropicClientConversationId } from "./shared/anthropic-session-id.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
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
  if (req.messages.length !== 1) return false;
  const [message] = req.messages;
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
    formatError: (_status, msg) => makeError("api_error", msg),
    streamTranslator: (
      api,
      response,
      model,
      onUsage,
      onResponseId,
      _tupleSchema,
      usageHint?: UsageHint,
      onResponseMetadata?: (metadata: ResponseMetadata) => void,
    ) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking, usageHint, onResponseMetadata),
    collectTranslator: (
      api,
      response,
      model,
      _tupleSchema,
      usageHint?: UsageHint,
      onResponseMetadata?: (metadata: ResponseMetadata) => void,
    ) =>
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

    // Auth check
    if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    const clientConversationId = extractAnthropicClientConversationId(
      req,
      c.req.header("x-claude-code-session-id"),
    );

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
      request: summarizeRequestForLog("messages", req, {
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
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream,
      clientConversationId: clientConversationId ?? undefined,
    };

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directReq = {
        ...proxyReq,
        model: req.model,
        codexRequest: { ...codexRequest, model: req.model },
      };
      return handleDirectRequest(c, routeMatch.adapter, directReq, fmt);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool);
  });

  return app;
}
