/**
 * Structured logging for stream-close events.
 *
 * Premature stream close (upstream-side) and client abort (downstream-side) are
 * recurring failure modes that previously left only an ad-hoc `console.warn`
 * trail in the dev tee log. This helper persists every close event through
 * both observability channels:
 *
 *   - `appendErrorLog` → `data/error-log.jsonl` → Errors tab + unread badge
 *   - `enqueueLogEntry` → in-memory audit log (admin /api/logs)
 *
 * Same context shape for both so the dashboard and the audit feed can be
 * cross-referenced by rid + ts when diagnosing a recurrence.
 */

import { appendErrorLog } from "./error-log.js";
import { enqueueLogEntry } from "./entry.js";
import { sanitizeFreeTextForLog } from "./redact.js";
import { streamCloseErrorName, streamCloseMessage, type StreamCloseKind } from "./stream-close-format.js";
// 复用 8.6 已经建立的哈希（同一份进程级盐）而不是自己再实现一个：账号
// 标识要能跨日志来源关联（同一个账号在 opaque compact 事件和 stream-close
// 事件里应该折叠成同一个短标签），两套哈希互不相同就失去了这个价值。
import { auditAccountTag } from "../routes/shared/opaque-compact-audit.js";

/** Caller-provided diagnostic context that travels with a streaming request.
 *  Optional fields are filled in opportunistically — missing context still
 *  produces a useful Errors-tab entry, callers should pass what they have. */
export interface StreamCloseContextBase {
  requestId?: string | null;
  tag?: string | null;
  provider?: string | null;
  path?: string | null;
  model?: string | null;
  accountEntryId?: string | null;
  variantHash?: string | null;
  responseId?: string | null;
}

export interface StreamCloseEvent extends StreamCloseContextBase {
  kind: StreamCloseKind;
  /** Free-form description from the underlying error (e.g. WS code, EOF msg). */
  detail?: string | null;
  /** WS close code surfaced from `ws-pool` / `ws-transport` when known. */
  closeCode?: number | null;
  /** UpstreamPrematureCloseError carries these — fill them in when available. */
  eventCount?: number | null;
  hadReasoning?: boolean | null;
  /** Stream-write diagnostics from `response-processor` when the client side closed. */
  writtenChunks?: number | null;
  writtenBytes?: number | null;
  lastSentEvent?: string | null;
  sentTerminal?: boolean | null;
  /** CodexApiError.status when the error was a typed upstream error. */
  upstreamStatus?: number | string | null;
}

function prune<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as Array<[keyof T, T[keyof T]]>) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Persist a stream-close event into both the local error log (Errors tab)
 *  and the in-memory audit log. Never throws — logging failures inside the
 *  helpers swallow themselves. */
export function recordStreamCloseEvent(evt: StreamCloseEvent): void {
  const name = streamCloseErrorName(evt.kind);
  // reviewer 发现（本轮排查 Dashboard error-log 展示逻辑时确认）：evt.detail
  // 是"底层错误的自由文本描述"（WS 关闭原因、上游 EOF 消息等，7 个调用点
  // 各自传入各自捕获到的原始异常文本），此前原样拼进 message，而 message
  // 落进 appendErrorLog 的**顶层** error.message——那个字段不经过
  // redactJson（只有 context 会），且 ErrorsPage.tsx 把 group.message 直接
  // 渲染在 Dashboard 上，等于把未脱敏的自由文本原样展示给了任何能打开
  // Dashboard 的人。与本轮 opaque compact fallback 那次判断同一类风险、
  // 同一套处理：先过 sanitizeFreeTextForLog（marker 值级脱敏 + 截断），
  // 只算一次，message 和 context.detail 共用这份结果，不留一条能绕开的路径。
  const sanitizedDetail = evt.detail != null ? sanitizeFreeTextForLog(evt.detail) : evt.detail;
  const message = streamCloseMessage(evt.kind, sanitizedDetail, evt.closeCode);
  const numericStatus =
    typeof evt.upstreamStatus === "number" ? evt.upstreamStatus : null;
  // blocker（reviewer 复审发现）：evt.accountEntryId 是 accounts.json 里的
  // 账号唯一标识（OAuth 账号形如 `codex:auth:<uuid>`），此前原样落进
  // context/request——两者都会被 Dashboard 的通用"展开看原始 JSON"视图
  // （ErrorsPage.tsx 的 ErrorRow、LogsPage.tsx 的选中条目详情）整体
  // JSON.stringify 出来，明文账号 ID 因此直接出现在 UI 上，可以据此定位到
  // 具体账号记录。改成 auditAccountTag（8.6 已经在用的同一个哈希，同一份
  // 进程级盐）——不可逆、同进程内可关联，字段名同步改成 accountHash，
  // 不再叫 accountEntryId，避免让人以为这个字段还是原始 ID。
  const accountHash = evt.accountEntryId != null ? auditAccountTag(evt.accountEntryId) : null;

  appendErrorLog({
    source: "server",
    error: { name, message },
    context: prune({
      kind: evt.kind,
      requestId: evt.requestId,
      tag: evt.tag,
      provider: evt.provider,
      path: evt.path,
      model: evt.model,
      accountHash,
      variantHash: evt.variantHash,
      responseId: evt.responseId,
      eventCount: evt.eventCount,
      hadReasoning: evt.hadReasoning,
      closeCode: evt.closeCode,
      writtenChunks: evt.writtenChunks,
      writtenBytes: evt.writtenBytes,
      lastSentEvent: evt.lastSentEvent,
      sentTerminal: evt.sentTerminal,
      upstreamStatus: evt.upstreamStatus,
      detail: sanitizedDetail,
    }),
  });

  enqueueLogEntry({
    requestId: evt.requestId ?? "stream-close",
    direction: "egress",
    method: "POST",
    path: evt.path ?? "/codex/responses",
    model: evt.model ?? null,
    provider: evt.provider ?? "codex",
    status: numericStatus,
    stream: true,
    error: message,
    request: prune({
      kind: evt.kind,
      tag: evt.tag,
      accountHash,
      variantHash: evt.variantHash,
      responseId: evt.responseId,
      eventCount: evt.eventCount,
      hadReasoning: evt.hadReasoning,
      closeCode: evt.closeCode,
      writtenChunks: evt.writtenChunks,
      writtenBytes: evt.writtenBytes,
      lastSentEvent: evt.lastSentEvent,
      sentTerminal: evt.sentTerminal,
      upstreamStatus: evt.upstreamStatus,
    }),
  });
}
