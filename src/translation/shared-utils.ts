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
 */
export function budgetToEffort(budget: number | undefined): string | undefined {
  if (!budget || budget <= 0) return undefined;
  if (budget < 2000) return "low";
  if (budget < 8000) return "medium";
  if (budget < 20000) return "high";
  return "xhigh";
}

/**
 * Relative ordering of reasoning effort levels — used by
 * `clampReasoningEffortToModel` to find the closest supported level, and by
 * `isRecognizedReasoningEffort` to recognize known level names.
 *
 * Cross-checked against three real sources: production model metadata
 * (gpt-5.6-sol / terra advertise low/medium/high/xhigh/max/ultra), the
 * official effort values in Claude Code's docs, and the `none`/`minimal`
 * levels already accepted by the request schema. Unknown strings rank -1
 * (below every real level).
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
 * Whether a string is a known reasoning effort level name.
 *
 * Used by `translateAnthropicToCodexRequest` to validate free-text effort
 * values (e.g. `output_config.effort`) before feeding them into the priority
 * chain: unrecognized values are treated as "client did not provide this
 * field" so the next source in the chain takes over, rather than guessing a
 * clamp direction for a value we don't understand.
 */
export function isRecognizedReasoningEffort(effort: string): boolean {
  return Object.hasOwn(REASONING_EFFORT_RANK, effort);
}

export interface ReasoningEffortClampResult {
  /** The final level to use — equals the input when no clamping happened. */
  effort: string;
  /** Whether clamping occurred (effort not in the model's supported list). */
  clamped: boolean;
  /** The model's declared supported levels (for diagnostics). */
  supported: string[];
}

/**
 * Clamp a requested reasoning effort to the target model's supported range.
 *
 * Why: the Codex upstream neither errors nor degrades when sent an
 * unsupported effort — the connection stalls and times out (observed 502s on
 * gpt-5.4-mini + "max"). Now that `output_config.effort` is actually honored
 * (previously silently stripped by the schema), this hazard became reachable
 * in practice, so we clamp before sending.
 *
 * Strategy: clamp to the *nearest* supported level by rank distance — above
 * the model's max → clamp to max; below its min → clamp to min; a level that
 * falls between supported ones → the closer one. Ties go to the LOWER level:
 * clamping up costs the user money and latency, clamping down only lowers
 * quality, so when uncertain we never charge the user more.
 *
 * Models that declare no supported levels (empty list, e.g. pure image
 * models) are passed through unchanged — without data we won't pretend to
 * judge. Unknown level strings (rank -1) resolve to the lowest supported
 * level, the cheaper direction.
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
    // Ties go to the lower level (see function docs).
    return rankOf(a) - rankOf(b);
  })[0];
  return { effort: nearest ?? effort, clamped: true, supported };
}

/**
 * 上游正则引擎编译不了的正则构造。
 *
 * 实测（用真实 tools 直打上游得出）：GPT 系上游用 RE2，RE2 从设计上就不支持
 * 前瞻 `(?=` / `(?!`；`\p{...}` 这类 Unicode 属性转义则被多数厂商的 JSON
 * Schema 校验器判成 `is not a 'regex'`。命中任意一条，上游在收到请求的那一刻
 * 就拒收**整个请求**——不是参数不合法，是 schema 本身过不了校验，而 Claude
 * Code 的 Artifact 是默认自带工具，于是每一轮正常对话都 400。
 *
 * 因此策略是：**只对含这些构造的 `pattern` 整键删除**，而不是尝试改写，也不按
 * 上游模型区分。`pattern` 只是 JSON Schema 的校验约束、不是工具的功能定义，删掉
 * 不影响工具可用性，模型照样能正常调用；而改写这条路已被实测证伪——`(?!__.*__$)`
 * 在 RE2 里根本无法表达。不按模型区分的理由：清洗发生在路由之前、拿不到最终命中
 * 的上游（换号/降级都可能改），而"能通过的模型"名单必然过时。取舍原则：宁可丢一
 * 个校验约束，也不能丢整个请求；能保留的合法 pattern 仍然保留。
 */
const UNSUPPORTED_UPSTREAM_REGEX_TOKENS = [
  "\\p{", // Unicode 属性转义（\p{Cc} 等）
  "\\P{",
  "(?=", // 前瞻
  "(?!",
  "(?<=", // 后顾
  "(?<!",
  "(?>", // 原子组
  "(?(", // 条件组
] as const;

