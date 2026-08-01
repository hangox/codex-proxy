/**
 * ★ 8.11：compact 预算预判的精确 token 计算——真分词器，懒加载。
 *
 * 起因：`COMPACT_BYTES_PER_TOKEN_ESTIMATE` 这套"字节除以一个数"的估算法
 * 连续踩过两次坑（2.18 高估 65%、"修正"后的 2.70 仍然高估 10~41%），根因是
 * 固定比例这个模型本身就不对——真实 chars/token 因内容成分（中文/英文/
 * 代码/base64）而异，波动区间宽到没有一个常数能同时拟合。评估阶段
 * （team-lead 批准的方案）用 4 组真实样本验证过：换成真分词器 + 语义内容
 * 抽取 + 每 item 固定结构开销，误差能从 10~41% 收窄到 <1.5%。
 *
 * ★★ 为什么不能直接 `encoder.encode(JSON.stringify(compactRequest))`——
 * 评估阶段踩过的坑，必须写在这里，否则后人会把这段"绕一圈"的代码"优化"
 * 成直接 tokenize，然后误差静默从 <1.5% 劣化回 8~16%（比 2.70 那套改进后
 * 的 10~41% 好一点，但仍然远达不到"值得引入分词器依赖"这个门槛）：
 *
 *   直接 tokenize JSON.stringify(body)：8.34% / 13.46% / 13.80% / 15.84%
 *   只 tokenize 语义内容 + 每 item 固定开销：0.02% / -0.02% / -0.23% / 0.00%
 *
 * 原因：JSON 语法本身（引号、花括号、`"type":"function_call_output"`
 * 这类字段名）会被当成内容 token 化，而真实上游大概率是把结构化 input
 * 转成自己的模板/分隔符表示，不是逐字节 tokenize 我们发的 JSON 文本。
 * `extractCompactContentForTokenizing`（`codex-compact-service.ts`）负责
 * 把语义内容和 JSON 包装分开，这个文件只负责"给一段纯文本，算出真实
 * token 数"，不做内容抽取——职责边界见下方函数文档。
 *
 * ★ 为什么是 js-tiktoken（纯 JS）不是 tiktoken（WASM）——评估阶段实测：
 *
 *   | | 体积（含 o200k_base 编码表） | 真实 ~1MB payload 耗时 |
 *   |---|---|---|
 *   | js-tiktoken（纯 JS） | ~2.3MB | 432~544ms |
 *   | tiktoken（WASM） | ~7.9MB（多一层 5.6MB 的通用 BPE 引擎） | 137~160ms |
 *
 * WASM 版快 3 倍，但体积是纯 JS 版的 3.4 倍——两者耗时都在"几百毫秒可接受"
 * 范围内（compact 不是热路径，一次会话一次），速度优势换不回桌面版
 * 打包多出来的 ~5.6MB，也少一类 Electron 打包 WASM 的麻烦。
 *
 * ★ 为什么是 o200k_base 不是 cl100k_base——评估阶段实测确认，不是照着
 * "应该是 GPT-4o 那套"猜的：同一份"语义内容+每item固定开销"模型换成
 * cl100k_base 测，误差从 <0.5% 恶化到 4.31%~6.80%，o200k_base 明显更准。
 *
 * 懒加载：`loadCompactTokenizer()` 只在真正被调用时才 `import()` 编码表
 * （~2.3MB），且用 promise 缓存成进程级单例——只有第一次真正需要精确估算
 * 的请求会付一次性加载成本（~200ms，主要是从原始 rank 数据构建内部哈希表），
 * 之后同一进程内的调用直接复用。调用方（`planCompactRequestForBudget`）
 * 只在"字节比例粗筛怀疑超限"时才会走到这里——正常大小的会话永远不会
 * 触发这次加载，见 `codex-compact-service.ts` 里粗筛短路的注释。
 *
 * 加载失败（理论上不该发生，防御性处理）时返回 `null`，调用方必须回退到
 * 粗筛比例估算，不能让整个 compact 请求因为分词器加载失败而报错——分词器
 * 只是让估算更准，不是这条链路能不能工作的前提。
 */

import type { Tiktoken } from "js-tiktoken/lite";

