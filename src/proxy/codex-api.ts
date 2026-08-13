/**
 * CodexApi — client for the Codex Responses API.
 *
 * Endpoint: POST /backend-api/codex/responses
 * This is the API the Codex CLI actually uses.
 * It requires: instructions, store: false, stream: true.
 *
 * All upstream requests go through the TLS transport layer
 * (native rustls transport).
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import {
  buildHeaders,
  buildHeadersWithContentType,
} from "../fingerprint/manager.js";
import {
  createWebSocketResponse,
  type WsCreateRequest,
  type WsPoolContext,
} from "./ws-transport.js";
import type { ParsedRateLimit } from "./rate-limit-headers.js";
import { getInstallationId } from "./installation-id.js";
import { normalizeOpenAISubagent, OPENAI_SUBAGENT_HEADER } from "./openai-subagent.js";
import {
  buildPromptTooLongErrorBody,
  isPromptTooLongLike,
  promptTooLongStatus,
} from "./prompt-too-long-error.js";

export type { WsPoolContext };
import { parseSSEBlock, parseSSEStream } from "./codex-sse.js";
import {
  extractCodexError,
  parseNormalizedHostModelUsage,
} from "../types/codex-events.js";
import { fetchUsage } from "./codex-usage.js";
import { fetchModels, probeEndpoint as probeEndpointFn } from "./codex-models.js";
import type { CookieJar } from "./cookie-jar.js";
import type { BackendModelEntry } from "../models/model-store.js";

const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER = "x-responsesapi-include-timing-metrics";
const X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id";
const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

export function normalizeServiceTierForUpstream(serviceTier: string | null | undefined): string | undefined {
  if (!serviceTier) return undefined;
  return serviceTier === "fast" ? "priority" : serviceTier;
}

// Re-export types from codex-types.ts for backward compatibility
export type {
  CodexResponsesRequest,
  CodexCompactRequest,
  CodexCompactResponse,
  CodexContentPart,
  CodexInputItem,
  CodexSSEEvent,
  CodexUsageRateWindow,
  CodexUsageRateLimit,
  CodexUsageResponse,
  CodexUsageCredits,
  CodexUsageSpendControl,
  CodexUsageRateLimitReachedType,
} from "./codex-types.js";

// Re-export SSE utilities for consumers that used them via CodexApi
export { parseSSEBlock, parseSSEStream } from "./codex-sse.js";

import {
  CodexApiError,
  PreviousResponseWebSocketError,
  type CodexResponsesRequest,
  type CodexCompactRequest,
  type CodexCompactResponse,
  type CodexInputItem,
  type CodexSSEEvent,
  type CodexUsageResponse,
} from "./codex-types.js";

const REMOTE_COMPACTION_V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

class CompactV2UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactV2UnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompactionItem(value: unknown): value is Extract<CodexInputItem, { type: "compaction" }> {
  return isRecord(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string";
}

function approximateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function truncateUtf8TextToApproxTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const maxBytes = maxTokens * 4;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(""), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join("");
}

function userMessageApproxTokens(
  item: Extract<CodexInputItem, { role: "user" }>,
): number {
  if (typeof item.content === "string") return approximateTextTokens(item.content);
  return item.content.reduce((total, part) => {
    if (part.type === "input_text" || part.type === "output_text") {
      return total + approximateTextTokens(part.text);
    }
    return total;
  }, 0);
}

function truncateUserMessageToApproxTokens(
  item: Extract<CodexInputItem, { role: "user" }>,
  maxTokens: number,
): Extract<CodexInputItem, { role: "user" }> | null {
  if (maxTokens <= 0) return null;
  if (typeof item.content === "string") {
    const content = truncateUtf8TextToApproxTokens(item.content, maxTokens);
    return content ? { ...item, content } : null;
  }

  let remaining = maxTokens;
  const content = item.content.flatMap((part): typeof item.content => {
    if (part.type === "input_image") return [part];
    if (remaining <= 0) return [];
    const tokens = approximateTextTokens(part.text);
    if (tokens <= remaining) {
      remaining -= tokens;
      return [part];
    }
    const text = truncateUtf8TextToApproxTokens(part.text, remaining);
    remaining = 0;
    return text ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...item, content } : null;
}

/**
 * Remote compaction v2 returns only the opaque compaction item. Match Codex's
 * client-side installation shape by retaining real user messages, newest first,
 * within the same 64K retained-message budget, then appending the opaque item.
 *
 * This proxy's compact input does not carry Codex's harness metadata sidecar, so
 * every role=user item is conservatively treated as a real user message. Keeping
 * an occasional wrapper is safer than dropping a genuine user instruction.
 */
