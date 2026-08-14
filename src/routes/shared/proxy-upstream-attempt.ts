import type { WsPoolContext } from "../../proxy/codex-api.js";
import type { CodexResponsesRequest } from "../../proxy/codex-types.js";
import type { ParsedRateLimit } from "../../proxy/rate-limit-headers.js";
import { withRetry } from "../../utils/retry.js";
import { dumpProxyRequest } from "./proxy-debug-dump.js";
import { recordProxyEgressLog } from "./proxy-egress-log.js";
import {
  markCompactFallbackUpstreamEnd,
  markCompactFallbackUpstreamStart,
} from "./compact-outcome-log.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import {
  applyParsedRateLimits,
  applyRateLimitHeaders,
  type RateLimitAccountPool,
} from "./proxy-rate-limit.js";

export interface ProxyUpstreamAttemptApi {
  createResponse(
    request: CodexResponsesRequest,
    signal: AbortSignal,
    onRateLimits?: (rateLimits: ParsedRateLimit) => void,
    poolCtx?: WsPoolContext,
  ): Promise<Response>;
}

export interface SendProxyUpstreamAttemptOptions {
  accountPool: RateLimitAccountPool;
  api: ProxyUpstreamAttemptApi;
  request: ProxyRequest;
  entryId: string;
  abortSignal: AbortSignal;
  buildPoolCtx: () => WsPoolContext | undefined;
  requestId: string;
  tag: string;
  conversationId: string | null | undefined;
  implicitResumeActive: boolean;
  resumeReason: string | null | undefined;
  nowMs?: () => number;
  retryOptions?: {
    maxRetries?: number;
    baseDelayMs?: number;
  };
}

export interface ProxyUpstreamAttemptResult {
  rawResponse: Response;
  upstreamTurnState: string | undefined;
}

export async function sendProxyUpstreamAttempt(
  options: SendProxyUpstreamAttemptOptions,
): Promise<ProxyUpstreamAttemptResult> {
  const {
    accountPool,
    api,
    request,
    entryId,
    abortSignal,
    buildPoolCtx,
    requestId,
    tag,
    conversationId,
    implicitResumeActive,
    resumeReason,
    retryOptions,
  } = options;
  const nowMs = options.nowMs ?? Date.now;

  const applyRateLimits = (rateLimits: ParsedRateLimit): void => {
    applyParsedRateLimits({ accountPool, entryId, rateLimits });
  };

  const startMs = nowMs();
  // Opaque compact restoration injects sensitive encrypted state into input.
  // Never send that payload to the opt-in debug dump channel.
  if (request.requiredAccountEntryId === undefined) {
    dumpProxyRequest({
      requestId,
      tag,
      entryId,
      conversationId,
      implicitResumeActive,
      resumeReason,
      payload: request.codexRequest,
    });
  }
  const rawResponse = await withRetry(
    async () => {
      // 只计真正发起普通生成上游请求的区间；withRetry 的本地退避不属于
      // fallback_render 的实际压缩耗时，失败尝试在这里先封口。
      markCompactFallbackUpstreamStart(request);
      try {
        return await api.createResponse(request.codexRequest, abortSignal, applyRateLimits, buildPoolCtx());
      } catch (error) {
        markCompactFallbackUpstreamEnd(request);
        throw error;
      }
    },
    { tag, ...retryOptions },
  );
  recordProxyEgressLog({
    requestId,
    request,
    status: rawResponse.status,
    startMs,
  });
  applyRateLimitHeaders({ accountPool, entryId, headers: rawResponse.headers });

  return {
    rawResponse,
    upstreamTurnState: rawResponse.headers.get("x-codex-turn-state") ?? undefined,
  };
}
