import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { ExtractedEvent, UsageInfo } from "../../translation/codex-event-extractor.js";
import type { StreamCloseContextBase } from "../../logs/stream-close-event.js";
import type { ReasoningReplayItem } from "../../proxy/reasoning-replay-cache.js";

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
  /**
   * ★ #108/#111：只在 opaque compact 失败降级、正在用普通生成端点重试
   * 同一个 compact 请求时才会被设置（`messages.ts` 的
   * `compactFallbackOccurred` 分支）。存在时，`proxy-handler.ts`/
   * `streaming-handler.ts` 里这次请求的每一个终止点都会调用一次
   * `compact-outcome-log.ts` 的 `recordCompactFallbackRenderOutcome`，
   * 把降级后这次压缩自己的真实成败（不是"提交了"）记进
   * `compact-outcome-log.jsonl`（`compact_path: "fallback_render"`）——
   * 见该函数的完整文档，那里解释了为什么"流式响应 `res.status` 不可靠"
   * 不等于"这条调用链拿不到真实结果"。
   *
   * `requestId` 对应 `compact-outcome-log.ts` 里同一个 `rid`（跟同一次
   * 请求的 `fallback_decision` 那一行共享，方便按 rid 关联查询）；
   * `startedAt` 是耗时计算的起点——**是"降级决定那一刻"**
   * （`messages.ts` 的 `fallbackDecidedAt`，紧跟在 `compactFallbackOccurred = true`
   * 后面捕获），**不是**整个 HTTP 请求进来的那一刻（`requestStartedAt`）。
   * 两者刻意分开：如果用 `requestStartedAt`，opaque 尝试自己失败花的时间
   * 会被重复计进 render 的 `duration_ms`——多数时候 opaque 失败很快可以
   * 忽略，但如果 opaque 是被上游拖到超时才失败（数十秒量级），render 的
   * 耗时会严重失真，而这正是最需要看清"降级之后到底花了多久"的场景
   * （用户会把 opaque 那条和 render 那条并排对比，两条不能重叠计时）。
   */
  compactFallbackRender?: { requestId: string; startedAt: number };
}

export interface UsageHint {
  reusedInputTokensUpperBound?: number;
}

export interface ResponseMetadata {
  functionCallIds?: string[];
  reasoningReplayItems?: ReasoningReplayItem[];
  invalidReasoningReplay?: boolean;
  /** The upstream stream ended before a terminal event (response.completed /
   *  response.failed) without a classifiable error. When implicit resume was
   *  active, the `previous_response_id` chain for this conversation must be
   *  treated as poisoned — the client's retry would otherwise replay the same
   *  stale prev id into the same silent failure. */
  prematureClose?: boolean;
  /** The upstream stream ended with a terminal failure frame (`error` /
   *  `response.failed`) instead of `response.completed`. Tracked separately
   *  from `prematureClose` for diagnostics; both poison an implicit-resume
   *  chain the same way. */
  terminalFailure?: boolean;
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