/**
 * ★★ 8.11/8.13/8.14：`js-tiktoken` 对"高度重复内容"有灾难级的病态性能，实现
 * 阶段实测发现，不是评估阶段的已知风险——**必须在这里挡住，否则这条估算
 * 路径本身就是一个可以把整个 Node 事件循环卡死的 DoS 面**（同步调用，
 * 单线程 Node 会话内所有并发请求一起卡死，不是"这次估算变慢"）。
 *
 * ★ 8.13：8.11 最初的防护是"枚举哪些输入病态"（检测周期 1~4 的重复
 * 游程）——reviewer 复审时用真实数据推翻了这个思路本身，不只是参数没调对：
 *
 *   - 周期 5~20 的重复（`x`+4个其它字符循环）在 n=10000 下同样是
 *     3.4~4.8 秒量级，和周期 1 同一数量级，8.11 的检测**完全没拦住**。
 *   - 更关键的是：同样"单字符重复"，`"0"` 在 n=10000 下**几乎瞬间完成**，
 *     但 `"x"`/`"a"`/`" "`/`"-"`/`"."` 都是 3.6~4.1 秒——**触发条件和 BPE
 *     内部合并次数相关，不是"重复周期长度"这个维度能完整刻画的**。
 *   - 本轮补测进一步发现：多字节字符更糟——emoji（🎉）在 n=2000（UTF-16
 *     长度 4000）下要 1911ms，同等 UTF-16 长度下比 ASCII 重复慢 10 倍以上；
 *     中文（中）、带重音字符（é）同样明显更慢。
 *
 *   结论：**"枚举哪些输入会触发"这个抽象本身是错的，堵不完**——不存在
 *   一个"检测这些模式就够了"的清单，因为我们对 BPE 内部什么时候会退化
 *   还没有完整的理论刻画，只有实测出来的一个个孤立数据点。继续按"发现
 *   新病态模式→加进检测清单"这个方向修，本质上是在打地鼠。
 *
 * ★ 8.13 改用的策略：**不枚举"哪些输入危险"，而是限制"最坏情况能有多
 * 坏"**——分块 encode + 块间累计耗时熔断。这个策略对"什么样的内容触发
 * 病态"完全不敏感，不需要理解 BPE 行为，因为最坏情况的时间上界只取决于
 * **块大小**（一个固定、可控的量），不取决于块里装的是什么内容。
 *
 * ★★ 8.14：8.13 上线前 qa 门禁用真实生产数据挡了下来——**分词器恰好在
 * 最需要它的场景失效了**。真实会话 rung3-B（真实 `usage.input_tokens=
 * 312,084`，明确低于 gpt-5.6-sol 预算 390,000，本该成功）触发熔断：
 *
 *   `[CompactTokenizer] chunked encode exceeded 400ms (processed
 *   691500/932680 chars)` → 回退粗筛 → `estimatedTokens=426472`
 *   （粗筛系统性高估 ~33%，见 `COMPACT_BYTES_PER_TOKEN_ESTIMATE` 头部
 *   注释）→ `withinBudget=false` → **本该成功的会话被误判超限降级**。
 *
 * 另一组真实样本 rung2-B 同样撞熔断，只是回退后的粗筛值（385,252）刚好
 * 压线放行——**那是运气，不是设计**。排除了"容器慢"：同等 900,030 字符的
 * 普通英文散文在同一容器 327ms 跑完，是**真实语义内容本身**（工具调用
 * 参数/输出、代码、中英混排——真实 compact payload 的常态形状，不是边角
 * 构造）比合成测试用的散文更接近 8.13 那版判定为"病态"的边界。
 *
 * 根因：8.13 版把"熔断触发"等同于"内容病态、精确估算不可信"，两者被
 * 一个 400ms 阈值捆在一起，但真实数据证明**内容正常、只是量大**同样会
 * 在 400ms 内跑不完——分词器因此在"粗筛怀疑超限、最需要精确估算兜底"
 * 这个区间里恰好最容易触发熔断，反而帮不上忙：
 *
 *   内容小 → cheap 就够，精确路径不触发 → 分词器没用上
 *   内容接近预算边界 → 触发精确路径 → 但撞熔断 → 退回 cheap → 还是误判
 *
 * 8.14 用两个独立改动分别修这两层问题：
 *
 * **改动一：熔断阈值 400ms → `CUMULATIVE_TIME_BUDGET_MS = 2000`。**
 * 依据——真实 rung3-B 全量处理需要的时间量级（1037ms，含熔断开销）明显
 * 超过 400ms 但明显低于 2000ms，2000ms 留出约 2 倍余量吸收负载波动；
 * 代价是最坏情况同步阻塞时间从 ~525ms 升到 ~2125ms（见下面块大小小节的
 * 上界推导）。这笔交易划算：compact 不是热路径（一次会话一次），2 秒
 * 阻塞远小于"误判降级导致用户等 14 分钟全量生成"（v2.0.88 那次真实生产
 * 事故，`rid=39587bd5` 那组）的代价。
 *
 * **改动二（比调阈值更关键）：熔断时不再无条件丢弃已处理部分，改成按
 * 已处理比例外推。** 8.13 版熔断触发时直接返回 `null`，哪怕已经处理了
 * 74%的内容（rung3-B 那次：691500/932680）——这些结果被整个丢弃，退回
 * 一个高估 33% 的粗估，纯粹浪费。8.14 改成：
 *
 *   已处理 N 字符、算出 T token，总长 M 字符
 *   若 N/M ≥ `MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION`（20%）：
 *     外推总量 ≈ ceil(T × M / N)，返回外推值（非 null）
 *   否则（处理量太少，外推不可信）：
 *     返回 null，退回粗筛兜底——和分词器加载失败/含图片时同一条路径
 *
 * 依据：真实 compact payload 内部的内容特征（语言、工具调用密度、代码
 * 占比）在一份 payload 内大体均匀分布，不会突然从"正常"切换到"极端病态"
 * ——处理了大部分内容后外推，精度应当远好于对整个 payload 一无所知的
 * 粗筛比例估算。20% 下限的作用是防止另一个极端：真正病态的内容可能
 * 在处理了很少一部分（比如 5%）就把预算耗尽，这时候外推的样本量太小，
 * 外推出来的数字不可信，不如直接承认"分词器在这次没帮上忙"、退回粗筛。
 *
 * 外推准确度实测（qa 提供的真实样本 rung2-B/rung3-B，直接调
 * `planCompactRequestForBudget` 复验）——**两条分开报告，不能混为一谈**：
 *
 * 1. 触发 rung3-B 误判的根本原因是 400ms 预算太小，不是外推准不准的问题。
 *    2000ms 预算本身就已经让这两组真实内容（语义内容分别约 85.2 万/93.3
 *    万字符）在正常负载下**完整跑完、根本不触发熔断**——实测 wallMs
 *    611~634ms，`withinBudget` 都恢复成 `true`，精确估算与真实
 *    `usage.input_tokens` 的误差回到评估阶段确认过的 <0.3% 量级（rung3-B：
 *    估算/1.03 后仅比真实值多 29 token，即 0.0093%）。**改动一（调阈值）
 *    单独就足以修好这两个真实失败案例，外推压根没被用上。**
 * 2. 为了弄清楚"外推真的准不准"这个独立问题，额外用人为调小的时间预算
 *    强制触发外推、和不设熔断的完整结果对照，测出真实曲线：处理比例
 *    17%~72% 之间，外推误差稳定在 **7%~18%**（两组样本、多个预算点都在
 *    这个区间，没有随处理比例升高显著收敛）——**比最初用均匀重复内容测出
 *    的"接近 0 误差"差得多**，根因是 `extractCompactContentForTokenizing`
 *    按固定顺序拼接内容（`instructions` → `input` 逐条 → `tools` 整体拼在
 *    最后，`tools` 固定约 101KB），真实内容的 token 密度按内容类型分布
 *    不均匀，"处理了前 N%"因此是一个有偏样本，不是随机子样本，线性外推
 *    "这段内容后面应该长得和前面差不多"这个假设对真实数据不如对均匀构造
 *    数据成立。**好消息**：两组样本、所有测试预算点，外推值全部是高估
 *    （方向安全，不会漏判该拦的请求），量级远小于误判到相反方向的风险，
 *    也仍然明显好于 8.13 那版"熔断=直接丢弃、只能回退粗筛"的做法（本身
 *    也是有偏的固定比例估算，且不看内容）。**结论**：外推是"总比直接丢弃
 *    强"的兜底手段，不是"接近真实"的精确估算——只有在改动一（2000ms
 *    预算）本身还不够用、真的触发熔断时才会用到它，这次两组真实失败样本
 *    实测都没有用到这条路径。
 *
 * 实现：把待 tokenize 的文本切成固定大小的块（`CHUNK_SIZE_CHARS`，按
 * UTF-16 code unit 切，可能切开一个 surrogate pair——已验证 `js-tiktoken`
 * 对孤立 surrogate 不会抛错，只是把它当一个"无法识别的字符"处理，边界处
 * 最多多算 1~2 个 token，见下面"分块对准确度的影响"），逐块 encode，每块
 * 结束后检查累计耗时，超过 `CUMULATIVE_TIME_BUDGET_MS` 时按上面的规则
 * 外推或放弃。
 *
 * 块大小选择依据（本机实测，覆盖到目前为止找到的最病态字符——emoji）：
 *
 *   | 字符 | UTF-16 长度 500 | 长度 1000 | 长度 2000 |
 *   |---|---|---|---|
 *   | 🎉（目前最病态） | 125ms | 501ms | 1974ms |
 *   | 中 | 85ms | 336ms | 1352ms |
 *   | é | 32ms | 127ms | 493ms |
 *   | x（8.11 最初测的） | ~16ms(n=500 ASCII) | 41ms | 158ms |
 *
 * `CHUNK_SIZE_CHARS = 500`（8.14 未变）：即使是目前实测到的最坏字符
 * （emoji），单块最坏耗时也只有 ~125ms——留了明显余量（不是卡着最坏值
 * 走），因为不排除存在比 emoji 更差的字符我们还没测到，块越小，单块
 * 最坏情况的绝对值就越低，抗未知风险的能力越强，同时也让熔断触发时
 * "已处理比例"的粒度更细，外推样本更贴近真实截止点。★ 8.14 起
 * `CUMULATIVE_TIME_BUDGET_MS = 2000`：全程最坏总耗时上界约等于
 * `CUMULATIVE_TIME_BUDGET_MS + 一个块的最坏耗时` ≈ 2000+125=2125ms，
 * 无论内容是什么形状都不会突破这个量级——**这个上界不依赖于"我们有没有
 * 见过这种病态模式"，这是它相对 8.11 那版最根本的改进，8.14 只是把这个
 * 上界从 525ms 调到 2125ms，策略本身没变**。
 *
 * 分块对准确度的影响（4 组真实样本实测，chunkSize=500，未触发熔断的
 * 完整分词场景）：多算 0.336%~0.500% 的 token（边界切断多字符 token
 * 导致的系统性高估，方向安全——见 `estimateCompactInputTokensPrecise`
 * 上面已有的 `TOKENIZER_ESTIMATE_SAFETY_MARGIN` 讨论，这点误差被那个
 * 边际吸收，不需要额外补偿）。触发熔断走外推路径时的额外误差见上面
 * "改动二"小节。
 *
 * WASM 版 `tiktoken` 同类测试下量级更好但增长速率同样劣于线性——**这不是
 * "换 WASM 就能解决"的问题，两种实现都需要这层防护**，所以这里的策略
 * 独立于具体用哪个 tiktoken 实现，不依赖"哪个实现更快"这个前提。
 */
