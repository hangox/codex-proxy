/**
 * 8.6：opaque compact 409 / fail-closed 事件的结构化落盘。
 *
 * 事故复盘（交接文档 6.4）：409 是正常 HTTP 响应，此前从不写入
 * `error-log.jsonl`，事故窗口内因此零条 opaque 相关结构化证据——`malformed`
 * 具体是怎么触发的（截断 vs 前缀污染）永久无法定论。这里把每一次 opaque
 * 409/fail-closed 都记一条，让下一次事故至少有取证起点。
 *
 * 字段白名单靠**函数签名本身**强制，不接受"调用方传什么就落什么"的通用
 * context——那正是让完整 body 落盘的通道。允许的字段只有：
 *   rid、reason、session hash、marker 长度、account hash、generation、
 *   detail（见下方"排查生产事故补的字段"说明，唯一的自由文本例外）。
 *
 * 硬禁止：raw marker 或其任意子串/前缀、payload、account id（原文）、
 * token、cookie。marker 参数只取 `.length`，账号/会话只取
 * {@link auditAccountTag}/{@link auditSessionTag} 派生的不可逆短标签，
 * 调用方即便手滑传了敏感值也拼不出白名单以外的输出字段。
 *
 * ★ 陷阱记录：session hash 字段**不能**叫 `session_hash`——`appendErrorLog`
 * 会把每条 context 再过一遍 `redactJson`（值级第二道防线，见
 * `src/logs/redact.ts`），它的 `SECRET_KEY_RE` 按**子串**匹配任何含
 * "session"/"token"/"secret" 等词的 key 名，命中就整体替换成 `"***"`——
 * 包括本来就该保留、用于运维关联的哈希值，以及 `null`（缺省场景）。
 * 于是叫 `session_hash` 会让这个字段本身失去意义（永远是 `"***"`），
 * 缺省时也读不出 `null`。改名成 `conv_hash`（对应 clientConversationId）
 * 绕开这个子串匹配，同时不改变语义。写新字段名前**务必**用真实值跑一遍
 * `appendErrorLog`，光读 `redact.ts` 源码容易漏掉子串匹配这种隐性坑。
 *
 * ★ 排查生产事故补的字段：`detail`（原始异常文本，来自
 * `OpaqueCompactStateError.detail`，见 `opaque-compact-state.ts`）——
 * 真实事故里一个会话在 49 分钟内撞了 77 次同一个 `store_unavailable`
 * 409，全部只记了分类后的 `reason`，原始异常早已随旧容器一起消失，事后
 * 排查不出根因。**这不是放宽"不接受自由文本"这条纪律**：`reason` 依然
 * 必须是结构化分类值，`detail` 是唯一、显式声明的自由文本例外，写入前
 * 强制过 {@link sanitizeFreeTextForLog}（marker 值级脱敏 + 截断），和
 * `opaque-compact-fallback-log.ts`/`opaque-compact-runtime-fault-log.ts`
 * 对同一类"上游/底层自由文本"字段的处理是同一套判断依据、同一个函数，
 * 不是又发明一遍脱敏逻辑。
 */

import { appendErrorLog } from "../../logs/error-log.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import { auditAccountTag, auditSessionTag } from "./opaque-compact-audit.js";

export interface OpaqueCompactDenialInput {
  requestId: string;
  /**
   * 结构化 reason（`OpaqueCompactStateFailure` 的某个值）或本路由层自定义的
   * 简短机器可读标签（如 "missing_session_context"）。不接受自由文本——
   * 自由文本容易被手滑塞进 marker 片段。
   */
  reason: string;
  clientConversationId: string | null;
  /** 只使用其 `.length`；这个函数绝不会把 marker 原文写进日志。 */
  marker?: string | null;
  accountEntryId?: string | null;
  generation?: number;
  /**
   * 原始异常文本（`OpaqueCompactStateError.detail` / 只读 readiness 的
   * `detail`）。调用方不需要预先脱敏——这个函数内部会在写入 `context`
   * 前统一过 {@link sanitizeFreeTextForLog}。只有 store 级致命故障才会有
   * 这个值（session/model/variant 不匹配这类单请求语义错误没有，`reason`
   * 本身就是完整解释），非 store-fault 场景传 `undefined` 即可，不用
   * 强凑。
   */
  detail?: string | null;
}

/** 记录一次 opaque compact 的 409 / fail-closed 决策。绝不抛出。 */
export function recordOpaqueCompactDenial(input: OpaqueCompactDenialInput): void {
  try {
    appendErrorLog({
      source: "server",
      error: {
        name: "OpaqueCompactDenied",
        message: input.reason,
      },
      context: {
        rid: input.requestId,
        reason: input.reason,
        // 不要叫 session_hash——见文件头"陷阱记录"，会被 redactJson 的
        // SECRET_KEY_RE（子串匹配 "session"）整体吃成 "***"。
        conv_hash: input.clientConversationId !== null && input.clientConversationId !== ""
          ? auditSessionTag(input.clientConversationId)
          : null,
        marker_length: input.marker != null ? input.marker.length : null,
        account_hash: input.accountEntryId != null && input.accountEntryId !== ""
          ? auditAccountTag(input.accountEntryId)
          : null,
        generation: input.generation ?? null,
        detail: input.detail != null ? sanitizeFreeTextForLog(input.detail) : null,
      },
    });
  } catch {
    // 日志失败绝不能影响主流程——appendErrorLog 内部已经兜底，这里再包一层
    // 纯粹是防御性的，避免未来有人在 context 构造里引入会抛错的逻辑。
  }
}
