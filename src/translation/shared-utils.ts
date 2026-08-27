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
