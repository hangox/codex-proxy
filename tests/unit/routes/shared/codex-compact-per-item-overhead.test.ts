/**
 * ★ 8.11：结构开销常数的回归测试——team-lead 要求的"三层测试"里的第二层。
 *
 * 断言的是 `PER_ITEM_TOKEN_OVERHEAD` 这个常数本身落在合理区间，**不是**
 * 断言某次估算的总误差（总误差已经由 `codex-compact-estimate-accuracy.test.ts`
 * 用真实样本锁住）。这条测试存在的意义：万一以后有人改了
 * `extractCompactContentForTokenizing` 的内容抽取逻辑（比如给某种新 item
 * 类型加了字段但漏抽/多抽），或者手滑改了这个常数本身，即使总误差因为
 * 抵消效应暂时看起来还行，这条测试也能在"常数本身跑出了 2~8 的合理区间"
 * 这一步就报警，不用等到总误差劣化才被发现。
 *
 * 2~8 的区间依据：评估阶段用 4 组真实样本实测出的隐含结构开销是
 * 2.86~5.94 token/item（见 `PER_ITEM_TOKEN_OVERHEAD` 源码注释的完整数据），
 * 当前取值 4。区间上下各留出约 1~2 的余量，既不会因为样本量小、常数
 * 将来小幅重新校准就误报，又能拦住真正离谱的漂移（比如常数被改成 20 或 -1
 * 这种明显错误的值）。
 */

import { describe, expect, it } from "vitest";
import { PER_ITEM_TOKEN_OVERHEAD } from "@src/routes/shared/codex-compact-service.js";

describe("PER_ITEM_TOKEN_OVERHEAD 回归", () => {
  it("落在实测支撑的合理区间 [2, 8]，不是断言等于某个具体值", () => {
    expect(PER_ITEM_TOKEN_OVERHEAD).toBeGreaterThanOrEqual(2);
    expect(PER_ITEM_TOKEN_OVERHEAD).toBeLessThanOrEqual(8);
  });

  it("是一个正整数（token 数没有分数/负数的意义）", () => {
    expect(Number.isInteger(PER_ITEM_TOKEN_OVERHEAD)).toBe(true);
    expect(PER_ITEM_TOKEN_OVERHEAD).toBeGreaterThan(0);
  });
});
