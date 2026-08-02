/**
 * Translate Anthropic Messages API request → Codex Responses API request.
 */

import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { parseModelName, getModelInfo } from "../models/model-store.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort, clampReasoningEffortToModel } from "./shared-utils.js";
import type { ModelConfigOverride } from "./shared-utils.js";
import {
  anthropicToolsToCodex,
  anthropicToolChoiceToCodex,
  type AnthropicToolConversionOptions,
} from "./tool-format.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHostedWebSearchTool(tools: unknown[]): boolean {
  return tools.some((tool) => isRecord(tool) && tool.type === "web_search");
}

/**
 * Map Anthropic thinking budget_tokens to Codex reasoning effort.
 *
 * ★★ 8.15：对 Claude Code 而言这个函数现在基本是死代码——qa 抓包证实
 * Claude Code 的 adaptive thinking 从不带 `budget_tokens`（`thinking:
 * {type:"adaptive"}` 就是全部内容），真实档位信号走 `output_config.effort`
 * （见 `translateAnthropicToCodexRequest` 里的优先级链，现在排在这个函数
 * 前面）。这里保留是为了兼容显式 `thinking:{type:"enabled",budget_tokens:N}`
 * 这种老式/非 Claude Code 客户端可能仍在用的写法——不能删，只是不再是
 * Claude Code 场景下真正决定 effort 的那一环。
 */
function mapThinkingToEffort(
  thinking: AnthropicMessagesRequest["thinking"],
): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive") {
    // adaptive: use budget_tokens if provided, otherwise let Codex decide
    return thinking.budget_tokens ? budgetToEffort(thinking.budget_tokens) : undefined;
  }
  return budgetToEffort(thinking.budget_tokens);
}

/**
 * Extract text-only content from Anthropic blocks.
 */
function extractTextContent(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function normalizeSystemInstructionText(text: string): string {
  // Strip billing-header lines individually rather than discarding the whole
  // string. Claude Code's custom-model path sends `system` as a single string
  // with the billing header on the first line and the real prompt after a
  // blank line; a whole-string startsWith check would drop the real prompt too.
  // The array-of-blocks path is unaffected: a pure billing block still collapses
  // to "" here and is removed by the caller's filter(Boolean).
  const lines = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(BILLING_HEADER_PREFIX));
  return lines.join("\n").trim();
}

/**
 * Build multimodal content (text + images) from Anthropic blocks.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */
