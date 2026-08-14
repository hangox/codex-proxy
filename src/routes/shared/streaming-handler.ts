import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
import { clearCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import type { ChainAdvanceTicket, SessionAffinityMap } from "../../auth/session-affinity.js";
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
import { getReasoningReplayCache } from "../../proxy/reasoning-replay-cache.js";
import { getWsPool } from "../../proxy/ws-pool.js";

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
  chainAdvanceTicket?: ChainAdvanceTicket;
  /** Whether this attempt was sent with an implicit-resume
   *  `previous_response_id`. Needed to break the dead-chain retry loop:
   *  if the upstream stream ends without response.completed while resume was
   *  active — silent close OR terminal error/response.failed frame — the
   *  cached prev id chain is poisoned and must be dropped so the client's
   *  retry performs a full-input replay instead of resending the same dead
   *  delta. */
  implicitResumeActive?: boolean;
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
    chainAdvanceTicket,
    implicitResumeActive = false,
  } = options;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  // Disable response buffering on nginx-class reverse proxies so SSE heartbeats
  // and deltas reach the client immediately instead of being held back.
  c.header("X-Accel-Buffering", "no");

  let currentEntryId = entryId;
  let currentApi = api;
  let currentResponse = response;
  let usageInfo: UsageInfo | undefined;
  let capturedResponseId: string | null = null;
  let responseCompleted = false;
  let streamCompletedWithoutError = false;
  let metadataCollector = createResponseMetadataCollector();
  const reasoningReplayCache = getReasoningReplayCache();

  return stream(c, async (s) => {
    let clientAborted = false;
    let streamFailed = true;
    s.onAbort(() => {
      if (streamCompletedWithoutError || responseCompleted) {
        return;
      }
      clientAborted = true;
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
        req.codexRequest.instructions,
        usageInfo?.input_tokens,
        Array.from(metadataCollector.responseFunctionCallIds),
        variantHash,
        chainAdvanceTicket,
      );
      if (!metadataCollector.invalidReasoningReplay && metadataCollector.reasoningReplayItems.length > 0) {
        reasoningReplayCache.record({
          responseId: capturedResponseId,
          entryId: currentEntryId,
          conversationId,
          variantHash,
          items: metadataCollector.reasoningReplayItems,
        });
      }
    };
    const evictReasoningReplayIdentity = (): void => {
      reasoningReplayCache.evictByIdentity({
        entryId: currentEntryId,
        conversationId,
        variantHash,
      });
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
              if (metadataCollector.invalidReasoningReplay) {
                evictReasoningReplayIdentity();
              }
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
          streamFailed = false;
          streamCompletedWithoutError = true;
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
      if (streamFailed && !clientAborted && !abortController.signal.aborted) {
        abortController.abort();
      }
      recordStreamAffinity();
      if (implicitResumeActive && !responseCompleted && !clientAborted) {
        // A resumed stream that ends without response.completed — whether via
        // silent close, an upstream terminal error/response.failed frame, or a
        // transport exception — leaves the prev id chain poisoned: the
        // client's retry would resend the same delta against the same dead
        // prev id and loop. The pooled WS may also keep rehashing to the same
        // bad backend. Drop both so the retry does a full-input replay over a
        // fresh connection instead.
        const cause = metadataCollector.terminalFailure
          ? "terminal failure frame"
          : metadataCollector.prematureClose
            ? "premature close"
            : "stream ended without response.completed";
        const dropped = affinityMap.forgetConversation(conversationId, variantHash);
        getWsPool().evictByEntryId(currentEntryId);
        console.warn(
          `[implicit-resume-poison] rid=${requestId.slice(0, 8)} tag=${fmt.tag} model=${req.model}` +
            ` ${cause} on resumed stream — dropped ${dropped} affinity entries` +
            ` conv=${conversationId.slice(0, 8)} vh=${variantHash.slice(0, 12)}` +
            ` and evicted pooled WS for entry=${currentEntryId.slice(0, 8)};` +
            ` next retry will replay full input on a fresh connection`,
        );
      }
      if (streamCompletedWithoutError) clearCfChallengeCooldown(currentEntryId);
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
