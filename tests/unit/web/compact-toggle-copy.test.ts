import { describe, expect, it } from "vitest";

import { translations } from "../../../shared/i18n/translations.js";

/**
 * Dashboard 的 compact 开关此前有两个：经典桥接（legacy compact + render）
 * 与 Opaque（单次 compact + 加密持久状态 + marker，跨重启可恢复）。经典桥接
 * 已随 Task #4 移除（`messages.ts` 不再有任何分支读它），Opaque 是现在唯一
 * 的 compact 路径，因此不再需要"两者都开时谁优先"这类说明——那个场景已经
 * 不存在。文案回归测试相应收窄到只验证 Opaque hint 本身仍然准确：
 *
 * - Opaque hint 曾经写着 "keep opaque state in memory / 重启后状态失效"，
 *   那是 SQLite 持久化落地之前的行为，照着读会让运维误以为需要额外操作
 *   才能跨重启恢复。这里继续钉死"不再声称 in-memory / lost-on-restart"和
 *   "确实描述了加密持久化 + 重启可恢复"这两条不变式。
 */

const LOCALES = ["en", "zh"] as const;

const STALE_CLAIMS = [
  "in memory",
  "lost on restart",
  "内存",
  "重启后状态失效",
] as const;

function opaqueHint(locale: (typeof LOCALES)[number]): string {
  return translations[locale].generalSettingsOpaqueCompactHint;
}

describe("compact toggle copy", () => {
  it.each(LOCALES)("[%s] the opaque toggle still has a label and a hint", (locale) => {
    const t = translations[locale];
    for (const key of [
      "generalSettingsOpaqueCompact",
      "generalSettingsOpaqueCompactHint",
    ] as const) {
      expect(typeof t[key], `${locale}.${key}`).toBe("string");
      expect(t[key].length, `${locale}.${key}`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)("[%s] opaque hint no longer claims in-memory / lost-on-restart", (locale) => {
    const hint = opaqueHint(locale).toLowerCase();
    for (const stale of STALE_CLAIMS) {
      expect(hint.includes(stale.toLowerCase()), `${locale} still claims "${stale}"`).toBe(false);
    }
  });

  it.each(LOCALES)("[%s] opaque hint describes persistence surviving a restart", (locale) => {
    const hint = opaqueHint(locale);
    const mentionsPersistence = /encrypt|persist|落盘|加密/i.test(hint);
    const mentionsRestart = /restart|重启/i.test(hint);
    expect(mentionsPersistence, `${locale} opaque hint must mention encrypted persistence`).toBe(true);
    expect(mentionsRestart, `${locale} opaque hint must mention restart recovery`).toBe(true);
  });
});

// ★ #88 复审（team-lead）：这里原来有一条 `describe("compact toggle copy
// matches runtime behavior")` 用"源码字符距离"当"两段逻辑相邻"的代理——
// 断言 `readiness.ready) {` 到 `c.status(409)` 之间的字符数小于某个窗口
// （400 → #88 加了 durationMs 埋点后涨到 637 → 一度放宽到 700）。这类断言
// 本身就是脆弱的：它只能沿着"窗口不够就继续调大"这一条路径演化，直到
// 数字大到不再守护任何东西——而它真正想守护的不变式（"未就绪的 opaque
// store 必须 fail-closed 返回 409，不会静默放行/打上游"）其实已经有更强、
// 更真实的行为测试覆盖，不需要靠猜字符距离：
//
// - `tests/e2e/opaque-compact-fault-blast-radius.test.ts` 的 `freshCompact`
//   断言：store 处于 `store_unavailable` 致命故障时，一个全新会话发起全新
//   compact 请求（真实触发 `!readiness.ready` 那个早退分支）必须 409，且
//   `compactBodies` 计数不增长——即真的没有打过一次上游，不是只看状态码。
// - `tests/e2e/opaque-compact-lifecycle.test.ts` 的
//   "route-layer guard: a fatal store failure (store_locked) 409s even when
//   the request looks exactly like a legitimate self-heal continuation" ——
//   同样用真实机制（第二实例抢锁失败产生 store_locked）验证 fail-closed，
//   并额外证明这条防线有三层独立防御（显式 readiness 早退 / store 访问的
//   兜底 throw / 分类函数本身不会把致命 reason 判成可自愈）。
//
// 两条都是对真实 HTTP 响应 + 真实上游调用次数断言，而不是对 messages.ts
// 源码文本做正则匹配——重构挪动这段逻辑的位置、改写变量名、插入新的埋点
// 字段都不会误伤它们，也不会像字符距离断言那样需要跟着"手动调宽窗口"。
// 因此这里不再需要一条平行的、脆弱的源码正则断言。
