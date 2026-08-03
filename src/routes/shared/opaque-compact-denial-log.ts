/**
 * 8.6：opaque compact 409 / fail-closed 事件的结构化落盘。
 *
 * 事故复盘（交接文档 6.4）：409 是正常 HTTP 响应，此前从不写入
 * `error-log.jsonl`，事故窗口内因此零条 opaque 相关结构化证据——`malformed`
 * 具体是怎么触发的（截断 vs 前缀污染）永久无法定论。这里把每一次 opaque
 * 409/fail-closed 都记一条，让下一次事故至少有取证起点。
 *
 * ★ #96：8.6 那会儿这里恒为 409——`#91` 之后族 A（自愈候选撞在非 compact
 * 请求上）改成了 400，这个函数现在记录的是"fail-closed 决策"，不再是单纯
 * "409 决策"，调用方必须传 `httpStatus`（见下方字段文档）。
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
import { recordCompactOutcome } from "./compact-outcome-log.js";
import type { RecompactFailureCause } from "./codex-compact-service.js";
import type { OpaqueCompactStateFailure } from "./opaque-compact-state.js";

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
  /**
   * ★ 8.10：请求声明的原始 model（`req.model`，未必已解析成
   * `displayModel`——两处最早的调用点发生在模型解析之前）。仅供 Dashboard
   * 快速压缩成功率统计的 `denied` 分类使用，不影响这个函数原有的 fail-closed
   * 决策/日志行为。缺省时用 `"unknown"`，不强行等调用方拿到 displayModel
   * 才能记录（fail-closed 决策本身不能因为这个可选统计字段被推迟）。
   */
  model?: string;
  /**
   * ★ #83：`reason` 之外的失败子因，专门给 `recompact_failed_original_account`
   * 这个聚合桶补细粒度（其它 reason 已经是完整分类，通常不需要再传这个）。
   * 跟 `reason` 同一条纪律——**只能是结构化 enum 值**（`RecompactFailureCause`
   * 或 `OpaqueCompactStateFailure` 的某个字面量），不是给 upstream message/
   * body、raw status detail、marker/stateId/session/account 明文开的口子；
   * 需要自由文本诊断信息用 `detail`，不要拿 `cause` 顶替。类型直接表达成
   * 这个联合类型（而不是宽松的 `string`），让注释里说的封闭值域和类型系统
   * 本身对得上，不用光靠注释自律。
   */
  cause?: RecompactFailureCause | OpaqueCompactStateFailure;
  /**
   * ★ #96（reviewer 交叉审查发现）：这次决策真正返回给客户端的 HTTP 状态码。
   * `#91` 之前这里恒为 409，不需要单独记；`#91` 之后族 A（自愈候选撞在
   * 非 compact 请求上）改成了 400，同一个 `recordOpaqueCompactDenial` 调用
   * 现在可能对应 400 或 409——Dashboard 如果继续假设"denied = 409"就会给
   * 用户错误的指引（比如对一个 400/族 A 的记录说"用 /clear"，正确动作其实
   * 是"下次 /compact 自动恢复"）。调用方（`messages.ts`）负责传真实值，这个
   * 函数不重新推导——推导逻辑（`isSelfHealableOpaqueCompactStateFailure`）
   * 只应该有一份，在 `messages.ts` 决定状态码的地方，不在这里抄一份。
   */
  httpStatus?: number;
  /**
   * ★ #88：这次请求从进入 `/v1/messages` 处理到这次 fail-closed 决策
   * 为止的耗时（毫秒）。只喂进 `compact-outcomes.jsonl`（供 Dashboard 压缩
   * 明细面板显示），不进 `error-log.jsonl` 的白名单 context——那份是独立的
   * 取证日志（8.6），字段白名单变更影响更大，这次不动它。fail-closed
   * 理应是毫秒级；如果哪次耗时到了秒级，耗时数字本身就是排查线索（锁竞争/
   * store 慢查询），不是只有真正打了上游的失败才值得记耗时。
   */
  durationMs?: number;
  /**
   * ★ #88：只有 `recompact_failed_original_account` 这一类 denial 可能真的
   * 联系过上游（`CompactServiceError.upstreamMs`，见该字段文档）——其它
   * denial 分支（缺 session 上下文、store 未就绪等）在联系上游之前就
   * fail-closed 了，没有这个概念，不强凑。
   */
  upstreamMs?: number;
}

/** 记录一次 opaque compact 的 fail-closed 决策（400 或 409，见 `httpStatus`）。绝不抛出。 */
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
        // ★ #83：结构化 enum 值，不过 sanitizeFreeTextForLog——那个函数是给
        // detail 这类自由文本用的；cause 的值域封闭且已知，跟 reason 同等
        // 待遇，原样落盘。
        cause: input.cause ?? null,
      },
    });
  } catch {
    // 日志失败绝不能影响主流程——appendErrorLog 内部已经兜底，这里再包一层
    // 纯粹是防御性的，避免未来有人在 context 构造里引入会抛错的逻辑。
  }

  // ★ 8.10：Dashboard 快速压缩成功率统计——fail-closed 语义和"悄悄降级
  // 但仍然成功"完全不同（客户端拿到硬错误，会话可能直接死），刻意单独
  // 一类，不并入 upstream_failed，见 compact-outcome-log.ts 头部注释。
  // ★ #96：httpStatus/cause 原样透传——Dashboard 需要这两个字段才能对
  // 每条 denied 记录给出正确指引（族 A/400 该建议下次 /compact，其余
  // 400/409 该建议 /clear，`stale_generation`/`preserved_tail_conflict`
  // 该建议继续对话），不能继续假设"denied = 409 = 统一建议 /clear"。
  recordCompactOutcome({
    requestId: input.requestId,
    clientConversationId: input.clientConversationId,
    model: input.model ?? "unknown",
    outcome: "denied",
    reason: input.reason,
    httpStatus: input.httpStatus,
    cause: input.cause,
    durationMs: input.durationMs,
    upstreamMs: input.upstreamMs,
  });
}
