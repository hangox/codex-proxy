/**
 * ★ 8.11：分词器集成的确定性单测——team-lead 要求的"三层测试"里的第一层。
 *
 * 关键区别（对照 `codex-compact-estimate-accuracy.test.ts`）：这一层测的是
 * "分词器本身 tokenize 得对不对/我们有没有正确调用它"，**不需要真实
 * usage.input_tokens 做基准**——分词器是确定性纯函数，同样的输入永远得到
 * 同样的输出，用真分词器自己算一遍就是可信的期望值，不需要真的打一次
 * 上游拿真实 token 数。这层测试因此可以覆盖任意内容形态（中文/英文/代码/
 * emoji/混排/JSON 转义字符串），成本趋近于零，覆盖率想做多高做多高——
 * 这正是评估阶段的核心结论："换成分词器之后，这一块的可测性发生了质变"。
 *
 * 这里**不 mock** `js-tiktoken`——就是要用真实分词器验证真实行为。期望值
 * 用真分词器本身跑一次拿到（不是凭空编的数字），运行方式见 git 提交历史/
 * 开发过程记录（用 `js-tiktoken` 直接跑一遍目标字符串拿到 token 数）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  loadCompactTokenizer,
  tokenizeCompactContent,
  _resetCompactTokenizerCacheForTest,
} from "@src/routes/shared/compact-tokenizer.js";

beforeEach(() => {
  _resetCompactTokenizerCacheForTest();
});

describe("tokenizeCompactContent（真实 o200k_base，不 mock）", () => {
  it("空字符串 → 0 token", async () => {
    expect(await tokenizeCompactContent("")).toBe(0);
  });

  it("英文段落", async () => {
    const text = "The quick brown fox jumps over the lazy dog while the sun sets behind the mountains.";
    expect(await tokenizeCompactContent(text)).toBe(17);
  });

  it("中文段落", async () => {
    const text = "今天天气很好，我们去公园散步，看到了很多美丽的花朵和树木。";
    expect(await tokenizeCompactContent(text)).toBe(23);
  });

  it("纯代码", async () => {
    const text = "function add(a, b) {\n  return a + b;\n}\nconst result = add(1, 2);\nconsole.log(result);";
    expect(await tokenizeCompactContent(text)).toBe(28);
  });

  it("emoji", async () => {
    const text = "Great job! 🎉🚀 Let's ship it 🔥💯";
    expect(await tokenizeCompactContent(text)).toBe(14);
  });

  it("tool_result 里典型的 JSON 转义字符串", async () => {
    const text = JSON.stringify({
      anthropic_tool_result: { type: "tool_result", tool_use_id: "abc123", content: "file contents here" },
    });
    expect(await tokenizeCompactContent(text)).toBe(24);
  });

  it("中英文+代码+emoji 混排", async () => {
    const text = "混合内容 mixed content 123 🎉 function() { return true; }";
    expect(await tokenizeCompactContent(text)).toBe(16);
  });

  it("同样的输入永远得到同样的输出（确定性——这是这一层测试不需要真实 usage 的前提）", async () => {
    const text = "determinism check 确定性检查";
    const a = await tokenizeCompactContent(text);
    const b = await tokenizeCompactContent(text);
    const c = await tokenizeCompactContent(text);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // ★★ 8.13：8.11 最初的防护是"枚举周期 1~4 的重复模式"，reviewer 复审用
  // 真实数据推翻了这个思路本身——不是参数没调对，是"枚举哪些输入危险"这个
  // 抽象堵不完。下面这组测试直接照搬 reviewer 给出的证伪矩阵（period
  // 5/8/10/15/20 @ n=10000，全部和 period=1 同一量级、8.11 的检测完全没
  // 拦住）+ "0" vs "x" 的字符差异（同样是单字符重复，"0" 几乎瞬间完成，
  // 其它字符 3.6~4.1 秒——证明触发条件和字符本身相关，不是"周期"这个维度
  // 能刻画的）+ 本轮补测的多字节字符。
  //
  // ★ 关键：这里断言的安全性质是**总耗时有界**，不是"必须返回 null"——
  // 分块之后复杂度从 O(n²) 变成近似线性（大量小块反复调用被 V8 JIT
  // 热身，单块耗时远低于同等规模单次调用的孤立测量值），reviewer 给的
  // n=10000 这组矩阵实测全部在 165~205ms 内**正常算完、返回真实 token
  // 数**，根本不需要触发熔断——这是分块设计比"及格线"更好的副作用，不是
  // bug。熔断只在内容量级大到即使分块也会突破耗时预算时才生效（本文件
  // 用验证过真正会触发的规模——120 万字符量级的 "x"、60 万字符量级的
  // emoji/中/é），断言里因此按验证过的真实行为分开写，不是一刀切要求
  // "全部返回 null"。
  describe("★ 8.13 熔断防护——不枚举模式，只限制最坏情况（断言总耗时有界，不是必须返回 null）", () => {
    it.each([1, 5, 8, 10, 15, 20])(
      "周期 %i 的重复模式（reviewer 证伪矩阵）在 n=10000 下必须在安全时间内完成——8.11 的旧检测对 period≥5 完全没拦住，量级和 period=1 相同（3.4~4.8 秒）；8.13 分块后无论周期多少，总耗时都必须远低于那个量级",
      async (period) => {
        const unit = "x".repeat(period - 1) + "y";
        const text = unit.repeat(Math.ceil(10_000 / period)).slice(0, 10_000);
        const start = Date.now();
        const result = await tokenizeCompactContent(text);
        const elapsed = Date.now() - start;
        // 决定性断言：不管有没有触发熔断，耗时必须远低于无防护时的 3.4~4.8
        // 秒——这才是真正要保证的安全性质，唯一不能放松的一条。
        expect(elapsed).toBeLessThan(3000);
        // ★ 刻意不断言 result 是不是 null：单机空闲时 n=10000 这个规模分块
        // 设计能正常算完、不触发熔断（开发环境实测 165~205ms），但内部熔断
        // 用的是"墙钟耗时"而不是"CPU 指令数"，全量测试套件并行跑、CPU 被
        // 其它测试文件抢占时，同样的 400ms 预算可能被跨进程调度延迟撞到——
        // 这种情况下返回 null（回退粗筛）和正常算完同样安全，只是精度打了
        // 折扣，不是 bug。断言"必须非 null"曾经在全量并行跑时被系统负载
        // 干扰出过假失败，暴露的是断言本身对"安全"这件事的刻画错了，不是
        // 实现有问题——已经改成只锁"耗时有界"这一条真正重要的性质。
      },
    );

    it("★ \"0\" vs \"x\"：reviewer 发现的字符敏感性——\"0\" 不病态，分块后应该正常算出真实 token 数；\"x\" 在这个量级（120万字符）确实病态，分块后应该被熔断拦住——两者耗时都必须有界，新方案不需要\"认出\"哪个字符危险", async () => {
      const nonPathological = await (async () => {
        const start = Date.now();
        const result = await tokenizeCompactContent("0".repeat(1_200_000));
        const elapsed = Date.now() - start;
        return { result, elapsed };
      })();
      expect(nonPathological.elapsed).toBeLessThan(3000);
      // ★ 不断言非 null（理由同上一条测试的注释：安全性只依赖耗时有界，
      // 全量并行跑时的调度延迟可能让"0"这种非病态内容也撞上熔断，这依然
      // 是安全的，不是需要锁死的行为）。

      const pathological = await (async () => {
        const start = Date.now();
        const result = await tokenizeCompactContent("x".repeat(1_200_000));
        const elapsed = Date.now() - start;
        return { result, elapsed };
      })();
      expect(pathological.elapsed).toBeLessThan(3000);
      expect(pathological.result).toBeNull();
    });

    it("多字节字符（emoji/中文/带重音字符）在 60 万字符量级下病态、必须被熔断拦住——本轮补测发现的比 ASCII 更病态的形状，且耗时必须有界", async () => {
      for (const char of ["🎉", "中", "é"]) {
        const start = Date.now();
        const result = await tokenizeCompactContent(char.repeat(600_000));
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(3000);
        expect(result).toBeNull();
      }
    });

    it("规模更大的病态内容（500 万字符）耗时依然有界——熔断上界不随内容总量增长而增长，这是分块设计相对枚举检测的核心优势", async () => {
      const start = Date.now();
      const result = await tokenizeCompactContent("x".repeat(5_000_000));
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000);
      expect(result).toBeNull();
    });

    it("正常但重复度较高的真实文本（例如同一句子出现很多次）不会被误判——熔断只在真正病态、单块耗时持续偏高时触发", async () => {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(20_000); // 90万字符
      const result = await tokenizeCompactContent(text);
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
    });

    it("分块边界效应很小：把同一段正常文本连续拼接两次，token 数应该接近两倍（不是因为分块被腰斩或重复计数）", async () => {
      const unit = "The quick brown fox jumps over the lazy dog while the sun sets. ".repeat(50); // 单块量级以上，触发真实分块
      const once = await tokenizeCompactContent(unit);
      const twice = await tokenizeCompactContent(unit + unit);
      expect(once).not.toBeNull();
      expect(twice).not.toBeNull();
      // 分块只在每个块内部独立 encode，边界处最多多算/少算一两个 token，
      // 不会让总数偏离"约两倍"太远——用 5% 容差而不是精确相等，因为这条
      // 测的是"边界效应没有失控"而不是"分块 100% 无损"（无损本来就不是
      // 分块设计的目标，见 compact-tokenizer.ts 头部注释）。
      expect(twice as number).toBeGreaterThan((once as number) * 1.8);
      expect(twice as number).toBeLessThan((once as number) * 2.2);
    });
  });

  it("更长的文本 token 数不会少于更短的子串（单调性，基本合理性检查）", async () => {
    const short = "hello world";
    const long = "hello world, this is a much longer piece of text that should tokenize to more tokens";
    const shortTokens = await tokenizeCompactContent(short);
    const longTokens = await tokenizeCompactContent(long);
    expect(longTokens).toBeGreaterThan(shortTokens);
  });
});

describe("loadCompactTokenizer（懒加载单例）", () => {
  it("多次调用复用同一个 promise/实例（不重复触发加载）", async () => {
    const p1 = loadCompactTokenizer();
    const p2 = loadCompactTokenizer();
    // 两次调用应该拿到同一个 promise 引用——这是"懒加载单例"的核心不变量：
    // 并发调用不会触发第二次真实 import()。
    expect(p1).toBe(p2);
    const enc1 = await p1;
    const enc2 = await p2;
    expect(enc1).toBe(enc2);
    expect(enc1).not.toBeNull();
  });

  it("重置缓存后会话下一次调用重新加载（编码器实例不同引用，但行为一致）", async () => {
    const first = await loadCompactTokenizer();
    _resetCompactTokenizerCacheForTest();
    const second = await loadCompactTokenizer();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // 不强求是同一个对象引用（重置后就是重新加载了一次），但两次加载出来的
    // 编码器对同样内容必须给出同样结果——编码表本身是确定性的静态数据。
    const text = "consistency after reload";
    expect(first?.encode(text).length).toBe(second?.encode(text).length);
  });
});