function extractMultimodalContent(
  content: Array<Record<string, unknown>>,
): string | CodexContentPart[] {
  const hasImage = content.some((b) => b.type === "image");
  if (!hasImage) return extractTextContent(content);

  const parts: CodexContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      // Anthropic format: source: { type: "base64", media_type: "image/png", data: "..." }
      const source = block.source as
        | { type: string; media_type: string; data: string }
        | undefined;
      if (source?.type === "base64" && source.media_type && source.data) {
        parts.push({
          type: "input_image",
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * Convert Anthropic message content blocks into native Codex input items.
 * Handles text, image, tool_use, and tool_result blocks.
 */
function contentToInputItems(
  role: "user" | "assistant",
  content: string | Array<Record<string, unknown>>,
): CodexInputItem[] {
  if (typeof content === "string") {
    return [{ role, content }];
  }

  const items: CodexInputItem[] = [];

  // Build content (text or multimodal) for the message itself
  const hasToolBlocks = content.some((b) => b.type === "tool_use" || b.type === "tool_result");
  if (role === "user") {
    const extracted = extractMultimodalContent(content);
    if (extracted || !hasToolBlocks) {
      items.push({ role: "user", content: extracted || "" });
    }
  } else {
    // Assistant messages: text-only (Codex doesn't support structured assistant content)
    const text = extractTextContent(content);
    if (text || !hasToolBlocks) {
      items.push({ role: "assistant", content: text });
    }
  }

  for (const block of content) {
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : `tc_${name}`;
      let args: string;
      try {
        args = JSON.stringify(block.input ?? {});
      } catch {
        args = "{}";
      }
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: args,
      });
    } else if (block.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
      let resultText = "";
      const imageParts: CodexContentPart[] = [];
      if (typeof block.content === "string") {
        resultText = block.content;
      } else if (Array.isArray(block.content)) {
        const blocks = block.content as Array<Record<string, unknown>>;
        resultText = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
        // Extract image blocks for a follow-up user message
        for (const b of blocks) {
          if (b.type === "image") {
            const source = b.source as
              | { type: string; media_type: string; data: string }
              | undefined;
            if (source?.type === "base64" && source.media_type && source.data) {
              imageParts.push({
                type: "input_image",
                image_url: `data:${source.media_type};base64,${source.data}`,
              });
            }
          }
        }
      }
      if (block.is_error) {
        resultText = `Error: ${resultText}`;
      }
      items.push({
        type: "function_call_output",
        call_id: toolUseId,
        output: resultText,
      });
      // Codex function_call_output is string-only; inject images as a
      // subsequent user message so the model can still see them.
      if (imageParts.length > 0) {
        items.push({ role: "user", content: imageParts });
      }
    }
  }

  return items;
}

/**
 * Convert an AnthropicMessagesRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system (top-level) → instructions field
 *   - messages → input array
 *   - model → resolved model ID
 *   - thinking → reasoning.effort
 */
export function translateAnthropicToCodexRequest(
  req: AnthropicMessagesRequest,
  modelConfig?: ModelConfigOverride,
  options?: {
    injectHostedWebSearch?: boolean;
    mapClaudeCodeWebSearch?: boolean;
    /** 仅用于钳制发生时的日志关联，不影响翻译结果本身。 */
    requestId?: string;
  },
): CodexResponsesRequest {
  // Extract the user-supplied system prompt (empty when none provided). The
  // synthetic default below is intentionally kept out of `userInstructions` so
  // it is never treated as real user content by the inline strategy.
  let userInstructions = "";
  if (req.system) {
    if (typeof req.system === "string") {
      userInstructions = normalizeSystemInstructionText(req.system);
    } else {
      userInstructions = req.system
        .map((b) => normalizeSystemInstructionText(b.text))
        .filter(Boolean)
        .join("\n\n");
    }
  }
  // Text that goes into the top-level `instructions` field in the default
  // (non-inline) strategy. Falls back to a generic assistant prompt.
  const instructionsText = userInstructions || "You are a helpful assistant.";
  const cfg = modelConfig ?? getConfig().model;

  // system_prompt_strategy controls where the user-supplied system prompt is
  // delivered. With the two `_inline` modes the prompt is moved out of the
  // top-level `instructions` field into the first input item, bypassing the
  // Codex backend's built-in base prompt prior when it overrides `instructions`.
  const strategy = cfg.system_prompt_strategy ?? "instructions";
  const inlineSystem = strategy === "developer_inline" || strategy === "system_inline";
  // In inline modes keep `instructions` free of user content (so desktop
  // context can still be injected) and carry the real user system inline
  // instead. The synthetic default is dropped in inline modes (nothing to
  // bypass when the user supplied no system).
  const instructions = buildInstructions(inlineSystem ? "" : instructionsText, cfg);

  // Build input items from messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    const items = contentToInputItems(
      msg.role as "user" | "assistant",
      msg.content as string | Array<Record<string, unknown>>,
    );
    input.push(...items);
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Inline strategy: prepend the user system prompt as the first input item.
  // ChatGPT Codex backend accepts a {role, content:[{type:"input_text"}]} item
  // for developer/system roles (no item-level `type: "message"`).
  if (inlineSystem && userInstructions) {
    const role = strategy === "developer_inline" ? "developer" : "system";
    input.unshift({
      role,
      content: [{ type: "input_text", text: userInstructions }],
    });
  }

  // Resolve model (suffix parsing extracts service_tier and reasoning_effort)
  const parsed = parseModelName(req.model);
  const modelId = parsed.modelId;
  const modelInfo = getModelInfo(modelId);

  // Convert tools to Codex format
  const toolConversionOptions: AnthropicToolConversionOptions | undefined =
    options?.mapClaudeCodeWebSearch === true ? { mapClaudeCodeWebSearch: true } : undefined;
  const codexTools = req.tools?.length
    ? toolConversionOptions
      ? anthropicToolsToCodex(req.tools, toolConversionOptions)
      : anthropicToolsToCodex(req.tools)
    : [];
  // Claude Code 在非 Anthropic 官方 base URL 下会禁用自身 ToolSearch。
  // 只有走本地 Codex 后端时才默认交给 Codex hosted web_search。
  if (options?.injectHostedWebSearch === true && !hasHostedWebSearchTool(codexTools)) {
    codexTools.push({ type: "web_search" });
  }
  const codexToolChoice = toolConversionOptions
    ? anthropicToolChoiceToCodex(req.tool_choice, req.tools, toolConversionOptions)
    : anthropicToolChoiceToCodex(req.tool_choice, req.tools);

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input,
    stream: true,
    store: false,
    tools: codexTools,
  };

  // Add tool_choice if specified
  if (codexToolChoice) {
    request.tool_choice = codexToolChoice;
  }

  // Reasoning effort: output_config.effort > thinking config > suffix > config default
  //
  // ★★ 8.15：`output_config.effort` 提到最前——qa 用 TCP 层抓包证实这才是
  // Claude Code 真正传递用户显式选择的字段（adaptive thinking 模式下
  // `thinking.budget_tokens` 根本不存在，`mapThinkingToEffort` 对这类请求
  // 恒定返回 undefined，见该函数头部注释），比其余三个来源都更可信，理应
  // 排在最前。`req.output_config` 这个字段此前在 schema 里完全没有声明，
  // 会被 Zod 默认（非 `.strict()`）静默 strip 掉——不是客户端没发，是我们
  // 自己在业务逻辑看到它之前就吃掉了，见 `types/anthropic.ts` 里这个字段
  // 的头部注释。
  // ★★ reviewer2 揪出的真缺陷（8.15 修复后才暴露），两种坏结果都不报错、
  // 只是安静地做错事，必须分开看：
  // 1. `typeof === "string"` 不够——`""` 会通过这个检查，被 `??` 当成
  //    "已提供"直接顶掉后面所有 fallback（`??` 只处理 `null`/`undefined`，
  //    不处理空字符串），最终 `requestedEffort` 变成 `""`，落到下面
  //    `if(requestedEffort)` 判 falsy 被跳过——整条请求**完全不带
  //    `reasoning` 字段发出去**，比这次改动之前更差（改动前至少还能落到
  //    `cfg.default_reasoning_effort` 兜底）。
  // 2. 纯空白 `"   "` 更隐蔽——它是 truthy，不会被上面那条挡住，会正常
  //    进入 `clampReasoningEffortToModel`；`"   "` 不在任何模型的
  //    `supportedReasoningEfforts` 列表里，会被钳到该模型支持的**最高档**
  //    ——等于"客户端发了个空白值，我们悄悄给它换成 max"，不是"处理了"，
  //    是**悄悄换了语义**。
  // 修法：trim 之后非空才算"客户端真的提供了这个字段"，否则当成没提供，
  // 让后面的 fallback 链正常接管；trim 之后非空的情况也必须用**规范化
  // （trim 后）的值**参与后续判断，不能用原始值——否则 `" high "` 这种
  // 带前后空白但语义明确的值，会因为字符串不完全等于 `"high"` 而被误判成
  // "不在支持列表里"，同样被错误钳到最高档。
  const explicitEffort = typeof req.output_config?.effort === "string" && req.output_config.effort.trim() !== ""
    ? req.output_config.effort.trim()
    : undefined;
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const requestedEffort =
    explicitEffort ??
    thinkingEffort ??
    parsed.reasoningEffort ??
    cfg.default_reasoning_effort;
  if (requestedEffort) {
    // ★★ 8.15：钳制到目标模型真实支持的档位——qa 实测过不钳制的后果：
    // 不支持的模型收到不支持的 effort，上游既不报错也不降级，是连接空转
    // 直到 3 次重试全部超时、502（`gpt-5.4-mini`+`"max"` 必现，2.2s/次）。
    // 现在 `output_config.effort` 会被真正采纳（不再是从来发不出去的死
    // 信号），用户选的档位一旦超出模型能力就会必现这个 502，必须在这里
    // 挡住。`CodexModelInfo.supportedReasoningEfforts` 这份元数据此前只
    // 当展示用的静态信息存着，从没有代码真正读它做判定——完整依据见
    // `clampReasoningEffortToModel` 头部注释（`shared-utils.ts`）。
    const clampResult = clampReasoningEffortToModel(requestedEffort, modelInfo);
    if (clampResult.clamped) {
      console.warn(
        `[AnthropicToCodex] rid=${options?.requestId ?? "-"} phase=effort_clamped model=${modelId} ` +
          `requested=${requestedEffort} clamped_to=${clampResult.effort} ` +
          `supported=${clampResult.supported.length > 0 ? clampResult.supported.join(",") : "(none declared)"}`,
      );
    }
    request.reasoning = { effort: clampResult.effort, summary: "auto" };
  }

  // Service tier: suffix > config default
  const serviceTier =
    parsed.serviceTier ??
    cfg.default_service_tier ??
    null;
  if (serviceTier) {
    request.service_tier = serviceTier;
  }

  return request;
}
