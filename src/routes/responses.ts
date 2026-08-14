/**
 * POST /v1/responses — Codex Responses API passthrough.
 *
 * Accepts the native Codex Responses API format and streams raw SSE events
 * back to the client without translation. Provides multi-account load balancing,
 * retry logic, and usage tracking via the shared proxy handler.
 */

import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { CodexApi, CodexApiError } from "../proxy/codex-api.js";
import type { CodexResponsesRequest, CodexCompactRequest } from "../proxy/codex-api.js";
import { sanitizeCodexInputItems } from "../proxy/reasoning-input-sanitizer.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import { getConfig } from "../config.js";
import { prepareSchema, isRecord } from "../translation/shared-utils.js";
import { parseModelName, resolveModelId, buildDisplayModelName } from "../models/model-store.js";
import { EmptyResponseError, type UsageInfo } from "../translation/codex-event-extractor.js";
import { handleProxyRequest } from "./shared/proxy-handler.js";
import { staggerIfNeeded } from "./shared/proxy-stagger.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import { acquireAccount, releaseAccount } from "./shared/account-acquisition.js";
import { handleCodexApiError } from "./shared/proxy-error-handler.js";
import { applyParsedRateLimits } from "./shared/proxy-rate-limit.js";
import {
  isPromptTooLongLike,
  normalizePromptTooLongMessage,
} from "../proxy/prompt-too-long-error.js";
import { withRetry } from "../utils/retry.js";
import {
  extractOpenAISubagentFromMetadata,
  normalizeOpenAISubagent,
  OPENAI_SUBAGENT_HEADER,
  sanitizeClientMetadata,
} from "../proxy/openai-subagent.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { PASSTHROUGH_FORMAT } from "./responses-passthrough.js";

export {
  extractResponseUsage,
  extractImageGenUsage,
  streamPassthrough,
  collectPassthrough,
} from "./responses-passthrough.js";

const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER = "x-responsesapi-include-timing-metrics";
const X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id";
const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

// ── Helpers ───────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstHeaderOrMetadata(
  c: Context,
  metadata: Record<string, string>,
  headerName: string,
): string | null {
  return nonEmptyString(c.req.header(headerName)) ?? nonEmptyString(metadata[headerName]);
}

// ── Shared auth check ─────────────────────────────────────────────

function checkAuth(
  c: Context,
  accountPool: AccountPool,
  allowUnauthenticated: boolean = false,
): Response | null {
  if (!allowUnauthenticated && !accountPool.hasAnyActiveAccount()) {
    c.status(401);
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_api_key",
        message: "Not authenticated. Please login first at /",
      },
    });
  }
  return null;
}

function parseBody(c: Context, body: unknown): Record<string, unknown> | Response {
  if (!isRecord(body)) {
    c.status(400);
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_request",
        message: "Request body must be a JSON object",
      },
    });
  }
  return body;
}

function formatResponsesError(status: number, msg: string): unknown {
  if (isPromptTooLongLike(msg)) {
    return {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: normalizePromptTooLongMessage(msg),
      },
    };
  }
  return {
    type: "error",
    error: {
      type: status >= 400 && status < 500 ? "invalid_request_error" : "server_error",
      code: "codex_api_error",
      message: msg,
    },
  };
}

// ── Build CodexApi helper ─────────────────────────────────────────

function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(token, accountId, cookieJar, entryId, proxyUrl);
}

// ── Compact handler (non-streaming JSON proxy) ────────────────────

