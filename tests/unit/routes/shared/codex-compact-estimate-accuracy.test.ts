/**
 * ★ 这是第一条"验证估算值本身准不准"的测试——为什么需要它，比测试本身
 * 更容易被后人遗忘，必须写在这里。
 *
 * v2.0.88 上线后 terra 在 24.4 小时内 472 次 compact 尝试、440 次失败，
 * 100% 是上游 400 "Prompt is too long"，其中至少 2 次是**误判**：真实
 * `usage.input_tokens` 远低于预算，本来该成功却被 `estimateCompactInputTokens`
 * 高估、判定超限、降级到慢路径（`rid=39587bd5`：真实约 27.5万 token，被
 * `COMPACT_BYTES_PER_TOKEN_ESTIMATE=2.18` 估成 448,457，超过 sol 当时的
 * 390,000 预算）。
 *
 * 这个 bug 能活到生产，是因为此前四层测试**没有一层在问"估算值本身对不对"**：
 * - `codex-compact-budget.test.ts` 的单测锁住的是**取整方向必须朝高估**
 *   （`Math.ceil`），不锁比例常量本身准不准——因为没有"正确值"可断言，只能
 *   拿合成数字验证 ceil 逻辑。
 * - `tests/e2e/messages.test.ts` 里 task #25 那两条 e2e 用的是**故意构造的
 *   必然超预算的纯文本**，测的是"超限时降级不 409"这个行为，估算准不准
 *   对这条测试的通过与否毫无影响。
 * - 2.0.88/2.0.89 门禁验证用的是合成负载或小规模真实会话，量级落不进
 *   "估算误判"会实际发生的那个带（只有真实输入接近某个模型预算边界时，
 *   估算的系统性偏差才会造成错误判定，边界内外差异被合成负载的巨大冗余
 *   量掩盖了）。
 * - 上限矩阵实测（`resolveCompactTokenBudget` 头部注释里那张表）测的是
 *   "模型自己能吃多少"，同样用合成负载，从未拿真实会话反过来验证
 *   "估算这个真实会话要用多少字节，算出来的数字和上游真实收下的 token
 *   数差多少"。
 *
 * 这条测试直接堵上这个盲区：固定几组**真实来源**的 `(压缩请求真实字节数,
 * 上游真实返回的 usage.input_tokens)` 配对（来自 qa 多轮真实 `/v1/responses/
 * compact` 调用，字节数用 `Buffer.byteLength(JSON.stringify(body), "utf8")`
 * 精确统计，和生产 `summarizeCompactInputBytes` 内部用的是同一个方法——
 * 早期一版曾经错用 JS 字符串 `.length`（UTF-16 code unit 数），对含中文
 * 内容的真实会话系统性低估字节数，此处的数值已经用 `Buffer.byteLength`
 * 复核修正过），断言两件事，**都不断言比例常量本身**：
 *
 * 1. 方向性：`estimateCompactInputTokens(bodyBytes) >= realTokens`——这是
 *    `COMPACT_BYTES_PER_TOKEN_ESTIMATE` 取值必须始终遵守的安全前提（宁可
 *    高估触发不必要的裁剪/降级，也不能低估放过一个注定失败的上游调用），
 *    任何一次比例调整都不能打破它。
 * 2. 比例上界：`estimate / realTokens` 落在 [1.0, 1.5] 区间——上界防止
 *    "为了绝对安全"把比例调得离谱大（1.49x 都嫌保守之类），下界就是
 *    上面那条方向性断言的另一种表达。**不断言常量具体等于多少**：
 *    `COMPACT_BYTES_PER_TOKEN_ESTIMATE` 会随着样本积累继续校准（当前
 *    2.70 是 4 个真实样本的下界，样本量还不够定新常量——见下方 FIXTURES
 *    每条注释），把这条测试和某个具体常量值绑死，会导致每次校准调整都要
 *    连带改测试，这不是这条测试要保护的东西。
 *
 * 样本量现状：只有 4 组，覆盖的都是 gpt-5.6-sol、都是同一个使用者
 * （qa 自己的开发会话/团队协作会话）。不足以细分内容类型（中文重的、
 * 代码重的、tool_result 重的）各自的比例分布，只能给出"这4个真实样本
 * 都不会被现有估算判成假阴性"这个下界保证。以后任何真实 compact 成功
 * 并返回 usage 的场景，都应该把 `(真实字节数, 真实token数)` 顺手记进
 * 这个数组——积累到十几组、覆盖不同内容类型之后，才有条件真正谈"重新
 * 定标"或者"按会话自适应校准"（team-lead 提过的方向，未实施）。
 */

import { describe, expect, it } from "vitest";
import { estimateCompactInputTokens } from "@src/routes/shared/codex-compact-service.js";

interface RealPair {
  label: string;
  /** 真实压缩请求整体的字节数（Buffer.byteLength，含 instructions/input/tools）。 */
  bodyBytes: number;
  /** 上游对同一次请求返回的真实 usage.input_tokens。 */
  realTokens: number;
}