function buildCompactV2Output(
  input: CodexInputItem[],
  compaction: Extract<CodexInputItem, { type: "compaction" }>,
): unknown[] {
  let remaining = REMOTE_COMPACTION_V2_RETAINED_MESSAGE_TOKEN_BUDGET;
  const retainedReversed: Array<Extract<CodexInputItem, { role: "user" }>> = [];

  for (let index = input.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = input[index];
    if (!("role" in item) || item.role !== "user") continue;
    const tokens = Math.max(userMessageApproxTokens(item), 1);
    if (tokens <= remaining) {
      retainedReversed.push(item);
      remaining -= tokens;
      continue;
    }
    const truncated = truncateUserMessageToApproxTokens(item, remaining);
    if (truncated) retainedReversed.push(truncated);
    remaining = 0;
  }

  retainedReversed.reverse();
  return [...retainedReversed, compaction];
}

function isCompactV2Unavailable(status: number, code: string, message: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400) return false;
  const detail = `${code} ${message}`.toLowerCase();
  const namesTrigger = detail.includes("compaction_trigger") || detail.includes("compaction trigger");
  const saysUnavailable = [
    "unsupported",
    "not supported",
    "unknown",
    "unrecognized",
    "invalid",
    "not allowed",
    "not enabled",
  ].some((needle) => detail.includes(needle));
  return namesTrigger && saysUnavailable;
}

function streamErrorStatus(code: string, message: string): number {
  const normalizedCode = code.toLowerCase();
  if (["invalid_request_error", "invalid_value", "unsupported_value"].includes(normalizedCode)) return 400;
  if (["usage_limit_reached", "rate_limit_exceeded", "rate_limit_reached"].includes(normalizedCode)) return 429;
  if (["quota_exhausted", "payment_required"].includes(normalizedCode)) return 402;
  if (["unauthorized", "token_invalid", "token_expired", "account_deactivated"].includes(normalizedCode)) return 401;
  if (["forbidden", "account_banned", "banned"].includes(normalizedCode)) return 403;
  if (normalizedCode === "context_length_exceeded" || isPromptTooLongLike(message)) return 400;
  return 502;
}

function normalizePromptTooLongApiError(err: CodexApiError): CodexApiError {
  if (!isPromptTooLongLike(err.body) && !isPromptTooLongLike(err.message)) {
    return err;
  }
  return new CodexApiError(
    promptTooLongStatus(err.status),
    buildPromptTooLongErrorBody(err.body || err.message),
  );
}

