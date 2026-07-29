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
        error_name: input.errorName,
        error_message: sanitizeFreeTextForLog(input.errorMessage),
      },
    });
  } catch {
    // 日志失败绝不能影响主流程——appendErrorLog 内部已经兜底，这里再包一层
    // 纯粹是防御性的。
  }
}
