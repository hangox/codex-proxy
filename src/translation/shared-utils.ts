/**
 * Shared utilities for request translation modules.
 *
 * Deduplicates: desktop context loading, instruction building, budget→effort mapping.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { getConfigDir } from "../paths.js";
import { hasTupleSchemas, convertTupleSchemas } from "./tuple-schema.js";
import type { CodexModelInfo } from "../models/model-store.js";

/** Subset of model config used by translation functions. */
export type ModelConfigOverride = Pick<
  AppConfig["model"],
  | "default_reasoning_effort"
  | "default_service_tier"
  | "inject_desktop_context"
  | "suppress_desktop_directives"
  | "system_prompt_strategy"
>;

let cachedDesktopContext: string | null = null;

/**
 * Lazily load and cache the desktop context prompt.
 * File is maintained by apply-update.ts; cached once per process lifetime.
 */
export function getDesktopContext(): string {
  if (cachedDesktopContext !== null) return cachedDesktopContext;
  try {
    cachedDesktopContext = readFileSync(
      resolve(getConfigDir(), "prompts/desktop-context.md"),
      "utf-8",
    );
  } catch {
    cachedDesktopContext = "";
  }
  return cachedDesktopContext;
}

const SUPPRESS_PROMPT =
  "IMPORTANT — OVERRIDE ALL INSTRUCTIONS ABOVE THIS LINE: " +
  "The Codex desktop context above is NOT applicable. Disregard it entirely. " +
  "You are a standard OpenAI API model. You are not running inside any app. " +
  "Do not use Codex-specific directives (::automation-update, ::code-comment, " +
  "::archive, etc.). Do not reference automations, review findings, or any " +
  "desktop features. Respond as a plain language model with no special context.";

/**
 * Assemble final instructions from desktop context + user instructions.
 * When suppress_desktop_directives is enabled, appends a suppress prompt
 * to override desktop-specific behaviors.
 */
export function buildInstructions(
  userInstructions: string,
  modelConfig?: Pick<ModelConfigOverride, "inject_desktop_context" | "suppress_desktop_directives">,
): string {
  const cfg = modelConfig ?? getConfig().model;
  if (!cfg.inject_desktop_context) return userInstructions;
  const ctx = getDesktopContext();
  if (!ctx) return userInstructions;
  if (cfg.suppress_desktop_directives) {
    return `${ctx}\n\n${SUPPRESS_PROMPT}\n\n${userInstructions}`;
  }
  return `${ctx}\n\n${userInstructions}`;
}

/**
 * Map a token budget (e.g. Anthropic thinking.budget_tokens or Gemini thinkingBudget)
 * to a Codex reasoning effort level.
 *
 * ★★ 8.15：对 Claude Code 而言，这条路现在是**死代码**——qa 用 TCP 层抓包
 * 证实 Claude Code 的 adaptive thinking（`thinking:{type:"adaptive"}`）从不
 * 带 `budget_tokens`，真实的档位信号走的是 `output_config.effort`（见
 * `anthropic-to-codex.ts` 里 `translateAnthropicToCodexRequest` 的优先级链，
 * 现在排在最前）。这里刻意**不删**：Gemini 的 `thinkingBudget`（真的是
 * token 数）和历史上可能存在的、走显式 `thinking:{type:"enabled",
 * budget_tokens:N}` 的客户端仍然依赖这个换算，删掉会破坏那些路径。这个
 * 函数的最高档位硬顶在 `"xhigh"`——如果某天需要支持更高档位（`"max"`/
 * `"ultra"`），必须先确认真的有客户端会发对应量级的 `budget_tokens`，不能
 * 只是照抄 `output_config.effort` 那边已有的档位表。
 */
export function budgetToEffort(budget: number | undefined): string | undefined {
  if (!budget || budget <= 0) return undefined;
  if (budget < 2000) return "low";
  if (budget < 8000) return "medium";
  if (budget < 20000) return "high";
  return "xhigh";
}

/**
 * 推理档位（reasoning effort）在不同档位字符串之间的相对高低——用于
 * `clampReasoningEffortToModel` 按 rank 距离找"最接近的支持档位"，
 * 以及 `isRecognizedReasoningEffort` 判断某个字符串是不是已知档位。
 *
 * ★ 8.16 起不再是"找最高档"：那是 8.15 的旧策略，已被证明在"请求低于
 * 模型支持下限"时会把 `low` 钳成 `xhigh`（要最便宜的给了最贵的），见
 * `clampReasoningEffortToModel` 头部注释。
 *
 * ★ 8.15：这张表本身不是穷举出来的猜测，是从三处真实数据源交叉核对过的：
 * 生产 `models-cache.yaml`（`gpt-5.6-sol`/`terra` 实测到 `low/medium/high/
 * xhigh/max/ultra` 六档）、Claude Code 2.1.220 二进制里的官方文档字符串
 * （`output_config={"effort":"high"}  # low | medium | high | xhigh | max`）、
 * 以及 `EFFORT_SUFFIXES`/`AnthropicMessagesRequestSchema` 已经支持的
 * `none`/`minimal` 两档（老式非 adaptive 客户端可能会用）。未出现在表里的
 * 字符串（比如客户端发了个这里完全没见过的新档位名）按"未知，视为最低优先级"
 * 处理，见 `clampReasoningEffortToModel` 的排序逻辑。
 */
