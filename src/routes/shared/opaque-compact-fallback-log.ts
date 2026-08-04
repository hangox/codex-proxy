/**
 * root compact 静默降级为普通生成事件的结构化落盘。
 *
 * 背景：生产数据显示 root compact（`opaqueRestore.restored === false`，即
 * 会话第一次 compact，不是恢复已绑定账号的重新 compact）尝试有 19%
 * （16 例观测中的 3 例）在 `respondWithOpaqueCompactMarker` 抛错后，既不是
 * store 级故障（`reportOpaqueCompactStoreFault` 返回 null），也不满足
 * `opaqueRestore.restored`（因此不会走 409 分支）——`messages.ts` 的
 * `catch` 块此时直接跌出 `if`，请求原样继续走后面的普通生成路径。这是
 * 刻意保留的行为（保证请求本身仍然成功），但此前唯一的痕迹是一行
 * `console.warn`，且只打印固定不变的 `error.name`
 * （`CompactServiceError`），对诊断"为什么 compact 失败"没有任何信息量。
 *
 * 这个函数只做补充可观测性，不改变上面描述的 fallback 行为本身——是否
 * 要修复 19% 静默降级是另一件事，要等有了这里落盘的 `error_message`
 * 数据才能决策。
 *
 * 为什么不复用 `recordOpaqueCompactDenial`（8.6）而是新开一个函数：
 * 1. 语义不同。`recordOpaqueCompactDenial` 文档明确是"409 / fail-closed
 *    决策"——请求被拒绝。这里的事件请求仍然以 200 成功（只是降级成全量
 *    生成），是完全不同的结果类别，用同一个"denial"名字描述会误导后续
 *    读代码/查日志的人。
 * 2. 白名单设计冲突。`recordOpaqueCompactDenial` 的文档明确写着"不接受
 *    自由文本——自由文本容易被手滑塞进 marker 片段"，`reason` 字段被
 *    强制成结构化分类值。而这次要记录的核心信息恰恰是上游返回的自由文本
 *    错误消息（`CompactServiceError.message`）——把自由文本塞进一个明确
 *    设计成"拒绝自由文本"的函数，是在破坏它本来的不变式，而不是复用它。
 * 与此同时确实沿用了同一份基础设施（`appendErrorLog` + 账号/会话哈希
 * helper），把"字段白名单靠函数签名强制"这条纪律原样搬过来，只是给了
 * 一个新的、语义准确的收口点。
 *
 * error_message 敏感性判断（见 messages.ts 调用处引用的完整链路）：
 * `CompactServiceError.message` 最终来自 `CodexApiError.message`，即
 * `Codex API error (${status}): ${detail}`，`detail` 取自上游 HTTP 错误
 * body 的 `.detail`/`.error.message`，JSON 解析失败时退化为整段原始
 * body。这是上游服务自己对失败原因的分类描述，不是设计上会携带用户
 * prompt 内容的字段——但也没有任何代码保证过这一点（解析失败时的兜底
 * 分支会把整段原始 body 当作 detail）。更直接的证据：`proxy-error-handler.ts`
 * 的 `handleCodexApiError` 早就有一个 `safeLog` 参数，`executeCompactOnly`
 * 调用时传的就是 `true`——专门用来把 `err.message` 从相邻的
 * `console.error` 里隐藏掉，注释写的原因正是"opaque compact 等受隐私
 * 合同约束的调用方"。这说明团队此前已经对同一来源的内容做过一次"不完全
 * 信任"的判断。因此这里不直接落盘原文：`error_message` 必须先过
 * {@link sanitizeFreeTextForLog}（marker 值级脱敏 + 截断），且只放进
 * `context`（会再过一遍 `appendErrorLog` 内部的 `redactJson`），绝不放进
 * 顶层 `error.message`——顶层 `error.message` 不经过 `redactJson`，参见
 * `error-log.ts` 的 `appendErrorLog` 实现。
 *
 * ★ 陷阱记录（沿用 opaque-compact-denial-log.ts 同一条踩坑经验）：字段名
 * 一律不能含 "session"/"token"/"secret" 等 `SECRET_KEY_RE` 子串，否则会被
 * `redactJson` 整体替换成 `"***"`。这里的 `conv_hash`/`account_hash` 命名
 * 直接照抄 8.6 的既有约定。
 */

import { appendErrorLog } from "../../logs/error-log.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import { auditAccountTag, auditSessionTag } from "./opaque-compact-audit.js";
import { recordCompactOutcome } from "./compact-outcome-log.js";