/**
 * 该正则是否含上游引擎编译不了的构造（见上方常量说明）。
 *
 * ★ 这是**粗粒度的裸子串判据**，不是完整的 RE2 兼容性检查，两个方向的误差都
 * 接受：
 * - 误判（会丢合法约束）：`(?!` / `\p{` 出现在字符类里也算命中，例如
 *   `^[(?!]+$` 会被整键删掉。代价只是少一个校验约束，不会让请求失败。
 * - 漏判（会放过去）：`(?<name>...)` / `(?P<name>...)` 具名分组、反向引用
 *   `\1` 等不在表里。它们没有出现在实测拒收样本中，且裸 `\1` 在字符类里
 *   是合法八进制转义、加进去会引入误判，所以刻意不收。
 * 真出现新的拒收样本时按证据补表，不要凭"RE2 不支持什么"的清单往前猜。
 */
export function isUnsupportedUpstreamPattern(pattern: string): boolean {
  return UNSUPPORTED_UPSTREAM_REGEX_TOKENS.some((token) => pattern.includes(token));
}

/**
 * `walkSchema` 的变换开关。刻意做成必填（而不是带默认值）：每个调用方要哪
 * 几个变换必须写清楚，避免"接一个新变换时顺手把另一个也带上"。工具参数路径
 * 只需要清 pattern，绝不能连带被注入 `additionalProperties`。
 */
interface WalkSchemaOptions {
  /** 注入 `additionalProperties: false`（Codex strict 模式要求）。 */
  injectAdditionalProperties: boolean;
  /** 移除上游正则引擎编译不了的 `pattern` / `patternProperties` 键。 */
  stripUnsupportedPatterns: boolean;
}

/**
 * 只在清 pattern 时下钻的扩展位置——这些关键字的值同样是 schema（或 schema
 * 数组），但既有遍历器从不进入它们。不能把下钻加进通用遍历：那会连带让注入
 * `additionalProperties` 的路径也走进这些位置，改变结构化输出的既有行为。
 */
const EXTENDED_SCHEMA_KEYWORDS = [
  "additionalProperties", // map 值 schema，手写 JSON Schema 常见
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
] as const;

/** 下钻扩展位置时用的开关：只清洗，绝不注入。 */
const STRIP_PATTERNS_ONLY: WalkSchemaOptions = {
  injectAdditionalProperties: false,
  stripUnsupportedPatterns: true,
};

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
  return walkSchema(structuredClone(schema), new Set(), {
    injectAdditionalProperties: true,
    stripUnsupportedPatterns: false,
  });
}

/**
 * 只移除上游正则引擎编译不了的正则约束，不做任何其他变换。Deep-clones input
 * to avoid mutation.
 *
 * 供工具参数路径使用：该路径此前只有 `normalizeSchema` 的浅处理，既不注入
 * `additionalProperties` 也不做 tuple 转换，接清洗时不能顺手把那些行为一并带
 * 过去（会改变既有输出）。
 *
 * 覆盖位置（`pattern` 在任意一处命中都会被整键删除）：`properties` /
 * `patternProperties`（值 + 键名）/ `$defs` / `definitions` / `items`（对象形式
 * 与 draft-07 数组形式）/ `prefixItems` / `oneOf` / `anyOf` / `allOf` /
 * `if` / `then` / `else` / `not` / `additionalProperties` /
 * `unevaluatedProperties` / `unevaluatedItems` / `propertyNames` / `contains` /
 * `dependentSchemas` 的条目。不在这个列表里的关键字（如 `dependencies`、
 * `contentSchema`、`$dynamicRef` 指向的定义）不做保证。
 */
export function sanitizeSchemaPatterns(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return walkSchema(structuredClone(schema), new Set(), {
    injectAdditionalProperties: false,
    stripUnsupportedPatterns: true,
  });
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
    return {
      schema: walkSchema(cloned, new Set(), {
        injectAdditionalProperties: true,
        stripUnsupportedPatterns: true,
      }),
      originalSchema: null,
    };
  }
  const originalSchema = structuredClone(schema);
  convertTupleSchemas(cloned);
  return {
    schema: walkSchema(cloned, new Set(), {
      injectAdditionalProperties: true,
      stripUnsupportedPatterns: true,
    }),
    originalSchema,
  };
}