const CHUNK_SIZE_CHARS = 500;
const CUMULATIVE_TIME_BUDGET_MS = 2000;
/**
 * 熔断触发时，已处理内容占总长度的比例低于这个下限就不外推，直接返回
 * `null` 退回粗筛——见文件头"改动二"小节。20% 是一个刻意留出较大余量的
 * 保守值：处理了 1/5 以上内容后，BPE 对这份内容的压缩率已经有足够样本
 * 支撑外推，低于这个比例（意味着极端病态、块级耗时异常高）时外推的
 * 统计意义不足，不如诚实承认"这次帮不上忙"。
 */
const MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION = 0.2;

let cachedEncoderPromise: Promise<Tiktoken | null> | null = null;

async function loadEncoderUncached(): Promise<Tiktoken | null> {
  try {
    const [{ Tiktoken }, ranksModule] = await Promise.all([
      import("js-tiktoken/lite"),
      import("js-tiktoken/ranks/o200k_base"),
    ]);
    return new Tiktoken(ranksModule.default);
  } catch (err) {
    console.warn(
      "[CompactTokenizer] failed to load o200k_base encoder, falling back to byte-ratio estimate: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/**
 * 懒加载并缓存 o200k_base 编码器实例。进程生命周期内只真正加载一次
 * （无论调用多少次、并发多少次——promise 本身就是缓存，并发调用会等同一次
 * `import()`，不会重复触发）。
 */
export function loadCompactTokenizer(): Promise<Tiktoken | null> {
  if (cachedEncoderPromise === null) {
    cachedEncoderPromise = loadEncoderUncached();
  }
  return cachedEncoderPromise;
}

/**
 * 对一段纯文本（已经抽出的语义内容，不含 JSON 包装）计算真实 token 数。
 *
 * ★ 8.13/8.14：分块 encode，块间累计耗时熔断——见文件头注释完整论证。
 * 正常内容（非病态）不会碰到熔断，几十万字符也就几百毫秒；量大或病态的
 * 内容会在 `CUMULATIVE_TIME_BUDGET_MS` 时间量级内触发熔断，全程最坏耗时
 * 上界约 `CUMULATIVE_TIME_BUDGET_MS` + 一个块的最坏耗时。
 *
 * 熔断触发时的两种结局（★ 8.14 起不再是"熔断=丢弃"）：
 * 1. 已处理比例 ≥ `MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION`：按已处理
 *    部分的 token/char 比例外推总量，返回外推值（非 null）——这是 8.14
 *    的核心改动，见文件头"改动二"小节的完整依据。
 * 2. 已处理比例太低：外推不可信，返回 `null`。
 *
 * 返回 `null` 还有一种情况：编码器加载失败（理论上不该发生）。两种
 * `null` 来源对调用方而言处理方式完全一样——回退到粗筛比例估算（见文件
 * 头注释），复用同一个出口，不需要调用方多分支处理。
 */
export async function tokenizeCompactContent(text: string): Promise<number | null> {
  const encoder = await loadCompactTokenizer();
  if (encoder === null) return null;
  if (text.length === 0) return 0;

  let totalTokens = 0;
  let processedChars = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE_CHARS) {
    const chunk = text.slice(offset, offset + CHUNK_SIZE_CHARS);
    totalTokens += encoder.encode(chunk).length;
    processedChars = offset + chunk.length;
    if (Date.now() - startedAt > CUMULATIVE_TIME_BUDGET_MS) {
      const processedFraction = processedChars / text.length;
      if (processedFraction >= MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION) {
        const extrapolated = Math.ceil(totalTokens * (text.length / processedChars));
        console.warn(
          `[CompactTokenizer] chunked encode exceeded ${CUMULATIVE_TIME_BUDGET_MS}ms cumulative budget ` +
            `(processed ${processedChars}/${text.length} chars, ${(processedFraction * 100).toFixed(1)}%) — ` +
            `extrapolating from partial result: ${totalTokens} tokens over processed chars → ` +
            `${extrapolated} tokens estimated total`,
        );
        return extrapolated;
      }
      console.warn(
        `[CompactTokenizer] chunked encode exceeded ${CUMULATIVE_TIME_BUDGET_MS}ms cumulative budget ` +
          `(processed ${processedChars}/${text.length} chars, ${(processedFraction * 100).toFixed(1)}% — ` +
          `below ${MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION * 100}% extrapolation floor) — ` +
          "processed fraction too small to extrapolate reliably, falling back to byte-ratio estimate",
      );
      return null;
    }
  }
  return totalTokens;
}

/** 测试专用：重置缓存的编码器单例，让下一次调用重新触发加载。 */
export function _resetCompactTokenizerCacheForTest(): void {
  cachedEncoderPromise = null;
}
