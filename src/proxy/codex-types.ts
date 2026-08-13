/**
 * Type definitions for the Codex Responses API.
 * Extracted from codex-api.ts for consumers that only need types.
 */

export interface CodexResponsesRequest {
  model: string;
  instructions?: string | null;
  input: CodexInputItem[];
  stream: true;
  store: false;
  /** Optional: reasoning effort + summary mode */
  reasoning?: { effort?: string; summary?: string };
  /** Optional: service tier ("fast" / "flex") */
  service_tier?: string | null;
  /** Optional: tools available to the model */
  tools?: unknown[];
  /** Optional: tool choice strategy */
  tool_choice?: string | { type: string; name?: string };
  /** Optional: allow multiple tool calls in parallel. */
  parallel_tool_calls?: boolean;
  /** Optional: text output format (JSON mode / structured outputs) */
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  /** Optional: reference a previous response for multi-turn (WebSocket only). */
  previous_response_id?: string;
  /** Prompt cache key — stable per-conversation UUID for backend prompt caching. */
  prompt_cache_key?: string;
  /** Per-installation routing/affinity hints (e.g. x-codex-installation-id).
   *  Real Codex CLI sends this in every body so the upstream LB can pin the
   *  client to a single backend instance, keeping the prompt cache warm. */
  client_metadata?: Record<string, string>;
  /** Include additional response data (e.g. "reasoning.encrypted_content"). */
  include?: string[];
  /** When true, use WebSocket transport (enables previous_response_id and server-side storage). */
  useWebSocket?: boolean;
  /** Upstream turn-state token for sticky routing (not serialized to body). */
  turnState?: string;
  /** Codex per-turn metadata JSON, forwarded as a header and WS client_metadata. */
  turnMetadata?: string;
  /** Optional Codex beta feature header. */
  betaFeatures?: string;
  /** Optional Codex client version header. */
  version?: string;
  /** Optional timing metrics opt-in header. */
  includeTimingMetrics?: string;
  /** Codex thread window identity, forwarded as a header and WS client_metadata. */
  codexWindowId?: string;
  /** Parent Codex thread id for subagent lineage. */
  parentThreadId?: string;
}

/**
 * Request body for POST /codex/responses/compact (non-streaming JSON).
 * Matches codex-rs CompactionInput — no stream/store fields.
 */
export interface CodexCompactRequest {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  tools?: unknown[];
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  service_tier?: string | null;
  prompt_cache_key?: string;
  client_metadata?: Record<string, string>;
  turnState?: string;
  turnMetadata?: string;
  betaFeatures?: string;
  version?: string;
  includeTimingMetrics?: string;
  codexWindowId?: string;
  parentThreadId?: string;
}

/**
 * Response body from POST /codex/responses/compact.
 *
 * The raw upstream body also carries `usage` (top-level, not nested under a
 * `response` wrapper like the streaming SSE events) — same shape as the
 * streaming path's `response.usage`. `createCompactResponse` (`codex-api.ts`)
 * parses it via `parseNormalizedHostModelUsage` (`codex-events.ts`) before
 * handing this object back, so `usage` here is already the flattened shape
 * (`input_tokens`/`output_tokens`/`cached_tokens?`/`reasoning_tokens?`), not
 * upstream's raw nested `input_tokens_details`/`output_tokens_details`.
 * Optional because callers must treat "upstream omitted it" as unknown, not
 * silently record zero usage for a real compact call.
 */
export interface CodexCompactResponse {
  output: unknown[];
  /**
   * 产出这份 `output` 的协议版本，供 `/v1/responses/compact` 的**外部**调用方
   * 判别形状——两个版本的 `output` 语义不同，而端点、字段名、类型都没变，
   * 没有这个字段的话客户端无从分辨，也不会有任何地方报错：
   *
   * - `"v1"`：上游返回的压缩后 transcript（reasoning / assistant item 等）
   * - `"v2"`：proxy 自己装配的 `[...保留的 user 消息, {type:"compaction"}]`
   *
   * 为什么必须能判别：新版 codex 的 `should_keep_compacted_history_item` 对
   * Compaction 变体是 `=> true`（保留），但**早于该变体的旧客户端**会把
   * `{type:"compaction"}` 反序列化成 `Other`，被同一个 filter 丢掉——整段
   * 历史静默消失。旧客户端可以据此判断，再配合 `model.compact_protocol: "v1"`
   * 钉死到自己能处理的形状。
   *
   * ★ 和配置键 `model.compact_protocol` 是两个东西，名字只差一个 "ion"，
   * **刻意不统一**：本字段是**输出**（这份 output 产出自哪个协议），跟官方
   * codex 协议术语一致（item type 就叫 `compaction`）；那个是**输入**（要用
   * 哪个协议），跟配置侧既有命名一致（`claude_code_compact_bridge` 等一律用
   * `compact`）。详见 `config-schema.ts` 里 `compact_protocol` 的注释。
   */
  compaction_protocol: "v1" | "v2";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
}