function walkSchema(
  node: Record<string, unknown>,
  seen: Set<object>,
  options: WalkSchemaOptions,
): Record<string, unknown> {
  // Cycle detection — stop if we've already visited this node
  if (seen.has(node)) return node;
  seen.add(node);

  if (options.stripUnsupportedPatterns) {
    if (typeof node.pattern === "string" && isUnsupportedUpstreamPattern(node.pattern)) {
      delete node.pattern;
    }
    // patternProperties 的键名本身就是正则。上游编译不了同样会拒收整个请求，
    // 所以连带删掉整个条目——代价比删 pattern 大（子 schema 一起没了），但同
    // 样遵守"宁可丢一个校验约束，也不能丢整个请求"。删在遍历之前，被删条目的
    // 值也就不再往下走了。
    if (isRecord(node.patternProperties)) {
      for (const key of Object.keys(node.patternProperties)) {
        if (isUnsupportedUpstreamPattern(key)) delete node.patternProperties[key];
      }
    }
  }

  // Inject on object types that don't already specify additionalProperties
  if (
    options.injectAdditionalProperties &&
    node.type === "object" &&
    node.additionalProperties === undefined
  ) {
    node.additionalProperties = false;
  }

  // Traverse properties
  if (isRecord(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      const prop = node.properties[key];
      if (isRecord(prop)) {
        node.properties[key] = walkSchema(prop, seen, options);
      }
    }
  }

  // Traverse patternProperties
  if (isRecord(node.patternProperties)) {
    for (const key of Object.keys(node.patternProperties)) {
      const prop = node.patternProperties[key];
      if (isRecord(prop)) {
        node.patternProperties[key] = walkSchema(prop, seen, options);
      }
    }
  }

  // Traverse $defs / definitions
  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isRecord(node[defsKey])) {
      const defs = node[defsKey] as Record<string, unknown>;
      for (const key of Object.keys(defs)) {
        if (isRecord(defs[key])) {
          defs[key] = walkSchema(defs[key] as Record<string, unknown>, seen, options);
        }
      }
    }
  }

  // Traverse items (array items)
  if (isRecord(node.items)) {
    node.items = walkSchema(node.items as Record<string, unknown>, seen, options);
  }

  // Traverse prefixItems
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems = node.prefixItems.map((item: unknown) =>
      isRecord(item) ? walkSchema(item, seen, options) : item,
    );
  }

  // Traverse combinators: oneOf, anyOf, allOf
  for (const combiner of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[combiner])) {
      node[combiner] = (node[combiner] as unknown[]).map((entry: unknown) =>
        isRecord(entry) ? walkSchema(entry, seen, options) : entry,
      );
    }
  }

  // Traverse conditional: if, then, else
  for (const keyword of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[keyword])) {
      node[keyword] = walkSchema(node[keyword] as Record<string, unknown>, seen, options);
    }
  }

  // 下钻既有遍历器从不进入、但值同样是 schema 的位置（见
  // EXTENDED_SCHEMA_KEYWORDS）。只清 pattern、不注入，所以必须和上面的删除一
  // 样包在 `stripUnsupportedPatterns` 守卫里——否则 injectAdditionalProperties()
  // 的"只注入"窄契约会被打破（它会顺带删掉这些位置的 pattern）。
  //
  // 位置放在主遍历**之后**是有意的：`seen` 是按引用去重的，若同一个节点对象被
  // 正常位置和扩展位置共用（生产路径的 schema 都来自 JSON.parse，树形、不可能
  // 共用，只有内存里手搓 schema 时才可能），先被访问的那一次决定用哪套开关。
  // 放后面 → 正常位置那次先拿到完整开关（注入行为与既有实现一致），扩展位置那
  // 次因 `seen` 命中而跳过；放前面则相反，会让该节点在 prepareSchema 下丢掉注入。
  if (options.stripUnsupportedPatterns) {
    for (const key of EXTENDED_SCHEMA_KEYWORDS) {
      const value = node[key];
      if (isRecord(value)) {
        node[key] = walkSchema(value, seen, STRIP_PATTERNS_ONLY);
      } else if (Array.isArray(value)) {
        node[key] = value.map((entry) =>
          isRecord(entry) ? walkSchema(entry, seen, STRIP_PATTERNS_ONLY) : entry,
        );
      }
    }
    // dependentSchemas: { <名称>: <schema> } —— 值是 schema，不是"一个 schema
    // 节点"，所以按条目逐个下钻而不是整块当 schema 走。
    if (isRecord(node.dependentSchemas)) {
      const dependentSchemas = node.dependentSchemas as Record<string, unknown>;
      for (const key of Object.keys(dependentSchemas)) {
        if (isRecord(dependentSchemas[key])) {
          dependentSchemas[key] = walkSchema(
            dependentSchemas[key] as Record<string, unknown>,
            seen,
            STRIP_PATTERNS_ONLY,
          );
        }
      }
    }
    // draft-07 的元组写法 items: [schema, ...] —— 主遍历只处理 items 的对象形式。
    if (Array.isArray(node.items)) {
      node.items = node.items.map((entry) =>
        isRecord(entry) ? walkSchema(entry, seen, STRIP_PATTERNS_ONLY) : entry,
      );
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
