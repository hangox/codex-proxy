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
import { codexApiErrorFromEvent } from "../translation/codex-api-error-from-event.js";
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
  type CodexContentPart,
  type CodexInputItem,
  type CodexSSEEvent,
  type CodexUsageResponse,
} from "./codex-types.js";

const REMOTE_COMPACTION_V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

/** 官方客户端每次 compact 请求都会声明的 beta feature 名。 */
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

/**
 * 把 `feature` 并入逗号分隔的 betaFeatures 串，保持既有值和顺序、去重。
 * 入站可能已经带了同名 feature（新版 codex 客户端直连时），不能重复追加。
 */
function mergeBetaFeatures(existing: string | undefined, feature: string): string {
  const features = (existing ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!features.includes(feature)) features.push(feature);
  return features.join(",");
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

type TextualContentPart = Extract<CodexContentPart, { text: string }>;

/**
 * 判断一个 content part 是否真的带可用的文本。
 *
 * ★ 为什么需要运行时判断而不是直接信类型：这条链路上的入参是**未经校验的
 * 客户端 body**。`responses.ts` 的
 * `input: Array.isArray(body.input) ? ... : []` 只保证它是个数组，元素形状
 * 完全没有约束——TS 类型在这里是一厢情愿，不是运行时保证。
 * `{"role":"user"}`（没有 content）、`{"role":"user","content":123}`、
 * `{"type":"input_audio"}`（没有 text）都是能真的打进来的形状，实测三种
 * 都会抛 TypeError。
 *
 * 而且抛的时机最差：本地装配发生在**上游 compaction 已经成功返回、token
 * 已经花掉之后**，抛的又是 TypeError 而不是 CodexApiError，于是被
 * `responses.ts` 直接 rethrow 成未处理 500——compact 结果丢失、无分类、
 * 无 outcome 记录。v1 时代这个 body 只是原样转发给上游判 400。
 *
 * 判据：本地装配永远不许抛 TypeError。非法形状按「没有文本」处理（计 0 /
 * 原样保留不参与截断），把该报错的责任留给上游。
 */
function isTextualPart(part: unknown): part is TextualContentPart {
  return typeof part === "object"
    && part !== null
    && typeof (part as Record<string, unknown>).text === "string";
}

function userMessageApproxTokens(
  item: Extract<CodexInputItem, { role: "user" }>,
): number {
  if (typeof item.content === "string") return approximateTextTokens(item.content);
  if (!Array.isArray(item.content)) return 0;
  return item.content.reduce((total: number, part) => (
    isTextualPart(part) ? total + approximateTextTokens(part.text) : total
  ), 0);
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
  // 同 userMessageApproxTokens：content 不是数组说明这条 item 形状非法，
  // 本地不判错、也不崩，直接当作「没有可保留的内容」。
  if (!Array.isArray(item.content)) return null;

  let remaining = maxTokens;
  const content = item.content.flatMap((part): typeof item.content => {
    // 没有可信文本的 part（input_image、以及任何未知类型）原样保留，不参与
    // 按 token 预算的截断——不能对它调 Buffer.byteLength。
    if (!isTextualPart(part)) return [part];
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
 * v2 的上游只返回一个 opaque compaction item，历史是**客户端侧**装配的。
 * 这里对齐官方客户端的装配形状：在同一个 64K 保留预算内，从新到旧保留真实的
 * user 消息，最后把 opaque item 接在末尾。
 *
 * 注意 compaction 必须是最后一项——恢复时这一段会整体前置于 preservedTail 和
 * 新一轮消息，顺序错了会让上游把压缩产物当成历史中间的一条普通消息。
 *
 * 本 proxy 的 compact input 不带官方 harness 的 metadata sidecar，无法区分
 * 「真实用户指令」和「harness 包装」，所以对 role=user 的 item 一律保守地当成
 * 真实用户消息：偶尔多留一条包装，比丢掉一条真实用户指令安全。
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
        // 取消是调用方的终态决定，不是可恢复的失败。在这里降级到 HTTP 会用
        // 一个**已经 abort 的 signal** 发起第二次请求；只订阅「将来的 abort
        // 事件」而不检查当前状态的传输实现会因此永远挂住。
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
   * 按当前的 Responses compaction 协议压缩历史。
   *
   * v2 走普通的流式 /codex/responses，靠 input 末尾的 `compaction_trigger`
   * 哨兵表达「这是一次压缩」。走哪个协议由 `model.compact_protocol` 决定，
   * **没有任何基于上游错误文案的自动回落**。
   *
   * 为什么不做自动回落（这条是刻意删掉的，不是漏了）：
   *
   * 1. 自动回落的目标端点（legacy JSON /responses/compact）**当前本身就是
   *    404**。回落到一个确定失败的端点，期望价值不是「降级可用」而是负的：
   *    白发一次请求，并且把真实失败原因替换成 v1 的 Not Found。
   * 2. 判据只能来自上游的错误文案，而「从错误文案反推上游支不支持某能力」
   *    本身就是错的抽象。实测过一条 `Invalid value for 'input':
   *    compaction_trigger must be the last input item`——这是**位置放错**、
   *    请求构造 bug，却同时命中 `invalid` 和 `compaction_trigger` 两个关键词
   *    被判成「v2 不可用」，于是发起第二次请求，客户端最终看到的是 404，
   *    而上游真实原因是 400 参数错。一个本该让人立刻看出请求写错了的错误，
   *    被洗成了「上游把端点下掉了」。
   * 3. 代价不对称：误判「不支持」= 白花一次 compact + 掩盖真因；误判
   *    「支持」= 一次明确报错。后者便宜得多，所以默认方向应该是**不回落**。
   *
   * 还有一条更硬的：404 在这里根本不可能意味着「v2 不被支持」——
   * `/codex/responses` 是所有普通请求都在打的端点。它返回空 body 404 的真实
   * 含义是 Cloudflare path-block，`error-classification.ts` 的
   * `isCfPathBlockError` 专门认这个形状，并接着一整套清 cookie / 计数 /
   * 到阈值禁用账号的恢复逻辑。把它吞成「v2 不可用」会让这套自愈延迟一次
   * 浪费请求才触发，且真因（指纹失配）被掩盖。
   *
   * 上游真回滚了怎么办：`model.compact_protocol: "v1"`，一个配置键的事，
   * 不需要发版——这也是保留 `createCompactResponseV1` 的唯一理由。
   */
  async createCompactResponse(
    request: CodexCompactRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
  ): Promise<CodexCompactResponse> {
    return getConfig().model.compact_protocol === "v1"
      ? this.createCompactResponseV1(request, signal)
      : this.createCompactResponseV2(request, signal, onRateLimits);
  }

  private async createCompactResponseV2(
    request: CodexCompactRequest,
    signal?: AbortSignal,
    onRateLimits?: (rl: ParsedRateLimit) => void,
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
      // ★ 能力协商必须是**声明式**的，不能靠「服务端默认开着」。官方客户端
      // （codex-rs `session/mod.rs`）对 Feature::RemoteCompactionV2 做了显式
      // 特例：无条件进 x-codex-beta-features，每一次请求都带。
      //
      // proxy 这边此前只透传 request.betaFeatures，而它唯一来源是入站
      // header；opaque compact bridge 的入站是 Claude Code 的 /v1/messages，
      // 永远不带这个 header——也就是说所有 compact 请求都没有做过 feature
      // 协商，现在能跑通只说明服务端默认打开。一旦服务端改成按 header 门禁，
      // 会再次大面积失败，且形态和这次的 404 一模一样。
      betaFeatures: mergeBetaFeatures(request.betaFeatures, REMOTE_COMPACTION_V2_FEATURE),
      ...(request.version ? { version: request.version } : {}),
      ...(request.includeTimingMetrics ? { includeTimingMetrics: request.includeTimingMetrics } : {}),
      ...(request.codexWindowId ? { codexWindowId: request.codexWindowId } : {}),
      ...(request.parentThreadId ? { parentThreadId: request.parentThreadId } : {}),
    };

    // 上游错误原样上抛：不再猜「这个错误是不是意味着 v2 不被支持」。
    // 尤其是 404——它在这里几乎必然是 Cloudflare path-block，吞掉会让
    // proxy-error-handler 的清 cookie / 计数 / 禁用账号整套自愈失效。
    // onRateLimits 必须往下传：v2 的 compact 走的是和普通请求同一条 WS 通道，
    // 上游会在流里发 `codex.rate_limits` 帧。不接这个回调的话这些帧被直接丢弃
    // ——账号池的额度视图会漏掉所有 compact 消耗的配额，越用越偏。
    const response = await this.createResponse(v2Request, signal, onRateLimits);

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
        // 流内错误的 code→status 映射复用既有的 codexApiErrorFromEvent（它的
        // 文件头注释写明就是给非流式 collector 用的，v2 collector 正是这类
        // 调用方）。此前这里自己写了第三份码表，且与既有实现分歧——例如
        // code=not_found 在既有实现是 400、那份是 502。
        throw codexApiErrorFromEvent(extractCodexError(event.data));
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

    // 正常情况下 compaction item 从 response.output_item.done 流出来。取不到时
    // 退而从 response.completed 的 output 里找——proxy 有 WS 和 HTTP-SSE 两条
    // 通道，转发行为不保证完全一致，升级成硬 502 会把「传输抖动」变成一次
    // 失败的付费 compact，所以这里保持宽松。但它是**非预期路径**，必须留痕，
    // 否则将来只会看到「有时候好使」而查不出差异出在哪条通道。
    const usedDoneOutput = doneOutput.some(isCompactionItem);
    if (!usedDoneOutput) {
      console.warn(
        `[CodexApi] compaction recovered from response.completed; `
        + `output_item.done had ${doneOutput.length} items, none of them compaction`,
      );
    }
    const outputItems = usedDoneOutput ? doneOutput : completedOutput;
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
      compaction_protocol: "v2",
      ...(completedUsage ? { usage: completedUsage } : {}),
    };
  }

  /**
   * legacy 的非流式 JSON compact 端点。
   *
   * 保留它的唯一理由是「上游回滚时不被焊死」——由 `model.compact_protocol: "v1"`
   * 显式选择进入，**不存在任何自动回落到这里的路径**（原因见
   * createCompactResponse 的注释）。
   */
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
      // compaction_protocol 由 proxy 盖章，不信上游 body 里可能带的同名字段。
      const withProtocol: CodexCompactResponse = { ...parsed, compaction_protocol: "v1" };
      return usage ? { ...withProtocol, usage } : withProtocol;
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
