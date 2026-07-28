import { readFileSync } from "fs";
import { resolve } from "path";
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

describe("compact toggle copy matches runtime behavior", () => {
  it("an unready opaque store fails closed instead of silently continuing", () => {
    const source = readFileSync(
      resolve(__dirname, "..", "..", "..", "src", "routes", "messages.ts"),
      "utf-8",
    );
    // 8.5 把所有 opaque 409 的文案收口进 describeOpaqueCompactUnavailable()，
    // 不再是四处各写一遍字面量——这里改成断言"未就绪 store 走这个统一收口
    // 函数并返回 409"，而不是绑死某一句具体措辞（措辞已经因为 8.5 改了）。
    expect(source).toContain("describeOpaqueCompactUnavailable");
    expect(source).toMatch(/readiness\.ready\)\s*\{[\s\S]{0,400}?c\.status\(409\)/);
  });
});
