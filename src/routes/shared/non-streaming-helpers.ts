import type { StatusCode } from "hono/utils/http-status";
import type { ChainAdvanceTicket, SessionAffinityMap } from "../../auth/session-affinity.js";
import type { AccountPool } from "../../auth/account-pool.js";
import { clearCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import type {
  FormatAdapter,
  FormatCollectTranslatorResult,
  ProxyRequest,
  ResponseMetadata,
  UsageHint,
} from "./proxy-handler-types.js";
import { releaseAccount } from "./account-acquisition.js";
import { toErrorStatus } from "./proxy-error-handler.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";
import { createResponseMetadataCollector } from "./response-metadata-collector.js";
import { logProxyUsage } from "./proxy-usage-log.js";
import type { ReasoningReplayItem } from "../../proxy/reasoning-replay-cache.js";

export {
  rethrowNonStreamingCodexApiErrorDuringCollect,
  type RethrowNonStreamingCodexApiErrorDuringCollectOptions,
} from "./non-streaming-codex-api-error.js";
export {
  handleNonStreamingEmptyResponseExhausted,
  type HandleNonStreamingEmptyResponseExhaustedOptions,
  type NonStreamingEmptyResponseExhaustedResponsePlan,
} from "./non-streaming-empty-response-exhausted.js";
export {
  retryNonStreamingEmptyResponse,
  type RetryNonStreamingEmptyResponseOptions,
  type NonStreamingEmptyResponseRetryResult,
} from "./non-streaming-empty-response-retry.js";
export {
  handleNonStreamingPrematureClose,
  type HandleNonStreamingPrematureCloseOptions,
  type NonStreamingPrematureCloseResponsePlan,
} from "./non-streaming-premature-close.js";

// ── 1. non-streaming-affinity ─────────────────────────────────────
export interface RecordNonStreamingSuccessAffinityOptions {
  affinityMap?: SessionAffinityMap;
  responseId: string | null;
  entryId: string;
  conversationId?: string | null;
  turnState?: string;
  instructions?: string | null;
  inputTokens: number;
  responseFunctionCallIds: Iterable<string>;
  variantHash?: string;
  chainAdvanceTicket?: ChainAdvanceTicket;
}

export function recordNonStreamingSuccessAffinity(
  options: RecordNonStreamingSuccessAffinityOptions,
): boolean {
  const {
    affinityMap,
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions,
    inputTokens,
    responseFunctionCallIds,
    variantHash,
    chainAdvanceTicket,
  } = options;

  if (!responseId || !affinityMap || !conversationId) return false;

  affinityMap.record(
    responseId,
    entryId,
    conversationId,
    turnState,
    instructions,
    inputTokens,
    Array.from(new Set(responseFunctionCallIds)),
    variantHash,
    chainAdvanceTicket,
  );
  return true;
}


// ── 3. non-streaming-collect-error-response ───────────────────────
export interface NonStreamingCollectErrorResponsePlan {
  status: StatusCode;
  message: string;
}

export function planNonStreamingCollectErrorResponse(
  collectErr: unknown,
): NonStreamingCollectErrorResponsePlan {
  const message = collectErr instanceof Error ? collectErr.message : "Unknown error";
  const statusMatch = message.match(/HTTP\/[\d.]+ (\d{3})/);
  const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  return {
    status: toErrorStatus(upstreamStatus),
    message,
  };
}

// ── 4. non-streaming-collect-failure ──────────────────────────────
export interface HandleNonStreamingCollectFailureOptions {
  accountPool: AccountPool;
  entryId: string;
  req: ProxyRequest;
  collectErr: unknown;
  released: Set<string>;
}

export function handleNonStreamingCollectFailure(
  options: HandleNonStreamingCollectFailureOptions,
): NonStreamingCollectErrorResponsePlan {
  const {
    accountPool,
    entryId,
    req,
    collectErr,
    released,
  } = options;

  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
  return planNonStreamingCollectErrorResponse(collectErr);
}

// ── 5. non-streaming-collect-response ─────────────────────────────
export interface CollectNonStreamingResponseOptions {
  fmt: FormatAdapter;
  api: CodexApi;
  rawResponse: Response;
  req: ProxyRequest;
  usageHint?: UsageHint;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
}

export interface CollectNonStreamingResponseResult {
  result: FormatCollectTranslatorResult;
  responseFunctionCallIds: Set<string>;
  reasoningReplayItems: ReasoningReplayItem[];
  invalidReasoningReplay: boolean;
}

export async function collectNonStreamingResponse(
  options: CollectNonStreamingResponseOptions,
): Promise<CollectNonStreamingResponseResult> {
  const {
    fmt,
    api,
    rawResponse,
    req,
    usageHint,
    onResponseMetadata,
  } = options;
  const metadataCollector = createResponseMetadataCollector();
  const result = await fmt.collectTranslator({
    api,
    response: rawResponse,
    model: req.model,
    tupleSchema: req.tupleSchema,
    usageHint,
    onResponseMetadata: (metadata) => {
      metadataCollector.onResponseMetadata(metadata);
      onResponseMetadata?.(metadata);
    },
  });

  return {
    result,
    responseFunctionCallIds: metadataCollector.responseFunctionCallIds,
    reasoningReplayItems: metadataCollector.reasoningReplayItems,
    invalidReasoningReplay: metadataCollector.invalidReasoningReplay,
  };
}


// ── 9. non-streaming-success-release ─────────────────────────────
export interface ReleaseNonStreamingSuccessAccountOptions {
  accountPool: AccountPool;
  entryId: string;
  usage: UsageInfo;
  expectsImageGen?: boolean;
  released: Set<string>;
}

export function releaseNonStreamingSuccessAccount(options: ReleaseNonStreamingSuccessAccountOptions): void {
  const {
    accountPool,
    entryId,
    usage,
    expectsImageGen,
    released,
  } = options;

  clearCfChallengeCooldown(entryId);
  releaseAccount(accountPool, entryId, annotateImageGenOutcome(usage, expectsImageGen), released);
}

// ── 10. non-streaming-usage-log ──────────────────────────────────
export interface LogNonStreamingUsageOptions {
  tag: string;
  entryId: string;
  requestId: string;
  usage: UsageInfo;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function logNonStreamingUsage(options: LogNonStreamingUsageOptions): void {
  logProxyUsage(options);
}
