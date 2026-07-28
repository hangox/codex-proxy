import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { translations } from "../../../shared/i18n/translations.js";

/**
 * Dashboard 上两个 compact 开关的说明文案曾经写着 "keep opaque state in memory /
 * 重启后状态失效"，那是 SQLite 持久化落地之前的行为。文案说反了会让运维在
 * 需要跨重启恢复时误开经典桥接，所以这里把文案钉到真实行为上：
 *
 * - 经典桥接 = legacy compact + render
 * - Opaque   = 单次 compact + 加密持久状态 + marker，跨重启可恢复（推荐）
 * - 两者都开时 Opaque 优先，且不建议同时开启
 *
 * 优先级那条不是比字符串，而是直接读 `src/routes/messages.ts` 的分支顺序，
 * 代码改了优先级这里就会红。
 */

const ROOT = resolve(__dirname, "..", "..", "..");
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

function classicHint(locale: (typeof LOCALES)[number]): string {
  return translations[locale].generalSettingsCompactBridgeHint;
}

describe("compact toggle copy", () => {
  it.each(LOCALES)("[%s] both toggles still have a label and a hint", (locale) => {
    const t = translations[locale];
    for (const key of [
      "generalSettingsCompactBridge",
      "generalSettingsCompactBridgeHint",
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

  it.each(LOCALES)("[%s] opaque hint states it wins and advises against enabling both", (locale) => {
    const hint = opaqueHint(locale);
    expect(/wins|priority|优先/i.test(hint), `${locale} must state opaque takes priority`).toBe(true);
    expect(
      /not recommended|不建议/i.test(hint),
      `${locale} must advise against enabling both switches`,
    ).toBe(true);
  });

  it.each(LOCALES)("[%s] classic hint is marked legacy and describes compact + render", (locale) => {
    const hint = classicHint(locale);
    expect(/legacy|旧版/i.test(hint), `${locale} must mark the classic bridge as legacy`).toBe(true);
    expect(/compact \+ render/i.test(hint), `${locale} must describe compact + render`).toBe(true);
  });
});

describe("compact toggle copy matches runtime precedence", () => {
  it("opaque branch is evaluated before the classic bridge branch", () => {
    const source = readFileSync(resolve(ROOT, "src", "routes", "messages.ts"), "utf-8");
    const opaqueBranch = source.indexOf("&& opaqueCompactEnabled) {");
    const classicBranch = source.indexOf("&& compactBridgeEnabled) {");
    expect(opaqueBranch, "opaque compact branch not found").toBeGreaterThan(-1);
    expect(classicBranch, "classic compact bridge branch not found").toBeGreaterThan(-1);
    expect(
      opaqueBranch,
      "opaque must be handled first; the dashboard copy promises it takes priority",
    ).toBeLessThan(classicBranch);
  });

  it("an unready opaque store fails closed instead of silently using the classic bridge", () => {
    const source = readFileSync(resolve(ROOT, "src", "routes", "messages.ts"), "utf-8");
    expect(source).toContain("Opaque compact state store is unavailable");
  });
});