async function handleCompact(
  c: Context,
  accountPool: AccountPool,
  cookieJar: CookieJar | undefined,
  proxyPool: ProxyPool | undefined,
  body: Record<string, unknown>,
  upstreamRouter?: UpstreamRouter,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : "codex";
  const parsed = parseModelName(rawModel);
  const modelId = resolveModelId(parsed.modelId);

  // Build CodexCompactRequest — matches codex-rs CompactionInput
  const compactRequest: CodexCompactRequest = {
    model: modelId,
    input: Array.isArray(body.input) ? sanitizeCodexInputItems(body.input) : [],
    instructions: typeof body.instructions === "string" ? body.instructions : "",
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    compactRequest.tools = body.tools;
  }
  // Compact responses don't surface tool_usage.image_gen, so any image_generation
  // tool sent here can only be classified as failed regardless of upstream outcome.
  // Counting it still catches accidental misuse on the dashboard.
  const compactExpectsImageGen = Array.isArray(body.tools)
    && body.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");
  const compactImageFailedUsage: UsageInfo | undefined = compactExpectsImageGen
    ? { input_tokens: 0, output_tokens: 0, image_request_attempted: true, image_request_succeeded: false }
    : undefined;
  if (typeof body.parallel_tool_calls === "boolean") {
    compactRequest.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (isRecord(body.reasoning)) {
    const r: Record<string, string> = {};
    if (typeof body.reasoning.effort === "string") r.effort = body.reasoning.effort;
    if (typeof body.reasoning.summary === "string") r.summary = body.reasoning.summary;
    if (Object.keys(r).length > 0) compactRequest.reasoning = r;
  }
  if (
    isRecord(body.text) &&
    isRecord(body.text.format) &&
    typeof body.text.format.type === "string"
  ) {
    compactRequest.text = {
      format: {
        type: body.text.format.type as "text" | "json_object" | "json_schema",
        ...(typeof body.text.format.name === "string" ? { name: body.text.format.name } : {}),
        ...(isRecord(body.text.format.schema) ? { schema: body.text.format.schema as Record<string, unknown> } : {}),
        ...(typeof body.text.format.strict === "boolean" ? { strict: body.text.format.strict } : {}),
      },
    };
  }

  const compactRouteMatch = upstreamRouter?.resolveMatch(rawModel);
  if (compactRouteMatch?.kind === "api-key" || compactRouteMatch?.kind === "adapter") {
    const directModel = compactRouteMatch.resolvedModel ?? rawModel;
    const directReq = {
      codexRequest: {
        model: directModel,
        input: compactRequest.input,
        instructions: compactRequest.instructions,
        stream: true as const,
        store: false as const,
        ...(compactRequest.tools ? { tools: compactRequest.tools } : {}),
        ...(compactRequest.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: compactRequest.parallel_tool_calls }
          : {}),
        ...(compactRequest.reasoning ? { reasoning: compactRequest.reasoning } : {}),
        ...(compactRequest.text ? { text: compactRequest.text } : {}),
      },
      model: directModel,
      isStreaming: false,
    };
    return handleDirectRequest({ c, upstream: compactRouteMatch.adapter, req: directReq, fmt: PASSTHROUGH_FORMAT });
  }

  // Acquire account
  const TAG = "Compact";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();

  const acquired = acquireAccount(accountPool, modelId, undefined, TAG);
  if (!acquired) {
    c.status(503);
    return c.json(formatResponsesError(503, "No available accounts. All accounts are expired or rate-limited."));
  }

  let entryId = acquired.entryId;
  triedEntryIds.push(entryId);
  let codexApi = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);

  console.log(
    `[${TAG}] Account ${entryId} | model=${modelId} | input_items=${compactRequest.input.length}`,
  );

  await staggerIfNeeded(acquired.prevSlotMs);

  for (;;) {
    try {
      // signal 必须传给 withRetry：只传给 createCompactResponse 的话，客户端
      // 中断后正在跑的那一次会被取消，但 withRetry 自己的退避 sleep 醒来后
      // 照样会发起下一次尝试——实测客户端在第一次请求时就 abort，上游仍被
      // 打满 3 次。用户按了 Ctrl-C，账单照跑。
      const result = await withRetry(
        () => codexApi.createCompactResponse(compactRequest, c.req.raw.signal, (rateLimits) => {
          applyParsedRateLimits({ accountPool, entryId, rateLimits });
        }),
        { tag: TAG, signal: c.req.raw.signal },
      );

      releaseAccount(accountPool, entryId, compactImageFailedUsage, released);
      return c.json(result);
    } catch (err) {
      if (!(err instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, compactImageFailedUsage, released);
        throw err;
      }

      // cookieJar 必须传：Cloudflare path-block 分支里是 `cookieJar?.clear(entryId)`，
      // 不传的话可选链把它静默变成 no-op，而紧跟着那句
      // "cleared cookies and retrying..." 的日志照打——「日志说清了、实际没清」，
      // 属于会把排查方向直接带偏的那类假象。实测 cookie jar 里的 __cf_bm 原样残留。
      // 同一个函数在 codex-compact-service.ts 的调用点是传了的，只有这条路由漏了。
      // safeLog=false 是**刻意**的，不是漏传：safeLog 只给受隐私合同约束的
      // opaque compact 路径用（见 proxy-error-handler.ts 的 @param 说明），
      // 而 /v1/responses/compact 是普通代理路由，打明文账号标识是既有的正确
      // 行为。不要因为「看起来更安全」把它改成 true——那会改变这条路由的
      // 日志语义。
      const decision = handleCodexApiError(
        err, accountPool, entryId, modelId, TAG, false, cookieJar, false,
      );

      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, compactImageFailedUsage, released);
        c.status(decision.status as StatusCode);
        return c.json(formatResponsesError(decision.status, decision.message));
      }

      if (decision.releaseBeforeRetry) {
        releaseAccount(accountPool, entryId, compactImageFailedUsage, released);
      }

      const retry = acquireAccount(accountPool, modelId, triedEntryIds, TAG);
      if (!retry) {
        const status = decision.status as StatusCode;
        c.status(status);
        if (decision.useFormat429) {
          return c.json({
            type: "error",
            error: {
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
              message: decision.message,
            },
          });
        }
        return c.json(formatResponsesError(status, decision.message));
      }

      entryId = retry.entryId;
      triedEntryIds.push(entryId);
      codexApi = buildCodexApi(retry.token, retry.accountId, cookieJar, entryId, proxyPool);
      console.log(`[${TAG}] Fallback → account ${retry.entryId}`);
      await staggerIfNeeded(retry.prevSlotMs);
      continue;
    }
  }
}