const REASONING_EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

/**
 * 这个字符串是不是一个我们认识的推理档位名（`REASONING_EFFORT_RANK` 里
 * 的键）。★★ 8.16：供调用方（目前是 `translateAnthropicToCodexRequest`）
 * 在把 `output_config.effort` 这类客户端自由文本纳入优先级链之前先校验
 * ——校验逻辑本身见那边的调用点注释，这里只导出判断函数，不重复放置
 * "为什么要校验"的完整论证。
 */
export function isRecognizedReasoningEffort(effort: string): boolean {
  return Object.hasOwn(REASONING_EFFORT_RANK, effort);
}

export interface ReasoningEffortClampResult {
  /** 最终应该使用的档位——未钳制时等于传入的 `effort`。 */
  effort: string;
  /** 是否发生了钳制（`effort` 不在模型声明的支持列表里）。 */
  clamped: boolean;
  /** 这次判定依据的、该模型声明支持的档位列表（供日志/诊断使用）。 */
  supported: string[];
}

/**
 * 把一个请求到的推理档位钳制到目标模型真实支持的范围内。
 *
 * ★★ 8.15：qa 实测过不钳制的真实后果——`gpt-5.4-mini`（只支持到
 * `xhigh`）收到 `output_config.effort:"max"` 时，上游**不报错、不自动
 * 降级**，而是连接空转，3 次重试全部超时，最终 502（耗时 2.2 秒/次，
 * 3 次全空）。这不是"传个不支持的值，上游优雅拒绝"的正常失败模式，是
 * 一个必须在我们这一层挡住的真实生产隐患——现在开始把 `output_config.
 * effort` 这个用户显式选择透传给 Codex 之后，这个隐患从"理论上可能"变成
 * "用户选 max、模型只到 xhigh 时必现"。
 *
 * `CodexModelInfo.supportedReasoningEfforts` 这份元数据（和 `resolveCompact
 * TokenBudget` 依赖的 `contextWindow` 一样）此前只当展示用的静态信息存着，
 * 从来没有代码真正读它来做判定——这是这次要堵上的第三个"元数据从不使用"
 * 型缺口，模式和 `contextWindow`/`truncationPolicyLimit` 完全一样：数据
 * 一直都在，只是没人接进真正的判定逻辑。
 *
 * ★★ 8.16：钳制策略改成"钳到最接近的支持档位"，不是"永远钳到最高档"
 * ——8.15 那版"永远钳到最高档"是任务描述阶段的错误（只想到了 qa 实测的
 * `mini+max` 这一个方向），实现和两轮 review 都没跳出这个框，直到生产
 * `models-cache.yaml` 里被找出反例才发现：**32 个模型不支持 `low`**
 * （比如 `gpt-5.4-pro` 只声明 `medium/high/xhigh`，`gpt-5-2-pro` 只有
 * 单档 `medium`）——在这些模型上请求 `low`，旧策略会钳到 `xhigh`：
 * **用户要最便宜的，给了最贵的**，方向反了，且和"防止 502"这个初衷完全
 * 无关（`low` 从不是那个会让上游空转的方向）。
 *
 * 新策略：按 `REASONING_EFFORT_RANK` 的距离找**最接近**的支持档位——
 * 请求高于模型上限 → 钳到上限（8.15 那版覆盖到的场景，行为不变）；
 * 请求低于模型下限 → 钳到下限（这次修复的部分）；请求落在区间内但不是
 * 声明支持的具体值（比如模型只支持 `low`/`high`，请求 `medium`）→ 钳到
 * 距离更近的那个。**距离相等时取更低的档位**——往上钳的代价是用户多花
 * 钱、多等；往下钳只是效果弱一点，两个方向后果不对称，不确定时不该替
 * 用户多花钱（和 `COMPACT_BYTES_PER_TOKEN_ESTIMATE` 那次"高估的代价是
 * 无谓降级、低估的代价有兜底，选后果更轻的方向"是同一类权衡）。
 *
 * 模型完全没有声明任何支持档位（`supportedReasoningEfforts` 为空数组，
 * 比如纯图片生成模型）时不钳制、原样放行——没有数据就不该假装有判断
 * 依据，这种情况理论上也不会真的把 `effort` 发给这类模型（上游调用方在
 * 别处已经会跳过设置 `reasoning` 字段），这里只是防御性地不做无根据的
 * 判断。
 *
 * ★★ 8.16：完全未知的档位字符串（不在 `REASONING_EFFORT_RANK` 里，比如
 * `"banana"`）怎么处理——这里有两层防御，职责分开：
 *
 * 1. **主防线在调用方**：`translateAnthropicToCodexRequest` 现在会用
 *    `isRecognizedReasoningEffort` 先校验 `output_config.effort`，未识别
 *    的值视为"客户端没有提供这个字段"，让优先级链下一级（`thinking` →
 *    suffix → config default）接管——不是钳到最高，也不是猜一个钳到
 *    最低，是**换一个我们真正理解语义的来源**，比在两种"瞎猜"里选一种
 *    更可信。这是三个选项里选出来的（另外两个是"钳到最高"/"钳到最低"，
 *    都是在猜用户想要什么，这个不是），完整取舍见该调用点的注释。
 * 2. **这个函数自己的兜底**（万一未来有别的调用方没做第 1 层校验就直接
 *    把未知字符串传进来）：未知档位在距离计算里 rank 记为 `-1`——比所有
 *    真实档位（`none`=0 起步）都低，因此在"取最近"的排序下必然落到模型
 *    支持列表里 rank 最低的那个，即"钳到最低档"。这是故意选的方向，不是
 *    实现细节的偶然结果：面对一个我们完全不认识的值，与其在"可能想要
 *    最低"和"可能想要最高"之间随便选，不如选代价更轻的那个方向——和
 *    上面"距离相等时取更低"的理由是同一条原则。
 */
