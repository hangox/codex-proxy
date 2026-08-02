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
 * `clampReasoningEffortToModel` 判断"模型支持的最高档是哪个"。
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
 * 钳制策略：不在支持列表里 → 钳到该模型支持的最高档（不是钳到"最接近的
 * 档"，也不是拒绝请求）——用户选了个模型不支持的高档位，最合理的退让方向
 * 是"给这个模型能给的最好的"，不是报错中断整个请求，也不是静默降到某个
 * 任意固定值。模型完全没有声明任何支持档位（`supportedReasoningEfforts`
 * 为空数组，比如纯图片生成模型）时不钳制、原样放行——没有数据就不该假装
 * 有判断依据，这种情况理论上也不会真的把 `effort` 发给这类模型（上游
 * 调用方在别处已经会跳过设置 `reasoning` 字段），这里只是防御性地不做
 * 无根据的判断。
 *
 * ★★ reviewer2 复审确认的已知残留风险，写在这里防止后人误以为这个函数
 * 已经是全局兜底：**目前只有 `anthropic-to-codex.ts` 的
 * `translateAnthropicToCodexRequest`（Claude Code / Anthropic Messages
 * 这一条路径）接了这个函数。** `responses.ts` 的直通端点（`/v1/responses`，
 * 普通请求约 918~931 行、compact 约 700~705 行）直接透传客户端发来的
 * `body.reasoning.effort`，完全不经过这里；OpenAI 兼容路径、Gemini
 * 翻译层也没有调用这个函数。这些入口如果收到一个目标模型不支持的
 * `effort`，本文件头部说的那个"连接空转到 502"的隐患**依然存在，没有
 * 被这次改动覆盖**。这是已知的、经过讨论后暂不处理的范围（passthrough
 * 端点的调用方是自己构造请求的高级用户，和 Claude Code 终端用户不是
 * 同一类风险敞口，且改动面会明显更大）——如果以后产品目标变成"所有入口
 * 的 effort 都不能触发上游空转"，这些地方也需要接入 `clampReasoningEffort
 * ToModel`，不能假设这个函数已经覆盖了全部请求路径。
 */
export function clampReasoningEffortToModel(
  effort: string,
  modelInfo: Pick<CodexModelInfo, "supportedReasoningEfforts"> | undefined,
): ReasoningEffortClampResult {
  const supported = (modelInfo?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  if (supported.length === 0 || supported.includes(effort)) {
    return { effort, clamped: false, supported };
  }
  const highest = [...supported].sort(
    (a, b) => (REASONING_EFFORT_RANK[a] ?? -1) - (REASONING_EFFORT_RANK[b] ?? -1),
  ).at(-1);
  return { effort: highest ?? effort, clamped: true, supported };
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