/** Structured content part for multimodal Codex input. */
export type CodexContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type CodexInputItem =
  | { role: "user"; content: string | CodexContentPart[] }
  | { role: "assistant"; content: string | CodexContentPart[] }
  // system/developer roles accept structured content so the user system prompt
  // can be delivered as an inline input item (system_prompt_strategy).
  | { role: "system" | "developer"; content: string | CodexContentPart[] }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  /** Remote compaction v2 request sentinel, sent as the final /responses input item. */
  | { type: "compaction_trigger" }
  /** Opaque remote compaction result, valid as input on the next turn. */
  | {
      type: "compaction";
      id?: string;
      encrypted_content: string;
      internal_chat_message_metadata_passthrough?: unknown;
    };

/** Parsed SSE event from the Codex Responses stream */
export interface CodexSSEEvent {
  event: string;
  data: unknown;
}

/** Response from GET /backend-api/codex/usage */
export interface CodexUsageRateWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface CodexUsageRateLimit {
  allowed: boolean;
  limit_reached: boolean;
  primary_window: CodexUsageRateWindow | null;
  secondary_window: CodexUsageRateWindow | null;
}

export interface CodexUsageAdditionalRateLimit {
  limit_name: string;
  metered_feature: string;
  rate_limit: CodexUsageRateLimit | null;
}

/** Credit accounting block from /backend-api/codex/usage.
 *  Populated for Pro / Pay-As-You-Go accounts; for Plus accounts the
 *  block is present but has_credits=false and balance="0". */
export interface CodexUsageCredits {
  has_credits: boolean;
  unlimited: boolean;
  overage_limit_reached: boolean;
  /** Decimal string. Upstream returns "0", "12.345", etc. */
  balance: string;
  /** Approximate remaining messages, tuple of [low, high]. */
  approx_local_messages?: [number, number];
  approx_cloud_messages?: [number, number];
}

/** Per-account spend control (if user set a hard limit). */
export interface CodexUsageSpendControl {
  reached: boolean;
  individual_limit: number | string | null;
}

/** Diagnostic about which limit type was hit when limit_reached=true. */
export interface CodexUsageRateLimitReachedType {
  type: string;
  details: string | null;
}

export interface CodexUsageResponse {
  plan_type: string;
  rate_limit: CodexUsageRateLimit;
  code_review_rate_limit: CodexUsageRateLimit | null;
  additional_rate_limits?: CodexUsageAdditionalRateLimit[] | null;
  credits?: CodexUsageCredits | null;
  spend_control?: CodexUsageSpendControl | null;
  rate_limit_reached_type?: CodexUsageRateLimitReachedType | null;
  promo?: unknown;
}

export class CodexApiError extends Error {
  /**
   * 「重试也不会有不同结果」的显式标记，默认 `undefined`（= 沿用
   * `withRetry` 按 status 判定的老行为，不改变任何既有调用方）。
   *
   * 为什么需要它：`withRetry` 只看 status 段（5xx 可重试），这在「上游/传输
   * 真的抖了」时是对的，但**协议违例**（上游按 200 正常返回、内容却不符合
   * 约定，比如 compaction item 数量不对、stream 没到 completed 就断）同样
   * 被表达成 502，于是一次语义错误会被放大成 3 次完整的付费 compact。
   *
   * 判据是「重放这次请求有没有可能得到不同结果」，不是「错误码是几」——
   * 所以标记打在**产生错误的那一处**（它才知道自己遇到的是抖动还是违例），
   * 而不是在 `withRetry` 里堆 status/文案的特例分支。新增一种不可重试的
   * 失败时只需在抛出处带上这个标记，重试逻辑本身不用动。
   */
  readonly retryable?: boolean;

  constructor(
    public readonly status: number,
    public readonly body: string,
    options?: { retryable?: boolean },
  ) {
    let detail: string;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const raw = obj.detail ?? (obj.error as Record<string, unknown> | undefined)?.message ?? body;
        detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      } else {
        detail = body;
      }
    } catch {
      detail = body;
    }
    super(`Codex API error (${status}): ${detail}`);
    this.retryable = options?.retryable;
  }
}

export type WebSocketFailurePhase = "pre-connect" | "mid-stream" | "unknown";

/** previous_response_id 只能通过 WebSocket 安全续链，失败后不能降级为 HTTP delta-only。 */
export class PreviousResponseWebSocketError extends CodexApiError {
  public readonly phase: WebSocketFailurePhase;
  public readonly recoverable: boolean;

  constructor(
    public readonly causeMessage: string,
    opts: { phase?: WebSocketFailurePhase; recoverable?: boolean } = {},
  ) {
    super(
      0,
      JSON.stringify({
        error: {
          message:
            "WebSocket failed while using previous_response_id; HTTP SSE fallback would drop server-side history: " +
            causeMessage,
        },
      }),
    );
    this.name = "PreviousResponseWebSocketError";
    this.phase = opts.phase ?? "unknown";
    this.recoverable = opts.recoverable ?? false;
  }
}