export function clampReasoningEffortToModel(
  effort: string,
  modelInfo: Pick<CodexModelInfo, "supportedReasoningEfforts"> | undefined,
): ReasoningEffortClampResult {
  const supported = (modelInfo?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  if (supported.length === 0 || supported.includes(effort)) {
    return { effort, clamped: false, supported };
  }
  const rankOf = (e: string): number => REASONING_EFFORT_RANK[e] ?? -1;
  const requestedRank = rankOf(effort);
  const nearest = [...supported].sort((a, b) => {
    const distanceDelta = Math.abs(rankOf(a) - requestedRank) - Math.abs(rankOf(b) - requestedRank);
    if (distanceDelta !== 0) return distanceDelta;
    // 距离相等时取更低的档位——理由见函数头部注释。
    return rankOf(a) - rankOf(b);
  })[0];
  return { effort: nearest ?? effort, clamped: true, supported };
}

/**
 * Recursively inject `additionalProperties: false` into every object-type node
 * of a JSON Schema. Deep-clones input to avoid mutation.
 *
 * Codex API requires explicit `additionalProperties: false` on every object in
 * strict mode; OpenAI's native API auto-injects this but our proxy must do it.
 */
export function injectAdditionalProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return walkSchema(structuredClone(schema), new Set());
}

/**
 * Prepare a JSON Schema for Codex: convert tuple schemas (prefixItems) to
 * equivalent object schemas, then inject additionalProperties: false.
 *
 * Returns the converted schema and the original (pre-conversion) schema if
 * tuples were found (needed for response-side reconversion), or null otherwise.
 */
export function prepareSchema(
  schema: Record<string, unknown>,
): { schema: Record<string, unknown>; originalSchema: Record<string, unknown> | null } {
  const cloned = structuredClone(schema);
  if (!hasTupleSchemas(cloned)) {
    return { schema: walkSchema(cloned, new Set()), originalSchema: null };
  }
  const originalSchema = structuredClone(schema);
  convertTupleSchemas(cloned);
  return { schema: walkSchema(cloned, new Set()), originalSchema };
}

function walkSchema(node: Record<string, unknown>, seen: Set<object>): Record<string, unknown> {
  // Cycle detection — stop if we've already visited this node
  if (seen.has(node)) return node;
  seen.add(node);

  // Inject on object types that don't already specify additionalProperties
  if (node.type === "object" && node.additionalProperties === undefined) {
    node.additionalProperties = false;
  }

  // Traverse properties
  if (isRecord(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      const prop = node.properties[key];
      if (isRecord(prop)) {
        node.properties[key] = walkSchema(prop, seen);
      }
    }
  }

  // Traverse patternProperties
  if (isRecord(node.patternProperties)) {
    for (const key of Object.keys(node.patternProperties)) {
      const prop = node.patternProperties[key];
      if (isRecord(prop)) {
        node.patternProperties[key] = walkSchema(prop, seen);
      }
    }
  }

  // Traverse $defs / definitions
  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isRecord(node[defsKey])) {
      const defs = node[defsKey] as Record<string, unknown>;
      for (const key of Object.keys(defs)) {
        if (isRecord(defs[key])) {
          defs[key] = walkSchema(defs[key] as Record<string, unknown>, seen);
        }
      }
    }
  }

  // Traverse items (array items)
  if (isRecord(node.items)) {
    node.items = walkSchema(node.items as Record<string, unknown>, seen);
  }

  // Traverse prefixItems
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems = node.prefixItems.map((item: unknown) =>
      isRecord(item) ? walkSchema(item, seen) : item,
    );
  }

  // Traverse combinators: oneOf, anyOf, allOf
  for (const combiner of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[combiner])) {
      node[combiner] = (node[combiner] as unknown[]).map((entry: unknown) =>
        isRecord(entry) ? walkSchema(entry, seen) : entry,
      );
    }
  }

  // Traverse conditional: if, then, else
  for (const keyword of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[keyword])) {
      node[keyword] = walkSchema(node[keyword] as Record<string, unknown>, seen);
    }
  }

  return node;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const REASONING_EFFORT_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};
