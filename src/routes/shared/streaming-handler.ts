import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
import type { SessionAffinityMap } from "../../auth/session-affinity.js";
import type { CodexApi, WsPoolContext } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import { EmptyResponseError, type UsageInfo } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import type { FormatAdapter, ProxyRequest, UsageHint } from "./proxy-handler-types.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";
import { recordCompactFallbackRenderOutcome } from "./compact-outcome-log.js";
import { streamResponse } from "./response-processor.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";
import { logProxyUsage } from "./proxy-usage-log.js";
import { retryNonStreamingEmptyResponse } from "./non-streaming-empty-response-retry.js";
import { handleNonStreamingEmptyResponseExhausted } from "./non-streaming-empty-response-exhausted.js";

const MAX_EMPTY_RETRIES = 2;

export interface HandleStreamingOptions {
  c: Context;
  accountPool: AccountPool;
  req: ProxyRequest;
  fmt: FormatAdapter;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  api: CodexApi;
  response: Response;
  entryId: string;
  abortController: AbortController;
  released: Set<string>;
  requestId: string;
  affinityMap: SessionAffinityMap;
  conversationId: string;
  turnState?: string;
  usageHint?: UsageHint;
  variantHash: string;
  buildPoolCtx?: (forEntryId: string) => WsPoolContext | undefined;
  setActiveAccount?: (entryId: string, api: CodexApi) => void;
}

export function handleStreaming(options: HandleStreamingOptions): Response {
  const {
    c,
    accountPool,
    req,
    fmt,
    cookieJar,
    proxyPool,
    api,
    response,
    entryId,
    abortController,
    released,
    requestId,
    affinityMap,
    conversationId,
    turnState,
    usageHint,
    variantHash,
    buildPoolCtx,
    setActiveAccount,
  } = options;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  let currentEntryId = entryId;
  let currentApi = api;
  let currentResponse = response;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  let responseCompleted = false;
  let metadataCollector = createResponseMetadataCollector();

  return stream(c, async (s) => {
    s.onAbort(() => {
      console.warn(`[stream-client-abort] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}`);
      recordStreamCloseEvent({
        kind: "client-abort",
        requestId,
        tag: fmt.tag,
        model: req.model,
        accountEntryId: currentEntryId,
        variantHash,
        responseId: capturedResponseId ?? null,
      });
      abortController.abort();
    });
    const recordStreamAffinity = (): void => {
      if (!capturedResponseId) return;
      if (!responseCompleted) return;
      affinityMap.record(
        capturedResponseId,
        currentEntryId,
        conversationId,
        turnState,
        req.codexRequest.instructions ?? undefined,
        usageInfo?.input_tokens,
        Array.from(metadataCollector.responseFunctionCallIds),
        variantHash,
      );
    };
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await streamResponse({
            writer: s,
            api: currentApi,
            response: currentResponse,
            model: req.model,
            adapter: fmt,
            onUsage: (u) => {
              usageInfo = u;
              recordStreamAffinity();
            },
            tupleSchema: req.tupleSchema,
            onResponseId: (id) => {
              capturedResponseId = id;
              recordStreamAffinity();
            },
            onResponseCompleted: (id) => {
              if (id) capturedResponseId = id;
              responseCompleted = true;
              recordStreamAffinity();
            },
            usageHint,
            onResponseMetadata: (metadata) => {
              metadataCollector.onResponseMetadata(metadata);
              recordStreamAffinity();
            },
            diagnostics: {
              requestId: requestId.slice(0, 8),
              tag: fmt.tag,
              provider: "codex",
              path: "/codex/responses",
              accountEntryId: currentEntryId,
              variantHash,
              abortSignal: abortController.signal,
            },
            rethrowEmptyResponseBeforeWrite: true,
          });
          break;
        } catch (err) {
          if (!(err instanceof EmptyResponseError)) {
            throw err;
          }
          if (attempt > MAX_EMPTY_RETRIES) {
            const responsePlan = handleNonStreamingEmptyResponseExhausted({
              accountPool,
              entryId: currentEntryId,
              req,
              tag: fmt.tag,
              attempt,
              maxRetries: MAX_EMPTY_RETRIES,
              released,
            });
            await s.write(
              fmt.formatStreamError?.(responsePlan.status, responsePlan.message) ??
                `data: ${JSON.stringify({ error: { message: responsePlan.message, type: "stream_error" } })}\n\n`,
            );
            return;
          }

          const retry = await retryNonStreamingEmptyResponse({
            accountPool,
            currentEntryId,
            collectErr: err,
            req,
            tag: fmt.tag,
            attempt,
            maxRetries: MAX_EMPTY_RETRIES,
            cookieJar,
            proxyPool,
            abortSignal: abortController.signal,
            released,
            requestId,
            buildPoolCtx,
            setActiveAccount: (nextEntryId, nextApi) => {
              currentEntryId = nextEntryId;
              currentApi = nextApi;
              setActiveAccount?.(nextEntryId, nextApi);
            },
          });
          if (retry.action === "respond") {
            await s.write(
              fmt.formatStreamError?.(retry.status, retry.message) ??
                `data: ${JSON.stringify({ error: { message: retry.message, type: "stream_error" } })}\n\n`,
            );
            return;
          }
          currentEntryId = retry.entryId;
          currentApi = retry.api;
          currentResponse = retry.rawResponse;
          usageInfo = undefined;
          capturedResponseId = null;
          responseCompleted = false;
          metadataCollector = createResponseMetadataCollector();
        }
      }
    } finally {
      abortController.abort();
      recordStreamAffinity();
      if (usageInfo) {
        logProxyUsage({
          sensitive: options.req.requiredAccountEntryId !== undefined,
          tag: fmt.tag,
          entryId: currentEntryId,
          requestId,
          usage: usageInfo,
          includeImageTokens: true,
          includeReasoningInHighInputWarning: true,
        });
      }
      // ★ #108/#111：这个 finally 是"进入了流式阶段"的 compact-fallback-render
      // 请求唯一的真实终止点——`responseCompleted` 只在上游真正发出完成
      // 事件时置 true（中途断流/空响应耗尽重试/客户端中止都不会），是货真
      // 价实的完成信号，不是"流开始了"。no-op 除非 `req.compactFallbackRender`
      // 存在（见该字段文档）。失败时 `failureStage: "mid_stream"`——已经进了
      // 流式阶段才失败，跟 `proxy-handler.ts` 那几个"从未进流式阶段"的
      // `"pre_stream"` 终止点是完全不同的排查方向（查链路稳定性，不是查
      // 预算估算），不能共用同一个值。
      recordCompactFallbackRenderOutcome(
        req,
        responseCompleted,
        responseCompleted ? undefined : { failureStage: "mid_stream" },
      );
      releaseAccount(accountPool, currentEntryId, annotateImageGenOutcome(usageInfo, req.expectsImageGen), released);
    }
  });
}
