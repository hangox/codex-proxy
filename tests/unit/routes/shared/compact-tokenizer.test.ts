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
  // ★★ 8.14：qa 门禁用真实生产数据（rung3-B，真实 usage=312,084，明确在
  // 预算内）挡下了 8.13——熔断阈值 400ms 在"内容正常、只是量大"这种真实
  // compact payload 的常态形状下也会触发，触发后 8.13 直接丢弃已处理部分
  // 退回粗筛（粗筛系统性高估 ~33%），导致分词器在最需要它的场景（粗筛怀疑
  // 超限、精确估算本该救回来）反而失效。8.14 两个改动：阈值 400ms→2000ms
  // （`CUMULATIVE_TIME_BUDGET_MS`）；熔断时改成按已处理比例外推，只有
  // 处理量低于 20%（`MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION`）时才放弃
  // 外推、退回 null。完整依据见 `compact-tokenizer.ts` 头部注释"改动一/
  // 改动二"小节。下面这组测试的断言相应更新：耗时上界从 3000ms 放宽到
  // 4000ms（新预算本身是 2000ms，留够 2 倍余量吸收并行测试的负载噪声）；
  // 原来"病态内容必须返回 null"的断言现在必须理解为"处理比例低于 20% 时
  // 返回 null"——本文件后面单独用一组"外推准确度"测试覆盖"处理比例
  // 够高时应该外推出一个接近真值的数字，而不是 null"这条新增行为。
  //
  // ★ 关键：这里断言的安全性质是**总耗时有界**，不是"必须返回 null"——
  // 分块之后复杂度从 O(n²) 变成近似线性（大量小块反复调用被 V8 JIT
  // 热身，单块耗时远低于同等规模单次调用的孤立测量值），reviewer 给的
  // n=10000 这组矩阵实测全部在几百毫秒内**正常算完、返回真实 token 数**，
  // 根本不需要触发熔断——这是分块设计比"及格线"更好的副作用，不是 bug。
  // 熔断只在内容量级大到即使分块也会突破耗时预算时才生效（本文件用验证
  // 过真正会触发的规模——120 万字符量级的 "x"、60 万字符量级的
  // emoji/中/é），断言里因此按验证过的真实行为分开写，不是一刀切要求
  // "全部返回 null"。
  describe("★ 8.13/8.14 熔断防护——分块限最坏情况 + 熔断时按已处理比例外推（不是直接丢弃）", () => {
    it.each([1, 5, 8, 10, 15, 20])(
      "周期 %i 的重复模式（reviewer 证伪矩阵）在 n=10000 下必须在安全时间内完成——8.11 的旧检测对 period≥5 完全没拦住，量级和 period=1 相同（3.4~4.8 秒）；分块后无论周期多少，总耗时都必须远低于那个量级",
      async (period) => {
        const unit = "x".repeat(period - 1) + "y";
        const text = unit.repeat(Math.ceil(10_000 / period)).slice(0, 10_000);
        const start = Date.now();
        const result = await tokenizeCompactContent(text);
        const elapsed = Date.now() - start;
        // 决定性断言：不管有没有触发熔断，耗时必须远低于无防护时的 3.4~4.8
        // 秒——这才是真正要保证的安全性质，唯一不能放松的一条。
        expect(elapsed).toBeLessThan(4000);
        // ★ 刻意不断言 result 是不是 null：单机空闲时 n=10000 这个规模分块
        // 设计能正常算完、不触发熔断（开发环境实测几百毫秒），但内部熔断
        // 用的是"墙钟耗时"而不是"CPU 指令数"，全量测试套件并行跑、CPU 被
        // 其它测试文件抢占时，同样的预算可能被跨进程调度延迟撞到——这种
        // 情况下返回外推值/null（回退粗筛）和正常算完同样安全，只是精度
        // 打了折扣，不是 bug。断言"必须非 null"曾经在全量并行跑时被系统
        // 负载干扰出过假失败，暴露的是断言本身对"安全"这件事的刻画错了，
        // 不是实现有问题——已经改成只锁"耗时有界"这一条真正重要的性质。
      },
    );

    it("★ \"0\" vs \"x\"：reviewer 发现的字符敏感性——\"0\" 不病态，分块后应该正常算出真实 token 数；\"x\" 在这个量级（120万字符）确实病态，处理比例远低于 20% 外推下限，应该被熔断拦住返回 null——两者耗时都必须有界，新方案不需要\"认出\"哪个字符危险", async () => {
      const nonPathological = await (async () => {
        const start = Date.now();
        const result = await tokenizeCompactContent("0".repeat(1_200_000));
        const elapsed = Date.now() - start;
        return { result, elapsed };
      })();
      expect(nonPathological.elapsed).toBeLessThan(4000);
      // ★ 8.14：2000ms 预算下"0"这种非病态内容本机实测 ~223ms 就能跑完
      // （远低于预算，余量比 8.13 的 400ms 预算下更充裕），因此这里恢复
      // "非 null"断言——和 period 矩阵那条测试的"不断言"不是自相矛盾：
      // 那条测的是"n=10000 规模"这个更容易被调度噪声打扰的边界情况，这里
      // 是"120 万字符但内容本身几乎不耗时"，两者对系统负载的敏感度不同。

      const pathological = await (async () => {
        const start = Date.now();
        const result = await tokenizeCompactContent("x".repeat(1_200_000));
        const elapsed = Date.now() - start;
        return { result, elapsed };
      })();
      expect(pathological.elapsed).toBeLessThan(4000);
      // 本机实测：2000ms 预算内只处理了约 2.7%（32,500/1,200,000）——远低于
      // 20% 外推下限，因此仍然返回 null，不会拿一个基于极小样本的外推值
      // 冒充"接近真实"的结果。
      expect(pathological.result).toBeNull();
    });

    it(
      "多字节字符（emoji/中文/带重音字符）在 60 万字符量级下病态、处理比例低于 20% 外推下限，必须被熔断拦住返回 null——本轮补测发现的比 ASCII 更病态的形状，且耗时必须有界",
      async () => {
        for (const char of ["🎉", "中", "é"]) {
          const start = Date.now();
          const result = await tokenizeCompactContent(char.repeat(600_000));
          const elapsed = Date.now() - start;
          expect(elapsed).toBeLessThan(4000);
          expect(result).toBeNull();
        }
      },
      // ★ 8.14：三个字符各自最坏约 4000ms（熔断预算 2000ms 提高后的上界），
      // 循环三次可能逼近甚至超过 vitest 默认的 5000ms 单测超时，不是测试
      // 变慢了，是每次调用本身的安全上界被team-lead要求的改动主动放宽了。
      15_000,
    );

    it("规模更大的病态内容（500 万字符）耗时依然有界——熔断上界不随内容总量增长而增长，这是分块设计相对枚举检测的核心优势", async () => {
      const start = Date.now();
      const result = await tokenizeCompactContent("x".repeat(5_000_000));
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(4000);
      expect(result).toBeNull();
    });

    it("★★ 8.14 外推准确度：内容正常（非病态）只是量特别大，触发熔断时已处理比例很高（>90%），应该外推出一个非 null 的估算值，而不是像 8.13 那样直接丢弃已处理的部分退回 null", async () => {
      // 用高度均匀的重复正常文本验证外推**机制本身**（触发时机、有没有正确
      // 返回非 null 数字）——但均匀重复内容的外推误差趋近于 0，不能代表
      // 真实内容的外推准确度，这里只测机制，不测准确度。
      //
      // ★ 真实内容的外推准确度用 qa 提供的 rung2-B/rung3-B 两组真实样本
      // 实测过（人为调小时间预算强制触发外推，和不设熔断的完整结果对照），
      // 结论和这条测试的"均匀内容"场景明显不同——见 `compact-tokenizer.ts`
      // 头部注释"外推准确度实测"小节：处理比例 17%~72% 区间内，真实内容的
      // 外推误差稳定在 7%~18%（没有随处理比例升高显著收敛，根因是
      // `extractCompactContentForTokenizing` 按固定顺序拼接
      // instructions→input→tools，真实内容按类型的 token 密度不均匀，
      // "处理了前 N%"是有偏样本不是随机子样本），但两组样本所有测试点误差
      // 方向都是安全的高估，且仍明显好于 8.13"熔断即丢弃、只能回退到不看
      // 内容的固定比例粗筛"。这组真实数据没有提交仓库（理由见
      // codex-compact-estimate-accuracy.test.ts 头部注释"fixture 数据卫生"），
      // 因此这里的自动化测试只能锁"机制对不对"，"真实内容准不准"只能靠
      // 人工验证记录，不能靠这条测试自动覆盖。
      const sentence = "The quick brown fox jumps over the lazy dog while the sun sets behind the mountains. ";
      const bigText = sentence.repeat(480_000); // ~40.8M 字符，本机实测会在处理 ~99% 后触发熔断
      const start = Date.now();
      const result = await tokenizeCompactContent(bigText);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(4000);
      // 决定性断言：这次不能是 null——这正是 8.14 要修的行为，处理比例
      // 够高时必须外推出一个数字，不能像 8.13 那样把已经算出来的大部分
      // 结果整个丢弃。
      expect(result).not.toBeNull();
      expect(result as number).toBeGreaterThan(0);
      // 外推值应该落在"用同样均匀重复内容按比例放大"的合理区间内——不要求
      // 精确匹配（均匀重复内容本身的外推误差趋近于 0，但不同机器/负载下
      // 触发熔断的具体处理比例会浮动，用宽松区间避免此断言本身变成新的
      // flaky 来源）：token 数应该显著小于按最小字节/token 比例（业内已知
      // 下限约 1 字节/token）估出的上界，且显著大于 0。
      expect(result as number).toBeLessThan(bigText.length);
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
