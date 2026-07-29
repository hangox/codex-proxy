/**
 * `sanitizeFreeTextForLog`——自由文本（如上游 CodexApiError.message）写日志
 * 前的统一处理：marker 值级脱敏 + 截断。详见 `src/logs/redact.ts` 与
 * `opaque-compact-fallback-log.ts` 头部注释里对 error_message 敏感性的
 * 判断依据。这里只测这一个函数本身的行为契约，不重复 `redactJson` 已有的
 * 覆盖（`opaque-compact-log-privacy.test.ts` / `opaque-compact-denial-log.test.ts`
 * 已经在测 `redactJson` 的 key 名脱敏与 marker 值脱敏）。
 */

import { describe, expect, it } from "vitest";
import { sanitizeFreeTextForLog } from "@src/logs/redact.js";

const MARKER_TOKEN =
  `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;

describe("sanitizeFreeTextForLog", () => {
  it("短文本原样返回", () => {
    expect(sanitizeFreeTextForLog("rate limited, retry later")).toBe(
      "rate limited, retry later",
    );
  });

  it("嵌在自由文本里的 opaque marker 被整体替换，不留任何一段原文", () => {
    const text = `upstream rejected: previous state was ${MARKER_TOKEN}, please retry`;
    const out = sanitizeFreeTextForLog(text);
    expect(out).not.toContain(MARKER_TOKEN);
    expect(out).not.toContain("A".repeat(32));
    expect(out).not.toContain("B".repeat(43));
    expect(out).not.toContain("C".repeat(43));
    expect(out).toContain("codex-opaque-state:***");
  });

  it("超过上限长度的文本被截断，并标注截断与原始长度", () => {
    const longText = "x".repeat(500);
    const out = sanitizeFreeTextForLog(longText, 300);
    expect(out.length).toBeLessThan(longText.length);
    expect(out).toContain("truncated");
    expect(out).toContain("500 chars total");
    expect(out.startsWith("x".repeat(300))).toBe(true);
  });

  it("恰好等于上限长度的文本不截断", () => {
    const exact = "y".repeat(300);
    expect(sanitizeFreeTextForLog(exact, 300)).toBe(exact);
  });

  it("空字符串原样返回，不抛出", () => {
    expect(sanitizeFreeTextForLog("")).toBe("");
  });
});
