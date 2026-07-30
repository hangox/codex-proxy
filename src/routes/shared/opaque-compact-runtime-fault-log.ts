/**
 * opaque compact runtime 转入 store 级致命故障时的结构化落盘。
 *
 * 背景（真实生产事故，qa 从 error-log 里翻出来的）：一次 `store_unavailable`
 * 故障发生后，runtime 原子转 NOT_READY，此后**每一个**带 marker 的请求都会
 * 撞同一个 409（`recordOpaqueCompactDenial`，见 `opaque-compact-denial-log.ts`）
 * ——单个会话 77 次、49 分钟、退避从 8s 涨到 46s，客户端从未成功过。**根因
 * 至今查不到，且永久查不到了**：原始异常只打了一行 `console.warn`
 * （`phase=store_unavailable`/`phase=store_fault`），旧容器被 compose 替换
 * 后连 stdout 都没了，而这两行 console.warn 从来没有进过
 * `appendErrorLog`/`error-log.jsonl`。
 *
 * 这个函数补的就是这个洞——记录"runtime 转入故障"这个事件本身（每次
 * 故障转换只发生一次，不是每个请求都记一遍；请求侧的 94 次 409 各自已经
 * 由 `recordOpaqueCompactDenial` 记录，这里记的是"为什么会开始 409"）。
 * 没有 rid/clientConversationId：这个函数天然在请求上下文之外触发（服务
 * 启动时的 `startOpaqueCompactRuntime()` 失败、或运行期任意一次请求触发的
 * 动态故障检测），不属于某一次具体请求，字段形状因此和
 * `recordOpaqueCompactDenial`/`recordOpaqueCompactFallback` 都不同，不能
 * 硬塞进那两个函数的白名单里，需要一个专门的收口点。
 *
 * `detail`（原始异常文本）的敏感性判断：来源和本轮 `error.message`
 * 系列判断同源（追到底都是某个具体子系统抛出的 `Error.message`，可能含
 * 文件路径、SQLite 错误原文等），按同一套既有判断处理：过
 * `sanitizeFreeTextForLog`（marker 值级脱敏 + 截断）后才落盘，且只放进
 * `context`（会再过一遍 `appendErrorLog` 内部的 `redactJson`），顶层
 * `error.message` 只放受控的分类字符串（`reason`），不放自由文本。
 */

import { appendErrorLog } from "../../logs/error-log.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import type { OpaqueCompactStateFailure } from "./opaque-compact-state.js";

export interface OpaqueCompactRuntimeFaultInput {
  reason: OpaqueCompactStateFailure;
  /**
   * 原始异常文本（通常是某个子系统 `Error.message`）。调用方不需要预先
   * 脱敏——这个函数内部会在写入 `context` 前统一过
   * {@link sanitizeFreeTextForLog}。可能为空（比如某些手写的 fail-closed
   * 分支本身就没有底层异常，只有一句固定说明）。
   */
  detail?: string;
  /**
   * 这是启动期故障（`startOpaqueCompactRuntime()` 失败）还是运行期故障
   * （已经 ready 的 runtime 在处理某次请求时发现致命错误）——同一套
   * reason 枚举在两个阶段都可能出现，运维排查时需要先分清是哪一种。
   */
  phase: "startup" | "runtime";
}

/** 记录一次 opaque compact runtime 转入/进入 store 级致命故障。绝不抛出。 */
export function recordOpaqueCompactRuntimeFault(input: OpaqueCompactRuntimeFaultInput): void {
  try {
    appendErrorLog({
      source: "server",
      error: {
        name: "OpaqueCompactRuntimeFault",
        // 顶层 error.message 不经过 redactJson，因此这里只放受控的分类
        // 字符串（reason），自由文本只出现在下面的 context.detail 里。
        message: input.reason,
      },
      context: {
        phase: input.phase,
        reason: input.reason,
        detail: input.detail != null ? sanitizeFreeTextForLog(input.detail) : null,
      },
    });
  } catch {
    // 日志失败绝不能影响主流程——appendErrorLog 内部已经兜底，这里再包一层
    // 纯粹是防御性的。
  }
}