export interface OpaqueCompactFallbackInput {
  requestId: string;
  model: string;
  /** compact 请求的 input 条目数，粗略反映会话规模。 */
  inputItems: number;
  clientConversationId: string | null;
  accountEntryId?: string | null;
  generation?: number;
  /** `error.name`——目前恒为 `"CompactServiceError"`，仍然记录以备将来出现其他类型。 */
  errorName: string;
  /**
   * `error.message` 原文。调用方不需要预先脱敏——这个函数内部会在写入
   * `context` 前统一过 {@link sanitizeFreeTextForLog}。
   */
  errorMessage: string;
  /**
   * `CompactServiceError.retryCount`——这次失败之前一共拿过多少个不同
   * 账号（含最终失败的这一个）。纯计数，不含任何账号标识，用来区分"账号池
   * 太小一次就放弃"和"轮了好几个账号都不行"。非 `CompactServiceError`
   * 的错误没有这个字段，传 `undefined` 即可。
   */
  retryCount?: number;
  /**
   * ★ 8.10：`CompactServiceError` 的结构化分类字段（见
   * `codex-compact-service.ts`），Dashboard 快速压缩成功率统计要用它区分
   * `budget_exceeded`（预算预判提前拦下，`skippedUpstream:true`）和
   * `upstream_failed`（真打了上游被拒）。非 `CompactServiceError` 的错误
   * 没有这个字段，传 `undefined` 即可——此时按 `upstream_failed` 处理
   * （保守假设：既然不是我们自己的预判判断，就当作真的联系过上游）。
   */
  classification?: {
    skippedUpstream?: boolean;
    estimatedTokens?: number;
    budgetTokens?: number;
    /**
     * ★ #97（team-lead 派发，reviewer 交叉审查 #96 时发现的观测缺口）：
     * `CompactServiceError.estimateSource`——见该字段在
     * `CompactServiceErrorClassification` 的完整文档。只对
     * `budget_exceeded`（`skippedUpstream:true`）有意义。
     */
    estimateSource?: "cheap" | "precise" | "precise_extrapolated";
    /** ★ #97：`CompactServiceError.processedFraction`，见同名字段文档。 */
    processedFraction?: number;
    /** ★ #97：`CompactServiceError.cheapEstimateTokens`，见同名字段文档。 */
    cheapEstimateTokens?: number;
    /**
     * ★ #88：`CompactServiceError.durationMs`——见
     * `compact-outcome-log.ts` 的 `CompactOutcomeEvent.duration_ms` 文档。
     * 非 `CompactServiceError` 的错误没有这个字段，传 `undefined` 即可，
     * 不强凑。
     */
    durationMs?: number;
    /** ★ #88：`CompactServiceError.upstreamMs`，见同名字段文档。 */
    upstreamMs?: number;
    /**
     * ★ #115：`CompactServiceError.hasImage`——见
     * `codex-compact-service.ts` 的 `CompactBudgetPlan.hasImage` 完整文档。
     * 只对 `budget_exceeded`（`skippedUpstream:true`）有意义。
     */
    hasImage?: boolean;
    /** ★ #115：`CompactServiceError.imageBytes`，见同名字段文档。 */
    imageBytes?: number;
    /** ★ #115：`CompactServiceError.textBytes`，见同名字段文档。 */
    textBytes?: number;
  };
}

/** 记录一次 root compact 静默降级为普通生成的事件。绝不抛出。 */
export function recordOpaqueCompactFallback(input: OpaqueCompactFallbackInput): void {
  try {
    appendErrorLog({
      source: "server",
      error: {
        name: "OpaqueCompactFallback",
        // 顶层 error.message 不经过 redactJson，因此这里只放固定/受控的
        // 分类字符串，不放上游自由文本——自由文本只出现在下面的 context 里。
        message: input.errorName,
      },
      context: {
        rid: input.requestId,
        model: input.model,
        input_items: input.inputItems,
        // 不要叫 session_hash——会被 redactJson 的 SECRET_KEY_RE 子串匹配
        // 整体吃成 "***"，见文件头引用的 8.6 陷阱记录。
        conv_hash: input.clientConversationId != null && input.clientConversationId !== ""
          ? auditSessionTag(input.clientConversationId)
          : null,
        account_hash: input.accountEntryId != null && input.accountEntryId !== ""
          ? auditAccountTag(input.accountEntryId)
          : null,
        generation: input.generation ?? null,
        retry_count: input.retryCount ?? null,
        error_name: input.errorName,
        error_message: sanitizeFreeTextForLog(input.errorMessage),
      },
    });
  } catch {
    // 日志失败绝不能影响主流程——appendErrorLog 内部已经兜底，这里再包一层
    // 纯粹是防御性的。
  }

  // ★ 8.10：Dashboard 快速压缩成功率统计——独立文件，独立于上面的
  // error-log.jsonl 落盘，见 compact-outcome-log.ts 头部注释。
  recordCompactOutcome({
    requestId: input.requestId,
    clientConversationId: input.clientConversationId,
    model: input.model,
    outcome: input.classification?.skippedUpstream ? "budget_exceeded" : "upstream_failed",
    estimatedTokens: input.classification?.estimatedTokens,
    budgetTokens: input.classification?.budgetTokens,
    // ★ #97：三件套原样透传——只对 budget_exceeded 有意义，upstream_failed
    // 场景 input.classification?.estimateSource 等本来就是 undefined。
    estimateSource: input.classification?.estimateSource,
    processedFraction: input.classification?.processedFraction,
    cheapEstimateTokens: input.classification?.cheapEstimateTokens,
    // ★ #115：内容画像三件套，同样原样透传——只对 budget_exceeded 有意义，
    // upstream_failed 场景 input.classification?.hasImage 等本来就是
    // undefined。
    hasImage: input.classification?.hasImage,
    imageBytes: input.classification?.imageBytes,
    textBytes: input.classification?.textBytes,
    reason: input.errorName,
    durationMs: input.classification?.durationMs,
    upstreamMs: input.classification?.upstreamMs,
    // ★ #108：这条记的是"opaque 尝试为什么失败、触发了降级"，不是降级之后
    // 那次真实压缩自己的结果（那条另有独立的写入点，见
    // compact-outcome-log.ts 的 CompactPath 文档、messages.ts 的
    // finalizeCompactFallbackResponse）。
    compactPath: "fallback_decision",
  });
}