function getConnectPhaseErrorMeta(err: unknown): { phase: "pre-connect" | "mid-stream" | "unknown"; recoverable: boolean } {
  if (!(err instanceof Error)) {
    return { phase: "unknown", recoverable: false };
  }
  const rec = err as unknown as Record<string, unknown>;
  return {
    phase: rec.phase === "pre-connect" || rec.phase === "mid-stream" || rec.phase === "unknown"
      ? rec.phase
      : "unknown",
    recoverable: rec.recoverable === true,
  };
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

export class CodexApi {
  readonly tag = "codex" as const;

  private token: string;
  private accountId: string | null;
  private cookieJar: CookieJar | null;
  private entryId: string | null;
  private proxyUrl: string | null | undefined;
  private baseUrl: string | undefined;
  private transport: TlsTransport | undefined;

  constructor(
    token: string,
    accountId: string | null,
    cookieJar?: CookieJar | null,
    entryId?: string | null,
    proxyUrl?: string | null,
    baseUrl?: string,
    transport?: TlsTransport,
  ) {
    this.token = token;
    this.accountId = accountId;
    this.cookieJar = cookieJar ?? null;
    this.entryId = entryId ?? null;
    this.proxyUrl = proxyUrl;
    this.baseUrl = baseUrl;
    this.transport = transport;
  }

  private resolveBaseUrl(): string {
    return this.baseUrl ?? getConfig().api.base_url;
  }

  private resolveTransport(): TlsTransport {
    return this.transport ?? getTransport();
  }

  private buildConversationIdentity(request: CodexResponsesRequest): {
    conversationId: string | null;
    windowId: string | null;
  } {
    const conversationId =
      typeof request.prompt_cache_key === "string" && request.prompt_cache_key.trim()
        ? request.prompt_cache_key.trim()
        : null;
    return {
      conversationId,
      windowId:
        (typeof request.codexWindowId === "string" && request.codexWindowId.trim()
          ? request.codexWindowId.trim()
          : null) ??
        (conversationId ? `${conversationId}:0` : null),
    };
  }

  private firstRequestString(request: CodexResponsesRequest, key: string): string | null {
    const direct =
      key === X_CODEX_TURN_METADATA_HEADER
        ? request.turnMetadata
        : key === X_CODEX_BETA_FEATURES_HEADER
          ? request.betaFeatures
          : key === X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER
            ? request.includeTimingMetrics
            : key === X_CODEX_PARENT_THREAD_ID_HEADER
              ? request.parentThreadId
              : key === X_CODEX_WINDOW_ID_HEADER
                ? request.codexWindowId
                : undefined;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const metadata = request.client_metadata?.[key];
    if (typeof metadata === "string" && metadata.trim()) return metadata.trim();
    return null;
  }

  private applyCodexContextHeaders(headers: Record<string, string>, request: CodexResponsesRequest): void {
    if (request.turnState) headers["x-codex-turn-state"] = request.turnState;
    const turnMetadata = this.firstRequestString(request, X_CODEX_TURN_METADATA_HEADER);
    if (turnMetadata) headers[X_CODEX_TURN_METADATA_HEADER] = turnMetadata;
    const betaFeatures = this.firstRequestString(request, X_CODEX_BETA_FEATURES_HEADER);
    if (betaFeatures) headers[X_CODEX_BETA_FEATURES_HEADER] = betaFeatures;
    const timingMetrics = this.firstRequestString(request, X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER);
    if (timingMetrics) headers[X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER] = timingMetrics;
    if (request.version?.trim()) headers["Version"] = request.version.trim();
    const parentThreadId = this.firstRequestString(request, X_CODEX_PARENT_THREAD_ID_HEADER);
    if (parentThreadId) headers[X_CODEX_PARENT_THREAD_ID_HEADER] = parentThreadId;
  }

  private buildCodexClientMetadata(
    request: CodexResponsesRequest,
    installationId: string,
    windowId: string | null,
  ): Record<string, string> {
    const metadata: Record<string, string> = {
      ...(request.client_metadata ?? {}),
      "x-codex-installation-id": installationId,
      ...(windowId ? { [X_CODEX_WINDOW_ID_HEADER]: windowId } : {}),
    };
    const turnMetadata = this.firstRequestString(request, X_CODEX_TURN_METADATA_HEADER);
    if (turnMetadata) metadata[X_CODEX_TURN_METADATA_HEADER] = turnMetadata;
    const parentThreadId = this.firstRequestString(request, X_CODEX_PARENT_THREAD_ID_HEADER);
    if (parentThreadId) metadata[X_CODEX_PARENT_THREAD_ID_HEADER] = parentThreadId;
    return metadata;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** Build headers with cookies injected. */
  private applyHeaders(headers: Record<string, string>): Record<string, string> {
    if (this.cookieJar && this.entryId) {
      const cookie = this.cookieJar.getCookieHeader(this.entryId);
      if (cookie) headers["Cookie"] = cookie;
    }
    return headers;
  }

  /** Capture Set-Cookie headers from transport response into the jar. */
  private captureCookies(setCookieHeaders: string[]): void {
    if (this.cookieJar && this.entryId && setCookieHeaders.length > 0) {
      this.cookieJar.captureRaw(this.entryId, setCookieHeaders);
    }
  }

  /** Query official Codex usage/quota. Delegates to standalone fetchUsage(). */
  async getUsage(): Promise<CodexUsageResponse> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return fetchUsage(headers, this.proxyUrl);
  }

  /**
   * Warmup request: GET /codex/usage with cookie capture.
   * Establishes session cookies (cf_clearance, __cf_bm, etc.) so subsequent
   * API requests look like a continuous session rather than a cold start.
   * Returns usage data if successful, null on any error.
   */
  async warmup(): Promise<CodexUsageResponse | null> {
    const config = getConfig();
    const transport = this.resolveTransport();
    const url = `${config.api.base_url}/codex/usage`;
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["Accept"] = "application/json";
    if (!transport.isImpersonate()) {
      headers["Accept-Encoding"] = "gzip, deflate";
    }

    try {
      let body: string;
      if (transport.getWithCookies) {
        const result = await transport.getWithCookies(url, headers, 15, this.proxyUrl);
        this.captureCookies(result.setCookieHeaders);
        body = result.body;
      } else {
        const result = await transport.get(url, headers, 15, this.proxyUrl);
        body = result.body;
      }
      const parsed = JSON.parse(body) as CodexUsageResponse;
      return parsed.rate_limit ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Fetch available models from the Codex backend. Probes known endpoints; returns null if none respond. */
  async getModels(): Promise<BackendModelEntry[] | null> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return fetchModels(headers, this.proxyUrl);
  }

  /** Probe a backend endpoint and return raw JSON (for debug). */
  async probeEndpoint(path: string): Promise<Record<string, unknown> | null> {
    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    return probeEndpointFn(path, headers, this.proxyUrl);
  }

  /**
   * Create a response (streaming).
   * Routes to WebSocket when previous_response_id is present (HTTP SSE doesn't support it).
   * 仅当不依赖 previous_response_id 时，WebSocket 失败后才降级到 HTTP SSE。
   */
  async createResponse(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
    poolCtx?: WsPoolContext,
  ): Promise<Response> {
    if (request.useWebSocket) {
      try {
        return await this.createResponseViaWebSocket(request, signal, onRateLimits, poolCtx);
      } catch (err) {
        // Cancellation is a terminal caller decision. Falling back to HTTP here
        // starts a second request with an already-aborted signal; transports that
        // only subscribe for future abort events can then hang indefinitely.
        if (isAbortLikeError(err, signal)) throw err;
        // Real upstream API errors classified by ws-transport (e.g.
        // usage_limit_reached → CodexApiError(429)) must reach the
        // proxy-handler's rotation flow on the SAME account, not retry
        // via HTTP — HTTP would just hit the same quota.
        if (err instanceof CodexApiError) {
          throw normalizePromptTooLongApiError(err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (request.previous_response_id) {
          console.warn(
            `[CodexApi] WebSocket 失败（${msg}），previous_response_id 不能安全降级到 HTTP SSE`,
          );
          const meta = getConnectPhaseErrorMeta(err);
          throw new PreviousResponseWebSocketError(msg, meta);
        }
        console.warn(`[CodexApi] WebSocket failed (${msg}), falling back to HTTP SSE`);
        const { previous_response_id: _, useWebSocket: _ws, ...httpRequest } = request;
        return this.createResponseViaHttp(httpRequest as CodexResponsesRequest, signal);
      }
    }
    return this.createResponseViaHttp(request, signal);
  }

  /**
   * Create a response via WebSocket (for previous_response_id support).
   * Returns a Response with SSE-formatted body, compatible with parseStream().
   * No Content-Type header — WebSocket upgrade handles auth via same headers.
   */
  private async createResponseViaWebSocket(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
    poolCtx?: WsPoolContext,
  ): Promise<Response> {
    const baseUrl = this.resolveBaseUrl();
    const wsUrl = baseUrl.replace(/^https?:/, "wss:") + "/codex/responses";

    const headers = this.applyHeaders(
      buildHeaders(this.token, this.accountId),
    );
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();
    const installationId = getInstallationId();
    headers["x-codex-installation-id"] = installationId;
    const identity = this.buildConversationIdentity(request);
    if (identity.conversationId) {
      headers["x-client-request-id"] = identity.conversationId;
      headers["session_id"] = identity.conversationId;
    }
    if (identity.windowId) headers["x-codex-window-id"] = identity.windowId;
    this.applyCodexContextHeaders(headers, request);
    const openAiSubagent = normalizeOpenAISubagent(request.client_metadata?.[OPENAI_SUBAGENT_HEADER]);
    if (openAiSubagent) headers[OPENAI_SUBAGENT_HEADER] = openAiSubagent;

    const wsRequest: WsCreateRequest = {
      type: "response.create",
      model: request.model,
      instructions: request.instructions ?? "",
      input: request.input,
      store: false,
      stream: true,
    };
    if (request.previous_response_id) {
      wsRequest.previous_response_id = request.previous_response_id;
    }
    if (request.reasoning) wsRequest.reasoning = request.reasoning;
    if (request.tools?.length) wsRequest.tools = request.tools;
    wsRequest.tool_choice = request.tool_choice ?? "auto";
    wsRequest.parallel_tool_calls = request.parallel_tool_calls ?? true;
    if (request.text) wsRequest.text = request.text;
    const serviceTier = normalizeServiceTierForUpstream(request.service_tier);
    if (serviceTier) wsRequest.service_tier = serviceTier;
    if (request.prompt_cache_key) wsRequest.prompt_cache_key = request.prompt_cache_key;
    if (request.include?.length) wsRequest.include = request.include;
    wsRequest.client_metadata = this.buildCodexClientMetadata(request, installationId, identity.windowId);

    return createWebSocketResponse(wsUrl, headers, wsRequest, signal, this.proxyUrl, onRateLimits, poolCtx);
  }

  /**
   * Create a response via HTTP SSE (default transport).
   * No wall-clock timeout — header timeout + AbortSignal provide protection.
   */
  private async createResponseViaHttp(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const transport = this.resolveTransport();
    const baseUrl = this.resolveBaseUrl();
    const url = `${baseUrl}/codex/responses`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    headers["Accept"] = "text/event-stream";
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();
    const installationId = getInstallationId();
    headers["x-codex-installation-id"] = installationId;
    const identity = this.buildConversationIdentity(request);
    if (identity.conversationId) {
      headers["x-client-request-id"] = identity.conversationId;
      headers["session_id"] = identity.conversationId;
    }
    if (identity.windowId) headers["x-codex-window-id"] = identity.windowId;
    this.applyCodexContextHeaders(headers, request);
    const openAiSubagent = normalizeOpenAISubagent(request.client_metadata?.[OPENAI_SUBAGENT_HEADER]);
    if (openAiSubagent) headers[OPENAI_SUBAGENT_HEADER] = openAiSubagent;

    const {
      previous_response_id: _pid,
      useWebSocket: _ws,
      turnState: _ts,
      turnMetadata: _tm,
      betaFeatures: _bf,
      version: _ver,
      includeTimingMetrics: _timing,
      codexWindowId: _window,
      parentThreadId: _parent,
      service_tier,
      ...bodyFields
    } = request;
    const upstreamServiceTier = normalizeServiceTierForUpstream(service_tier);
    const bodyWithMetadata = {
      ...bodyFields,
      ...(upstreamServiceTier ? { service_tier: upstreamServiceTier } : {}),
      client_metadata: this.buildCodexClientMetadata(request, installationId, identity.windowId),
    };
    const body = JSON.stringify(bodyWithMetadata);

    let transportRes;
    try {
      transportRes = await transport.post(url, headers, body, signal, undefined, this.proxyUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, msg);
    }

    this.captureCookies(transportRes.setCookieHeaders);

    if (transportRes.status < 200 || transportRes.status >= 300) {
      const MAX_ERROR_BODY = 1024 * 1024;
      const reader = transportRes.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize <= MAX_ERROR_BODY) {
          chunks.push(value);
        } else {
          const overshoot = totalSize - MAX_ERROR_BODY;
          if (value.byteLength > overshoot) {
            chunks.push(value.subarray(0, value.byteLength - overshoot));
          }
          reader.cancel();
          break;
        }
      }
      const errorBody = Buffer.concat(chunks).toString("utf-8");
      const promptTooLong = isPromptTooLongLike(errorBody);
      throw new CodexApiError(
        promptTooLong ? promptTooLongStatus(transportRes.status) : transportRes.status,
        promptTooLong ? buildPromptTooLongErrorBody(errorBody) : errorBody,
      );
    }

    return new Response(transportRes.body, {
      status: transportRes.status,
      headers: transportRes.headers,
    });
  }

  /**
   * Compact conversation history with the current Responses compaction protocol.
   *
   * v2 sends a trailing `compaction_trigger` through the normal streaming
   * /codex/responses endpoint. The legacy JSON /responses/compact endpoint is
   * retained only as a compatibility fallback when v2 is explicitly unavailable.
   */
  async createCompactResponse(
    request: CodexCompactRequest,
    signal?: AbortSignal,
  ): Promise<CodexCompactResponse> {
    try {
      return await this.createCompactResponseV2(request, signal);
    } catch (err) {
      if (!(err instanceof CompactV2UnavailableError)) throw err;
      console.warn(`[CodexApi] Remote compact v2 unavailable (${err.message}); falling back to v1`);
      return this.createCompactResponseV1(request, signal);
    }
  }

  private async createCompactResponseV2(
    request: CodexCompactRequest,
    signal?: AbortSignal,
  ): Promise<CodexCompactResponse> {
    const v2Request: CodexResponsesRequest = {
      model: request.model,
      instructions: request.instructions,
      input: [...request.input, { type: "compaction_trigger" }],
      stream: true,
      store: false,
      useWebSocket: true,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: request.parallel_tool_calls }
        : {}),
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(request.text ? { text: request.text } : {}),
      ...(request.service_tier ? { service_tier: request.service_tier } : {}),
      ...(request.prompt_cache_key ? { prompt_cache_key: request.prompt_cache_key } : {}),
      ...(request.client_metadata ? { client_metadata: request.client_metadata } : {}),
      ...(request.turnState ? { turnState: request.turnState } : {}),
      ...(request.turnMetadata ? { turnMetadata: request.turnMetadata } : {}),
      ...(request.betaFeatures ? { betaFeatures: request.betaFeatures } : {}),
      ...(request.version ? { version: request.version } : {}),
      ...(request.includeTimingMetrics ? { includeTimingMetrics: request.includeTimingMetrics } : {}),
      ...(request.codexWindowId ? { codexWindowId: request.codexWindowId } : {}),
      ...(request.parentThreadId ? { parentThreadId: request.parentThreadId } : {}),
    };

    let response: Response;
    try {
      response = await this.createResponse(v2Request, signal);
    } catch (err) {
      if (
        err instanceof CodexApiError
        && isCompactV2Unavailable(err.status, "", err.body || err.message)
      ) {
        throw new CompactV2UnavailableError(`HTTP ${err.status}: ${err.message}`);
      }
      throw err;
    }

    let sawCompleted = false;
    let completedUsage: CodexCompactResponse["usage"];
    const completedOutput: unknown[] = [];
    const doneOutput: unknown[] = [];

    for await (const event of this.parseStream(response)) {
      if (event.event === "response.output_item.done" && isRecord(event.data)) {
        if (isRecord(event.data.item)) doneOutput.push(event.data.item);
        continue;
      }

      if (event.event === "response.completed" && isRecord(event.data) && isRecord(event.data.response)) {
        sawCompleted = true;
        const rawOutput = event.data.response.output;
        if (Array.isArray(rawOutput)) completedOutput.push(...rawOutput);
        completedUsage = parseNormalizedHostModelUsage(event.data.response.usage);
        break;
      }

      if (event.event === "error" || event.event === "response.failed") {
        const upstream = extractCodexError(event.data);
        const status = streamErrorStatus(upstream.code, upstream.message);
        if (isCompactV2Unavailable(status, upstream.code, upstream.message)) {
          throw new CompactV2UnavailableError(`${upstream.code}: ${upstream.message}`);
        }
        const errorBody = JSON.stringify({ error: upstream });
        if (isPromptTooLongLike(upstream.message)) {
          throw new CodexApiError(promptTooLongStatus(status), buildPromptTooLongErrorBody(errorBody));
        }
        throw new CodexApiError(status, errorBody);
      }
    }

    // ★ 下面两处都是**协议违例**（上游把这次请求当成功处理了，只是内容不
    // 符合 v2 约定），不是传输抖动——重放同样的请求只会得到同样的结果，
    // 并且每一次重放都是一整轮真金白银的 compact。必须显式标成不可重试，
    // 否则 `withRetry`（status 5xx 即重试）会把一次语义错误放大成 3 次付费
    // 请求。传输层真正的 5xx 不带这个标记，正常重试行为不受影响。
    if (!sawCompleted) {
      throw new CodexApiError(
        502,
        "Remote compact v2 stream closed before response.completed",
        { retryable: false },
      );
    }

    const outputItems = doneOutput.some(isCompactionItem) ? doneOutput : completedOutput;
    const compactions = outputItems.filter(isCompactionItem);
    if (compactions.length !== 1) {
      throw new CodexApiError(
        502,
        `Remote compact v2 expected exactly one compaction output item, got ${compactions.length} from ${outputItems.length} output items`,
        { retryable: false },
      );
    }

    return {
      output: buildCompactV2Output(request.input, compactions[0]),
      ...(completedUsage ? { usage: completedUsage } : {}),
    };
  }

  /** Legacy non-streaming JSON compact endpoint (v1 compatibility fallback). */
  private async createCompactResponseV1(
    request: CodexCompactRequest,
    signal?: AbortSignal,
  ): Promise<CodexCompactResponse> {
    const transport = this.resolveTransport();
    const baseUrl = this.resolveBaseUrl();
    const url = `${baseUrl}/codex/responses/compact`;

    const headers = this.applyHeaders(
      buildHeadersWithContentType(this.token, this.accountId),
    );
    // No "Accept: text/event-stream" — compact returns plain JSON
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
    headers["x-openai-internal-codex-residency"] = "us";
    headers["x-client-request-id"] = crypto.randomUUID();
    const installationId = getInstallationId();
    headers["x-codex-installation-id"] = installationId;
    const identity = this.buildConversationIdentity(request as CodexResponsesRequest);
    if (identity.conversationId) {
      headers["x-client-request-id"] = identity.conversationId;
      headers["session_id"] = identity.conversationId;
    }
    if (identity.windowId) headers["x-codex-window-id"] = identity.windowId;
    this.applyCodexContextHeaders(headers, request as CodexResponsesRequest);
    const openAiSubagent = normalizeOpenAISubagent(request.client_metadata?.[OPENAI_SUBAGENT_HEADER]);
    if (openAiSubagent) headers[OPENAI_SUBAGENT_HEADER] = openAiSubagent;

    const {
      turnState: _ts,
      turnMetadata: _tm,
      betaFeatures: _bf,
      version: _ver,
      includeTimingMetrics: _timing,
      codexWindowId: _window,
      parentThreadId: _parent,
      client_metadata: _metadata,
      service_tier,
      ...bodyFields
    } = request;
    const upstreamServiceTier = normalizeServiceTierForUpstream(service_tier);
    const body = JSON.stringify({
      ...bodyFields,
      ...(upstreamServiceTier ? { service_tier: upstreamServiceTier } : {}),
    });

    let transportRes;
    try {
      transportRes = await transport.post(url, headers, body, signal, undefined, this.proxyUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CodexApiError(0, msg);
    }

    this.captureCookies(transportRes.setCookieHeaders);

    // Read the full response body (non-streaming)
    const reader = transportRes.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const responseBody = Buffer.concat(chunks).toString("utf-8");

    if (transportRes.status < 200 || transportRes.status >= 300) {
      const promptTooLong = isPromptTooLongLike(responseBody);
      throw new CodexApiError(
        promptTooLong ? promptTooLongStatus(transportRes.status) : transportRes.status,
        promptTooLong ? buildPromptTooLongErrorBody(responseBody) : responseBody,
      );
    }

    try {
      const parsed = JSON.parse(responseBody) as CodexCompactResponse;
      // qa 实测：compact 响应顶层确实带 usage（{input_tokens,
      // input_tokens_details:{cached_tokens}, output_tokens,
      // output_tokens_details:{reasoning_tokens}, total_tokens}），但此前
      // CodexCompactResponse 只声明了 output——usage 被自己的类型遮蔽，没人
      // 读就跟着 JSON.parse 一起被丢弃了（同账号同规模：1 次 compact 记
      // window_input_tokens +0，1 次普通请求记 +41756）。这里复用
      // parseNormalizedHostModelUsage（streaming 路径同一份实现，见
      // codex-events.ts 文档），不是重新发明一套解析口径。缺 usage（或形状
      // 不对）时返回 undefined，不是 0——调用方（codex-compact-service.ts）
      // 必须能区分"这次真的没有 usage"和"usage 是 0"，不能替上游瞎猜。
      const usage = parseNormalizedHostModelUsage((parsed as { usage?: unknown }).usage);
      return usage ? { ...parsed, usage } : parsed;
    } catch {
      throw new CodexApiError(502, `Compact response is not valid JSON: ${responseBody.slice(0, 200)}`);
    }
  }

  /**
   * Parse SSE stream from a Codex Responses API response.
   * Delegates to the standalone parseSSEStream() function.
   */
  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    yield* parseSSEStream(response);
  }
}

// Re-export CodexApiError for backward compatibility
export { CodexApiError, PreviousResponseWebSocketError } from "./codex-types.js";