/**
 * ★★★ 往这个数组加新样本前必读——这不是提醒，是这份 fixture 已经真实
 * 踩过的坑。
 *
 * `bodyBytes` 必须用 `Buffer.byteLength(payload, "utf8")` 度量，**不能用
 * JS 字符串的 `.length`**。后者是 UTF-16 code unit 数，不是字节数——中文
 * 字符在 UTF-8 下是 3 字节但 `.length` 只算 1，对含中文的真实会话会把字节
 * 数系统性低估到接近 1/3。这也不只是"不够精确"：生产代码
 * `summarizeCompactInputBytes` 内部用的就是 `Buffer.byteLength`，用
 * `.length` 度量出来的数字和生产真实口径根本不是一回事，拿去和真实
 * `usage.input_tokens` 配对会得出错误的比例。
 *
 * 本 fixture 前三组数据（task26-rung1-A/rung2-B/rung3-B）第一版就踩了这个
 * 坑——当时用 `.length` 算出的比例是 2.70 / 3.34 / 3.33，看起来和第四组
 * （qa-session-verify，从一开始就用 `Buffer.byteLength`）的 3.60 挺接近，
 * 容易被当作"数据一致，可信"直接采信。改用 `Buffer.byteLength` 复核后，
 * 真实比例是 **2.965 / 3.811 / 3.807**——前三组全部被系统性低估了，且低估
 * 到足以影响"当前 2.70 是不是贴着真实下界走"这个结论（复核前以为 2.70
 * 就是下界，复核后 2.965 才是，2.70 反而比必要的更保守）。这个错误在写进
 * 这个 fixture 之前被发现、修正过，此处的四个数字都是修正后的。
 *
 * 以后加新样本时最容易犯的就是同一个错——顺手写个 `.length` 就把新数据
 * 加进去，而且因为其他数据是对的，混进去一个错的反而更难被发现（不会
 * 报错，只会让 [1.0, 1.5] 那条断言的实际余量比看起来的更小或更大）。
 * 加样本时用 `Buffer.byteLength(JSON.stringify(body), "utf8")`，不要偷懒。
 */
const FIXTURES: RealPair[] = [
  {
    // task #26 端到端实测（rung1-A）：真实 805 条消息切片（含真实 thinking
    // 块），model=gpt-5.6-sol，走真实 compact 端点成功。
    label: "task26-rung1-A (含thinking, gpt-5.6-sol)",
    bodyBytes: 1_009_239,
    realTokens: 340_394,
  },
  {
    // task #26（rung2-B）：同一份历史，thinking 块被剥离后的版本，更大切片
    // （805条消息裁剪掉thinking后仍在预算内）。
    label: "task26-rung2-B (去thinking, gpt-5.6-sol)",
    bodyBytes: 1_076_683,
    realTokens: 282_519,
  },
  {
    // task #26（rung3-B）：进一步放大切片，验证"去thinking后还能撑多大"。
    label: "task26-rung3-B (去thinking, 更大切片, gpt-5.6-sol)",
    bodyBytes: 1_188_109,
    realTokens: 312_084,
  },
  {
    // task #（比例校验专项）：从用户真实 55MB+ 会话（Mac Mini 上
    // 84d4701c-f855-4852-8fe1-2990f9601bea.jsonl）里切出的一段真实历史，
    // 切法本身经过验证——用旧比例 2.18 反推出的估算值（454,337）落在
    // 生产真实记录（448,457，rid=39587bd5）附近，确认这份切片有代表性。
    label: "qa-session-verify (真实用户会话切片, gpt-5.6-sol)",
    bodyBytes: 991_083,
    realTokens: 275_276,
  },
];

describe("estimateCompactInputTokens 对真实样本的准确度（不是取整逻辑，是比例本身）", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.label}：估算值不低估真实 token 数`, () => {
      const estimated = estimateCompactInputTokens(fixture.bodyBytes);
      // ★ 决定性断言：这是整套预算机制的安全前提——低估会把本该拦截的
      // 请求放过去，白打一次注定失败的上游调用。任何比例常量调整都不能
      // 打破这一条。
      expect(estimated).toBeGreaterThanOrEqual(fixture.realTokens);
    });

    it(`${fixture.label}：估算值不会离谱地高估（比值落在 [1.0, 1.5]）`, () => {
      const estimated = estimateCompactInputTokens(fixture.bodyBytes);
      const ratio = estimated / fixture.realTokens;
      // 上界防止比例常量为了"绝对安全"被调得过大，导致大量本可成功的
      // compact 被不必要地裁剪/降级；下界就是上一条方向性断言的另一种
      // 表达。★ 不断言 ratio 等于某个具体值——常量会随样本积累继续校准，
      // 这条测试保护的是"合理区间"，不是当前这个具体数字。
      expect(ratio).toBeGreaterThanOrEqual(1.0);
      expect(ratio).toBeLessThanOrEqual(1.5);
    });
  }
});