// ── Route ──────────────────────────────────────────────────────────

export function createResponsesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();
  // Register errorHandler locally so that when testing this router in isolation (e.g. unit tests),
  // uncaught errors are still handled and formatted appropriately.
  app.onError(errorHandler);

  const responsesHandler = async (c: Context) => {
    const rawBody = await c.req.json();

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";
    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    const config = getConfig();
    const parsed = parseModelName(rawModel);
    const modelId = resolveModelId(parsed.modelId);
    const displayModel = buildDisplayModelName(parsed);

    const codexRequest: CodexResponsesRequest = {
      model: modelId,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      input: Array.isArray(body.input) ? sanitizeCodexInputItems(body.input) : [],
      stream: true,
      store: false,
    };

    // CODEX_PROXY_DISABLE_WS=1 临时绕开 ws 路径上游阻断（incident 2026-05-07）
    if (process.env.CODEX_PROXY_DISABLE_WS !== "1") {
      codexRequest.useWebSocket = true;
    }
    const forcedReview = c.req.path === "/v1/responses/review" || c.req.path === "/responses/review";
    const openAiSubagent =
      forcedReview
        ? "review"
        : normalizeOpenAISubagent(c.req.header(OPENAI_SUBAGENT_HEADER)) ??
          extractOpenAISubagentFromMetadata(body.client_metadata);
    const clientMetadata = sanitizeClientMetadata(body.client_metadata);
    delete clientMetadata[OPENAI_SUBAGENT_HEADER];
    if (openAiSubagent) clientMetadata[OPENAI_SUBAGENT_HEADER] = openAiSubagent;
    if (Object.keys(clientMetadata).length > 0) {
      codexRequest.client_metadata = clientMetadata;
    }
    if (typeof body.previous_response_id === "string") {
      codexRequest.previous_response_id = body.previous_response_id;
    }
    if (typeof body.prompt_cache_key === "string") {
      codexRequest.prompt_cache_key = body.prompt_cache_key;
    }
    if (Array.isArray(body.include) && body.include.every((v) => typeof v === "string")) {
      codexRequest.include = body.include as string[];
    }
    codexRequest.turnState =
      nonEmptyString(body.turnState) ??
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_TURN_STATE_HEADER) ??
      undefined;
    codexRequest.turnMetadata =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_TURN_METADATA_HEADER) ??
      undefined;
    codexRequest.betaFeatures =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_BETA_FEATURES_HEADER) ??
      undefined;
    codexRequest.includeTimingMetrics =
      firstHeaderOrMetadata(c, clientMetadata, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER) ??
      undefined;
    codexRequest.version = nonEmptyString(c.req.header("Version")) ?? undefined;
    codexRequest.codexWindowId =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_WINDOW_ID_HEADER) ??
      undefined;
    codexRequest.parentThreadId =
      firstHeaderOrMetadata(c, clientMetadata, X_CODEX_PARENT_THREAD_ID_HEADER) ??
      undefined;

    // Reasoning effort: explicit body > suffix > config default
    const effort =
      (isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
        ? body.reasoning.effort
        : null) ??
      parsed.reasoningEffort ??
      config.model.default_reasoning_effort;
    const clientReasoningRecord = isRecord(body.reasoning) ? body.reasoning : null;
    if (effort || clientReasoningRecord) {
      const summary =
        clientReasoningRecord && typeof clientReasoningRecord.summary === "string"
          ? clientReasoningRecord.summary
          : "auto";
      codexRequest.reasoning = { summary, ...(effort ? { effort } : {}) };
    }

    // Service tier
    const serviceTier =
      (typeof body.service_tier === "string" ? body.service_tier : null) ??
      parsed.serviceTier ??
      config.model.default_service_tier ??
      null;
    if (serviceTier) {
      codexRequest.service_tier = serviceTier;
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      codexRequest.tools = body.tools;
    }
    if (body.tool_choice !== undefined) {
      codexRequest.tool_choice = body.tool_choice as CodexResponsesRequest["tool_choice"];
    }
    if (typeof body.parallel_tool_calls === "boolean") {
      codexRequest.parallel_tool_calls = body.parallel_tool_calls;
    }

    const expectsImageGen = Array.isArray(body.tools)
      && body.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");

    // Text format (JSON mode / structured outputs)
    let tupleSchema: Record<string, unknown> | null = null;
    if (
      isRecord(body.text) &&
      isRecord(body.text.format) &&
      typeof body.text.format.type === "string"
    ) {
      let formatSchema: Record<string, unknown> | undefined;
      if (isRecord(body.text.format.schema)) {
        const prepared = prepareSchema(body.text.format.schema as Record<string, unknown>);
        formatSchema = prepared.schema;
        tupleSchema = prepared.originalSchema;
      }
      codexRequest.text = {
        format: {
          type: body.text.format.type as "text" | "json_object" | "json_schema",
          ...(typeof body.text.format.name === "string"
            ? { name: body.text.format.name }
            : {}),
          ...(formatSchema ? { schema: formatSchema } : {}),
          ...(typeof body.text.format.strict === "boolean"
            ? { strict: body.text.format.strict }
            : {}),
        },
      };
    }

    const clientWantsStream = body.stream !== false;
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: clientWantsStream,
      tupleSchema,
      expectsImageGen,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: rawModel,
      stream: clientWantsStream,
      request: summarizeRequestForLog("responses", body, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directModel = routeMatch.resolvedModel ?? rawModel;
      const directReq = { ...proxyReq, model: directModel, codexRequest: { ...codexRequest, model: directModel } };
      return handleDirectRequest({ c, upstream: routeMatch.adapter, req: directReq, fmt: PASSTHROUGH_FORMAT });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: PASSTHROUGH_FORMAT, proxyPool });
  };

  const compactHandler = async (c: Context) => {
    const rawBody = await c.req.json();

    const body = parseBody(c, rawBody);
    if (body instanceof Response) return body;

    const rawModel = typeof body.model === "string" ? body.model : "codex";
    const routeMatch = upstreamRouter?.resolveMatch(rawModel);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";
    const authErr = checkAuth(c, accountPool, allowUnauthenticated);
    if (authErr) return authErr;

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: rawModel,
      stream: false,
      request: summarizeRequestForLog("responses", body, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    return handleCompact(c, accountPool, cookieJar, proxyPool, body, upstreamRouter);
  };

  app.post("/v1/responses", apiKeyAuth(accountPool), responsesHandler);
  app.post("/v1/responses/review", apiKeyAuth(accountPool), responsesHandler);
  app.post("/responses", apiKeyAuth(accountPool), responsesHandler);
  app.post("/responses/review", apiKeyAuth(accountPool), responsesHandler);
  app.post("/v1/responses/compact", apiKeyAuth(accountPool), compactHandler);

  return app;
}
