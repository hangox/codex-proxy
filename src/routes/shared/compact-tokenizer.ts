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
 * ★★ 8.11/8.13：`js-tiktoken` 对"高度重复内容"有灾难级的病态性能，实现
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
 * 实现：把待 tokenize 的文本切成固定大小的块（`CHUNK_SIZE_CHARS`，按
 * UTF-16 code unit 切，可能切开一个 surrogate pair——已验证 `js-tiktoken`
 * 对孤立 surrogate 不会抛错，只是把它当一个"无法识别的字符"处理，边界处
 * 最多多算 1~2 个 token，见下面"分块对准确度的影响"），逐块 encode，每块
 * 结束后检查累计耗时，超过 `CUMULATIVE_TIME_BUDGET_MS` 立即放弃、返回
 * `null`（调用方回退到粗筛比例估算，和分词器加载失败/含图片时完全同一条
 * 路径）。
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
 * `CHUNK_SIZE_CHARS = 500`：即使是目前实测到的最坏字符（emoji），单块
 * 最坏耗时也只有 ~125ms——留了明显余量（不是卡着最坏值走），因为不排除
 * 存在比 emoji 更差的字符我们还没测到，块越小，单块最坏情况的绝对值就
 * 越低，抗未知风险的能力越强。`CUMULATIVE_TIME_BUDGET_MS = 400`：正常
 * 内容（非病态）处理几十万字符的真实 compact payload 只需要几百毫秒
 * （评估阶段实测 300~500ms），400ms 预算不会误伤正常内容；病态内容下，
 * 最多约 3~4 个块（400/125≈3.2）就会触发熔断，全程最坏总耗时上界约等于
 * `CUMULATIVE_TIME_BUDGET_MS + 一个块的最坏耗时` ≈ 400+125=525ms，
 * 无论内容是什么形状都不会突破这个量级——**这个上界不依赖于"我们有没有
 * 见过这种病态模式"，这是它相对 8.11 那版最根本的改进**。
 *
 * 分块对准确度的影响（4 组真实样本实测，chunkSize=500）：多算
 * 0.336%~0.500% 的 token（边界切断多字符 token 导致的系统性高估，方向
 * 安全——见 `estimateCompactInputTokensPrecise` 上面已有的
 * `TOKENIZER_ESTIMATE_SAFETY_MARGIN` 讨论，这点误差被那个边际吸收，
 * 不需要额外补偿）。
 *
 * WASM 版 `tiktoken` 同类测试下量级更好但增长速率同样劣于线性——**这不是
 * "换 WASM 就能解决"的问题，两种实现都需要这层防护**，所以这里的策略
 * 独立于具体用哪个 tiktoken 实现，不依赖"哪个实现更快"这个前提。
 */
const CHUNK_SIZE_CHARS = 500;
const CUMULATIVE_TIME_BUDGET_MS = 400;

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
 * ★ 8.13：分块 encode，块间累计耗时熔断——见文件头注释"为什么不是枚举病态
 * 模式"的完整论证。正常内容（非病态）不会碰到熔断，几十万字符也就几百
 * 毫秒；病态内容会在 `CUMULATIVE_TIME_BUDGET_MS` 时间量级内被拦下，全程
 * 最坏耗时上界约 `CUMULATIVE_TIME_BUDGET_MS` + 一个块的最坏耗时。
 *
 * 返回 `null` 有两种情况，调用方都必须回退到粗筛估算（见文件头注释）：
 * 1. 编码器加载失败（理论上不该发生）。
 * 2. ★ 熔断触发——这次是**安全性**判断，不是"分词器不可用"，但对调用方
 *    而言处理方式完全一样（不精确 tokenize，退回粗筛），复用同一个
 *    `null` 出口，不需要调用方多分支处理。熔断触发时**丢弃已经算出的
 *    部分 token 数**，不做"用已处理部分外推"这种事——外推本身还是要
 *    对"这段内容的膨胀率有多高"做假设，而我们刚刚证明了这类假设靠不住。
 */
export async function tokenizeCompactContent(text: string): Promise<number | null> {
  const encoder = await loadCompactTokenizer();
  if (encoder === null) return null;

  let totalTokens = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE_CHARS) {
    const chunk = text.slice(offset, offset + CHUNK_SIZE_CHARS);
    totalTokens += encoder.encode(chunk).length;
    if (Date.now() - startedAt > CUMULATIVE_TIME_BUDGET_MS) {
      console.warn(
        `[CompactTokenizer] chunked encode exceeded ${CUMULATIVE_TIME_BUDGET_MS}ms cumulative budget ` +
          `(processed ${offset + chunk.length}/${text.length} chars) — likely pathological content, ` +
          "aborting precise tokenization and falling back to byte-ratio estimate",
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
