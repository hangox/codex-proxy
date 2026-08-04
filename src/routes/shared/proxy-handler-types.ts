import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { ExtractedEvent, UsageInfo } from "../../translation/codex-event-extractor.js";
import type { StreamCloseContextBase } from "../../logs/stream-close-event.js";

export interface StreamTranslatorContext extends StreamCloseContextBase {
  /** Request abort signal so format-specific translators can distinguish a
   *  downstream client abort from a genuine upstream premature close. */
  abortSignal?: AbortSignal;
}

/** Data prepared by each route after parsing and translating the request. */
export interface ProxyRequest {
  codexRequest: CodexResponsesRequest;
  model: string;
  isStreaming: boolean;
  /** Stable client-side conversation/session identifier when the upstream client provides one. */
  clientConversationId?: string;
  /** Hard account binding for in-memory opaque compact state restoration. */
  requiredAccountEntryId?: string;
  /** Original schema before tuple->object conversion (for response reconversion). */
  tupleSchema?: Record<string, unknown> | null;
  /** Whether this is a new conversation (no previous_response_id) — used for cache reporting. */
  isNewConversation?: boolean;
  /** True iff the request declared `tools: [{type: "image_generation"}]`.
   *  Used to attribute success/failure to the image_generation request counters
   *  even when the upstream call fails before the first SSE event arrives. */
  expectsImageGen?: boolean;
}

export interface UsageHint {
  reusedInputTokensUpperBound?: number;
}

export interface ResponseMetadata {
  functionCallIds?: string[];
}

export interface FormatStreamTranslatorOptions {
  api: UpstreamAdapter;
  response: Response | AsyncIterable<ExtractedEvent>;
  model: string;
  onUsage: (u: UsageInfo) => void;
  onResponseId: (id: string) => void;
  onResponseCompleted?: (id?: string) => void;
  tupleSchema?: Record<string, unknown> | null;
  usageHint?: UsageHint;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
  /** Diagnostic context forwarded into adapter-internal premature-close
   *  records (e.g. `streamPassthrough` in responses.ts) so audit entries
   *  carry the real rid / account / variantHash instead of falling back
   *  to the synthetic `"stream-close"` placeholder. */
  streamContext?: StreamTranslatorContext;
}

export interface FormatCollectTranslatorOptions {
  api: UpstreamAdapter;
  response: Response;
  model: string;
  tupleSchema?: Record<string, unknown> | null;
  usageHint?: UsageHint;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
}

export interface FormatCollectTranslatorResult {
  response: unknown;
  usage: UsageInfo;
  responseId: string | null;
}

/** Format-specific adapter provided by each route. */
export interface FormatAdapter {
  tag: string;
  /** ★ #81: status for the two self-heal buckets (concurrency saturated /
   *  quota window) — a request-eligible client SDK is expected to
   *  auto-retry this. Must stay on the client's retry whitelist (529 for
   *  Anthropic mirrors its real overloaded_error; 503 elsewhere). Body is
   *  built via `formatError` (see below), same as every other bucket —
   *  there used to be a dedicated `formatNoAccount` formatter here, removed
   *  because after #81 nothing calls it with a fixed argument-less message
   *  anymore; every bucket's message now depends on the diagnosis. */
  noAccountStatus: StatusCode;
  /** ★ #81: status for the "needs human" bucket (expired/banned/disabled,
   *  or no accounts at all) — retrying will not help, so this MUST NOT be
   *  on the client SDK's retry whitelist. See respondWithNoAccount's doc
   *  comment for the full rationale and the one narrow exception (Claude
   *  Code 2.1.220 retries 403 when the message contains the literal string
   *  "OAuth token has been revoked" — irrelevant here since our message
   *  never uses that phrase, but worth knowing if this status is ever
   *  reused for something else). Body is built via `formatError`, not a
   *  dedicated formatter — deliberately reuses the same function real
   *  ordinary errors use, so it does NOT get `formatNoAccount`'s
   *  retry-friendly body type (e.g. Anthropic's `overloaded_error`).
   */
  needsHumanStatus: StatusCode;
  format429: (message: string) => unknown;
  formatError: (status: number, message: string) => unknown;
  formatStreamError?: (status: number, message: string) => string;
  streamTranslator: (options: FormatStreamTranslatorOptions) => AsyncGenerator<string>;
  collectTranslator: (options: FormatCollectTranslatorOptions) => Promise<FormatCollectTranslatorResult>;
}

export interface HandleProxyRequestOptions {
  c: Context;
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  req: ProxyRequest;
  fmt: FormatAdapter;
  proxyPool?: ProxyPool;
}

export interface HandleDirectRequestOptions {
  c: Context;
  upstream: UpstreamAdapter;
  req: ProxyRequest;
  fmt: FormatAdapter;
}
