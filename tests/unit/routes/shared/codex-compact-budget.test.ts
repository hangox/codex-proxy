/**
 * task #28（reviewer 复审提出的中等问题）：`resolveCompactTokenBudget` /
 * `estimateCompactInputTokens` / `trimCompactInputForBudget` /
 * `planCompactRequestForBudget` 这四个函数直接决定"要不要把这次 compact
 * 请求判定为超限"——判宽了会把本该降级的请求送去撞上游 400，判窄了会让
 * 本可以正常压缩的会话无谓降级到慢路径。此前全仓库只有 `messages.ts` 间接
 * 调用它们，加上两条 e2e（`tests/e2e/messages.test.ts` 里 task #25 那两条），
 * e2e 测的是端到端行为，没有单独锁住这四个函数各自的边界。这里直接 import
 * 它们，锁住 reviewer 点名的几个边界。
 *
 * 特别锁住一条不精确性（reviewer 核实过、判定"不构成安全问题"的那条）：
 * `trimCompactInputForBudget` 用 `.slice(0, perOutputByteLimit)` 按字符切，
 * 多字节内容（中文）切出来的真实字节数会超过 `perOutputByteLimit`——这个
 * 不精确本身是可以接受的，因为下游 `planCompactRequestForBudget` 裁完之后
 * 一定会用 `summarizeCompactInputBytes`（内部是 `Buffer.byteLength`）重新
 * 真实测量，安全性建立在"重测"而不是"裁剪应该省下多少"的假设上。这条依赖
 * 关系必须有测试固定住——万一以后有人"优化"掉那次重测，改成信任裁剪的
 * 预期收益，安全性就塌了。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CodexCompactRequest, CodexInputItem } from "@src/proxy/codex-types.js";

// ★ 8.11：planCompactRequestForBudget 现在可能懒加载真分词器（js-tiktoken，
// 见 compact-tokenizer.ts）。这个文件测的是**预算判定逻辑**（超没超、裁不裁、
// 用哪种估算方法）本身，不是分词器准不准——分词器准不准有专门的独立测试层
// （`compact-tokenizer.test.ts`，构造内容 + 快照断言，见 team-lead 要求的
// "三层测试"）。这里 mock 掉 `tokenizeCompactContent`，用一个简单、确定、
// 与真实 BPE 无关的字符数/token 比例（4 chars/token）——这样测试用例可以用
// 简单重复字符串（"a".repeat(N)）构造，不用担心真实分词器对高度重复内容的
// 压缩率失真（真实 BPE 对 "aaaa...a" 这种内容的压缩率极高，用真分词器测会让
// 这些特意构造的"应该超预算"的测试用例得出错误结论）。
const mockTokenizeCompactContent = vi.fn(async (text: string): Promise<number | null> => {
  return Math.ceil(text.length / 4);
});
vi.mock("@src/routes/shared/compact-tokenizer.js", () => ({
  tokenizeCompactContent: (text: string) => mockTokenizeCompactContent(text),
  loadCompactTokenizer: vi.fn(),
  _resetCompactTokenizerCacheForTest: vi.fn(),
}));

const {
  estimateCompactInputTokens,
  planCompactRequestForBudget,
  resolveCompactTokenBudget,
  summarizeCompactInputBytes,
  trimCompactInputForBudget,
} = await import("@src/routes/shared/codex-compact-service.js");

beforeEach(() => {
  mockTokenizeCompactContent.mockClear();
});

function functionCallOutput(callId: string, output: string): CodexInputItem {
  return { type: "function_call_output", call_id: callId, output };
}

describe("resolveCompactTokenBudget", () => {
  it("★ 8.8：8 型号实测矩阵，每个已校准型号返回各自的预算值", () => {
    // 数值来自 qa 完整实测矩阵（17 次真实调用），见 codex-compact-service.ts
    // 里 COMPACT_TOKEN_BUDGET_BY_MODEL 头部注释的完整表格与两条结论。
    expect(resolveCompactTokenBudget("gpt-5.3-codex-spark")).toBe(110_000);
    expect(resolveCompactTokenBudget("gpt-5.4-mini")).toBe(260_000);
    expect(resolveCompactTokenBudget("gpt-5.5")).toBe(270_000);
    expect(resolveCompactTokenBudget("gpt-5.6-sol")).toBe(390_000);
    expect(resolveCompactTokenBudget("gpt-5.6-terra")).toBe(390_000);
    expect(resolveCompactTokenBudget("gpt-5.6-luna")).toBe(390_000);
    expect(resolveCompactTokenBudget("codex-auto-review")).toBe(580_000);
    expect(resolveCompactTokenBudget("gpt-5.4")).toBe(680_000);
  });

  it("gpt-5.5 明显低于同代的 sol/terra/luna，不能被合并进 390000 那一档", () => {
    // 声明 contextWindow 和 sol/terra/luna 一样都是 272000，但实测成功
    // 最大只有 284,961（vs 三者的 405,1xx）——这条测试锁住"同代不等于同预算"，
    // 防止以后有人看 model 名字像同一代就把它合并档位。
    const gpt55Budget = resolveCompactTokenBudget("gpt-5.5");
    const sameGenBudget = resolveCompactTokenBudget("gpt-5.6-sol");
    expect(gpt55Budget).toBeLessThan(sameGenBudget);
  });

  it("★ gpt-5.3-codex-spark 不会被误套大窗口档——它的真实上限几乎贴着声明值走，必须单独给保守预算，不能落进任何其它档位", () => {
    const sparkBudget = resolveCompactTokenBudget("gpt-5.3-codex-spark");
    // 决定性断言：spark 的预算严格小于表里其它所有已校准型号——如果它被
    // 误合并进任何一档（哪怕是 mini 那档 260,000），这里就会失败。
    for (const model of ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review", "gpt-5.4"]) {
      expect(sparkBudget).toBeLessThan(resolveCompactTokenBudget(model));
    }
    // 且严格小于未入表型号的兜底值——spark 比"完全不认识的新模型"还要保守，
    // 不能反过来更宽松。
    expect(sparkBudget).toBeLessThan(resolveCompactTokenBudget("some-brand-new-model-never-seen"));
  });

  it("未校准型号返回固定兜底值 260000——★ 8.8 起不再等于表内最小值（spark=110000 才是最小值，但兜底刻意不跟着它走，理由见 COMPACT_TOKEN_BUDGET_DEFAULT 头部注释）", () => {
    expect(resolveCompactTokenBudget("some-brand-new-model-never-seen")).toBe(260_000);
    expect(resolveCompactTokenBudget("")).toBe(260_000);
    // 决定性断言：兜底值不等于表内最小值（spark）——这是 8.8 这次改动的
    // 一个关键设计决策，必须显式锁住，防止以后有人"顺手"把兜底值改回
    // "取 Math.min(...表内所有值)"这种看起来更"安全"实则会拖慢所有新
    // 模型的写法。
    expect(resolveCompactTokenBudget("some-brand-new-model-never-seen")).not.toBe(
      resolveCompactTokenBudget("gpt-5.3-codex-spark"),
    );
    // 兜底值恰好等于 mini 的校准值，是刻意的选择（mini 量级对未来新模型
    // 而言是保守但不过度保守的默认值），不是巧合。
    expect(resolveCompactTokenBudget("some-brand-new-model-never-seen")).toBe(
      resolveCompactTokenBudget("gpt-5.4-mini"),
    );
  });
});

describe("estimateCompactInputTokens", () => {
  it("整除时返回精确值", () => {
    // ★ 8.9：换算比例从 2.18 改成 2.70（真实会话实测下界，见
    // COMPACT_BYTES_PER_TOKEN_ESTIMATE 头部注释——2.18 是合成负载测出来的，
    // 系统性高估真实会话的 token 数，在生产造成过反复无谓降级）。
    // 2700 / 2.70 = 1000 精确整除。
    expect(estimateCompactInputTokens(2700)).toBe(1000);
  });

  it("★ 取整方向必须是向上（Math.ceil），不能是向下——这是整套预算设计的安全前提", () => {
    // 2701 / 2.70 = 1000.37...：ceil → 1001，floor/round-down → 1000。
    // 如果实现改成向下取整，会系统性低估 token 数，把本该拦截的请求放过去，
    // 这是整个方案里唯一一处"估算方向不能错"的地方——这条和比例值本身
    // （8.9 从 2.18 改成 2.70）是两回事：比例值可以按实测调整，但取整方向
    // 必须始终朝"高估"，不能反过来。
    const tokens = estimateCompactInputTokens(2701);
    expect(tokens).toBe(1001);
    expect(tokens).toBeGreaterThan(2701 / 2.70);
  });

  it("0 字节输入返回 0 token，不炸也不返回负数/NaN", () => {
    expect(estimateCompactInputTokens(0)).toBe(0);
  });
});

describe("trimCompactInputForBudget", () => {
  it("恰好等于 perOutputByteLimit 的输出不被裁剪", () => {
    const output = "a".repeat(20); // 20 字节，ASCII 下字符数=字节数
    const { input, trimmedCount } = trimCompactInputForBudget(
      [functionCallOutput("c1", output)],
      20,
    );
    expect(trimmedCount).toBe(0);
    expect(input[0]).toEqual(functionCallOutput("c1", output));
  });

  it("略超 perOutputByteLimit 的输出被裁剪并计数", () => {
    const output = "a".repeat(21); // 21 字节，超过限制 1 字节
    const { input, trimmedCount } = trimCompactInputForBudget(
      [functionCallOutput("c1", output)],
      20,
    );
    expect(trimmedCount).toBe(1);
    const trimmedItem = input[0] as Extract<CodexInputItem, { type: "function_call_output" }>;
    expect(trimmedItem.output.startsWith("a".repeat(20))).toBe(true);
    expect(trimmedItem.output).toContain("truncated 1 bytes to fit compact budget");
  });

  it("非 function_call_output 的条目一律不动，无论多大", () => {
    const hugeText: CodexInputItem = { role: "user", content: "x".repeat(1_000_000) };
    const { input, trimmedCount } = trimCompactInputForBudget([hugeText], 20);
    expect(trimmedCount).toBe(0);
    expect(input[0]).toEqual(hugeText);
  });

  it("★ 已知不精确性：多字节内容按字符切，真实字节数会超过 perOutputByteLimit——这是可接受的，因为下游必须重新真实测量，不能依赖这里的裁剪结果直接判断是否达标", () => {
    // "中" 在 UTF-8 下 3 字节/字，但 JS 字符串 slice 按 UTF-16 code unit
    // （对这个字符等价于"按字符"）切，不按字节切。perOutputByteLimit=10
    // 时，.slice(0, 10) 切出 10 个"中"字，真实字节数是 30，远超限制 10。
    const output = "中".repeat(20); // 60 真实字节
    const perOutputByteLimit = 10;
    const { input, trimmedCount } = trimCompactInputForBudget(
      [functionCallOutput("c1", output)],
      perOutputByteLimit,
    );
    expect(trimmedCount).toBe(1);
    const trimmedItem = input[0] as Extract<CodexInputItem, { type: "function_call_output" }>;
    const realBytes = Buffer.byteLength(trimmedItem.output, "utf8");
    // 决定性断言：真实字节数确实超过了名义上的限制——这不是要修的 bug，
    // 是要固定住的已知行为。
    expect(realBytes).toBeGreaterThan(perOutputByteLimit);

    // 安全性来自下游重新测量，不是这里的裁剪假设：summarizeCompactInputBytes
    // 内部用 Buffer.byteLength 对裁剪后的真实内容重新计数，得到的必须精确
    // 等于这里独立算出的真实字节数，而不是某个基于"应该省了多少"的估算值。
    const { totalBytes } = summarizeCompactInputBytes(input);
    const expectedTotal = Buffer.byteLength(JSON.stringify(input[0]), "utf8");
    expect(totalBytes).toBe(expectedTotal);
  });
});

describe("planCompactRequestForBudget", () => {
  function buildRequest(overrides: Partial<CodexCompactRequest> = {}): CodexCompactRequest {
    return {
      model: "some-uncalibrated-model", // 预算 260000 token（全表最小值，见上面 resolveCompactTokenBudget 的测试）
      input: [],
      instructions: "",
      ...overrides,
    };
  }

  it("预算内：原样放行，不裁剪，不触发分词器懒加载（cheap 粗筛已经够用）", async () => {
    const request = buildRequest({
      input: [{ role: "user", content: "hello, this is a small compact input" }],
    });
    const plan = await planCompactRequestForBudget(request);

    expect(plan.withinBudget).toBe(true);
    expect(plan.trimmedCount).toBe(0);
    expect(plan.budgetTokens).toBe(260_000);
    expect(plan.compactRequest).toBe(request); // 预算内不重新构造对象
    expect(plan.estimateMethod).toBe("cheap");
    // ★ 懒加载的核心断言：粗筛已经在预算内，不该为了"确认"再付分词器
    // 加载/调用的成本。
    expect(mockTokenizeCompactContent).not.toHaveBeenCalled();
  });

  it("超预算但裁剪能救回来：trimmedCount>0 且最终 withinBudget:true，走了精确估算（estimateMethod=tokenizer）", async () => {
    // mock 比例 4 chars/token：预算 260000 token → 阈值约 1,040,000 字符。
    // 用 1,200,000 字节确保裁剪前 cheap 和精确估算都判超限，裁到默认
    // 10000 字节（测试环境没有加载模型目录，getModelInfo 返回 undefined，
    // 退回默认值）之后应该远远落回预算内。
    const request = buildRequest({
      input: [functionCallOutput("c1", "a".repeat(1_200_000))],
    });
    const plan = await planCompactRequestForBudget(request);

    expect(plan.trimmedCount).toBe(1);
    expect(plan.withinBudget).toBe(true);
    expect(plan.estimatedTokens).toBeLessThan(plan.budgetTokens);
    expect(plan.estimateMethod).toBe("tokenizer");
    // 粗筛怀疑超限后才应该触发分词器——确实被调用了。
    expect(mockTokenizeCompactContent).toHaveBeenCalled();
    // 裁剪确实发生了：返回的是新对象，且 input 内容比原始的短得多。
    expect(plan.compactRequest).not.toBe(request);
    const trimmedItem = plan.compactRequest.input[0] as Extract<
      CodexInputItem,
      { type: "function_call_output" }
    >;
    expect(trimmedItem.output.length).toBeLessThan(1_200_000);
  });

  it("★ 超预算且裁剪救不回来（不可裁剪的巨大纯文本，模拟图片会话那类不可裁剪的形状）：必须诚实返回 withinBudget:false，不能乐观放行", async () => {
    // 同上：1,200,000 字节的纯文本消息（不是 function_call_output）——trim
    // 完全不 touch 这种形状，裁剪前后体积不变，精确估算应该仍然远超预算。
    const request = buildRequest({
      input: [{ role: "user", content: "x".repeat(1_200_000) }],
    });
    const plan = await planCompactRequestForBudget(request);

    expect(plan.trimmedCount).toBe(0); // 裁剪确实"裁不动"这种形状
    expect(plan.withinBudget).toBe(false);
    expect(plan.estimatedTokens).toBeGreaterThan(plan.budgetTokens);
    expect(plan.estimateMethod).toBe("tokenizer");
  });

  it("tools 计入预算估算，不能只统计 input——否则会系统性低估真实发送体积", async () => {
    // input 本身很小；tools 单独就有约 1,200,000 字节，足够单独把精确估算
    // 也推过预算。
    const request = buildRequest({
      input: [{ role: "user", content: "tiny" }],
      tools: [{ description: "x".repeat(1_200_000) }],
    });
    const plan = await planCompactRequestForBudget(request);

    expect(plan.withinBudget).toBe(false);
    expect(plan.estimatedTokens).toBeGreaterThan(plan.budgetTokens);
  });

  it("★ 8.11：含图片内容时强制退回 cheap 估算，不把 base64 喂给分词器——即便粗筛怀疑超限", async () => {
    // 图片 + 一段不算特别大的文本，cheap 粗筛会因为 base64 字节数偏大而
    // 判定超限（这是刻意保留的保守行为，见 compactRequestHasImageContent
    // 文档），但不应该触发分词器调用。
    const request = buildRequest({
      input: [{
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(1_200_000)}` },
        ],
      }],
    });
    const plan = await planCompactRequestForBudget(request);

    expect(plan.estimateMethod).toBe("cheap");
    expect(mockTokenizeCompactContent).not.toHaveBeenCalled();
  });
});
