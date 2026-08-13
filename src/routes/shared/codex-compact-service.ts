import { createHash } from "node:crypto";
import type { AccountPool } from "../../auth/account-pool.js";
import { CodexApiError, normalizeServiceTierForUpstream } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type {
  CodexCompactRequest,
  CodexInputItem,
  CodexResponsesRequest,
} from "../../proxy/codex-types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import { withRetry } from "../../utils/retry.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { applyParsedRateLimits } from "./proxy-rate-limit.js";
import { buildCodexApi } from "./proxy-handler-utils.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { auditAccountTag } from "./opaque-compact-audit.js";
import { canonicalJson } from "./canonical-json.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import { getModelInfo } from "../../models/model-store.js";
import { isPromptTooLongLike } from "../../proxy/prompt-too-long-error.js";
import {
  isModelNotSupportedError,
  isQuotaExhaustedError,
  isBanError,
  isTokenInvalidError,
  isCfPathBlockError,
} from "../../proxy/error-classification.js";
import { tokenizeCompactContent } from "./compact-tokenizer.js";

const COMPACT_PROMPT_PREFIX = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
const COMPACT_PROMPT_SECTION_INTRO = "Your summary should include the following sections:";
const COMPACT_PROMPT_SUFFIX = "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";
const COMPACT_PROMPT_SECTIONS = [
  "1. Primary Request and Intent:",
  "2. Key Technical Concepts:",
  "3. Files and Code Sections:",
  "4. Errors and fixes:",
  "5. Problem Solving:",
  "6. All user messages:",
  "7. Pending Tasks:",
] as const;
const COMPACT_PROMPT_MIN_LENGTH = 600;
const ALL_SECTIONS_PRESENT = (1 << COMPACT_PROMPT_SECTIONS.length) - 1;

interface CompactTextCandidate {
  prompt: string;
  shape: "string" | "blocks";
  blockCount: number;
  promptBlockIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCompactPrompt(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function extractTrailingCompactText(
  content: AnthropicMessagesRequest["messages"][number]["content"],
): CompactTextCandidate | null {
  if (typeof content === "string") {
    return content.trim() === ""
      ? null
      : { prompt: content, shape: "string", blockCount: 1, promptBlockIndex: 0 };
  }
  if (content.length === 0) return null;

  let lastTextCandidate: CompactTextCandidate | null = null;
  let strictCandidateCount = 0;
  for (const [index, block] of content.entries()) {
    if (block.type !== "text" || typeof block.text !== "string" || block.text.trim() === "") continue;
    const candidate = {
      prompt: block.text,
      shape: "blocks" as const,
      blockCount: content.length,
      promptBlockIndex: index,
    };
    lastTextCandidate = candidate;

    const normalized = normalizeCompactPrompt(candidate.prompt).trim();
    if (isCompleteCompactPrompt(normalized, compactPromptStructure(normalized))) {
      strictCandidateCount += 1;
    }
  }

  // 同一条用户消息包含多个完整 compact prompt 时存在歧义，必须拒绝。
  // 唯一 prompt 可与前后的非文本块共存，但必须仍是最后一个非空文本块，
  // 避免把后续普通文本误判为 compact 请求。
  return strictCandidateCount > 1 ? null : lastTextCandidate;
}

interface CompactPromptStructure {
  introPresent: boolean;
  presentMask: number;
  duplicateMask: number;
  orderingMask: number;
  score: number;
}

function compactPromptStructure(prompt: string): CompactPromptStructure {
  const introIndex = prompt.indexOf(COMPACT_PROMPT_SECTION_INTRO);
  let presentMask = 0;
  let duplicateMask = 0;
  let orderingMask = 0;
  let previousIndex = introIndex;

  for (const [sectionIndex, section] of COMPACT_PROMPT_SECTIONS.entries()) {
    const bit = 1 << sectionIndex;
    const firstIndex = introIndex < 0
      ? -1
      : prompt.indexOf(section, introIndex + COMPACT_PROMPT_SECTION_INTRO.length);
    if (firstIndex < 0) continue;
    presentMask |= bit;
    if (prompt.indexOf(section, firstIndex + section.length) >= 0) duplicateMask |= bit;
    if (firstIndex <= previousIndex) orderingMask |= bit;
    previousIndex = firstIndex;
  }

  return {
    introPresent: introIndex >= 0,
    presentMask,
    duplicateMask,
    orderingMask,
    score: COMPACT_PROMPT_SECTIONS.reduce(
      (score, _section, index) => score + Number((presentMask & (1 << index)) !== 0),
      0,
    ),
  };
}

function isCompleteCompactPrompt(
  normalized: string,
  structure: CompactPromptStructure,
): boolean {
  return normalized.startsWith(COMPACT_PROMPT_PREFIX) &&
    normalized.endsWith(COMPACT_PROMPT_SUFFIX) &&
    normalized.length >= COMPACT_PROMPT_MIN_LENGTH &&
    structure.introPresent &&
    structure.presentMask === ALL_SECTIONS_PRESENT &&
    structure.orderingMask === 0;
}

function bitmask(value: number): string {
  return value.toString(2).padStart(COMPACT_PROMPT_SECTIONS.length, "0");
}

function logPartialCompactFingerprint(
  normalizedLength: number,
  structure: CompactPromptStructure,
  candidate: CompactTextCandidate,
): void {
  const missingMask = ALL_SECTIONS_PRESENT ^ structure.presentMask;
  console.warn(
    `[ClaudeCodeCompact] phase=fingerprint_partial sections=${structure.score}/${COMPACT_PROMPT_SECTIONS.length}` +
      ` chars=${normalizedLength} shape=${candidate.shape} blocks=${candidate.blockCount}` +
      ` prompt_block=${candidate.promptBlockIndex} intro=${Number(structure.introPresent)}` +
      ` missing=${bitmask(missingMask)} duplicate=${bitmask(structure.duplicateMask)}` +
      ` ordering=${bitmask(structure.orderingMask)}`,
  );
}

export function extractClaudeCodeCompactPrompt(req: AnthropicMessagesRequest): string | null {
  const lastMessage = req.messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return null;
  const candidate = extractTrailingCompactText(lastMessage.content);
  if (candidate === null) return null;

  const normalized = normalizeCompactPrompt(candidate.prompt).trim();
  const hasPrefix = normalized.startsWith(COMPACT_PROMPT_PREFIX);
  const hasSuffix = normalized.endsWith(COMPACT_PROMPT_SUFFIX);
  const structure = compactPromptStructure(normalized);
  if (isCompleteCompactPrompt(normalized, structure)) {
    return candidate.prompt;
  }
  if (hasPrefix || hasSuffix || structure.score >= 3) {
    logPartialCompactFingerprint(normalized.length, structure, candidate);
  }
  return null;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Convert Anthropic history for the compact endpoint without silently dropping
 * unfamiliar content blocks — with one deliberate, documented exception below.
 * Native Codex equivalents are used where possible; blocks without an equivalent
 * are carried as JSON text so redacted payloads, documents, and future block
 * types remain available to the compact model after JSON decoding.
 *
 * ★ 8.7：`thinking`/`redacted_thinking` 块**故意丢弃**，不再走"未知块→JSON
 * 包装保留"的兜底路径。这个函数曾经叫 `anthropicHistoryToLosslessCodexInput`
 * （改名前），"无损"承诺到这里正式打破，理由必须写清楚：
 *
 * 生产实测（tencent1，24.4 小时窗口）：472 次 compact 尝试、440 次失败，
 * 100% 是上游 400 `Prompt is too long`。逐块拆解体积发现 thinking 块占
 * compact 路径与普通请求路径体积差的 91.2%——而普通生成路径（见
 * `anthropic-to-codex.ts` 的 `extractTextContent`）本来就 100% 丢弃这些块，
 * 只有 compact 这条路径因为"无损"设计把它们整块 JSON.stringify 保留。
 *
 * 为什么丢弃是安全的——两条依据，都不依赖"thinking 块很小/只是标题"这类
 * 说法（qa 用真实会话 `c382c880` 的 1325 个真实 thinking 块实测过：p50=1116
 * 字节、mean=2418、max=76436 字节，因会话而异极大，简单会话是标题、复杂
 * agentic 会话是完整推理，"反正很小所以丢了无所谓"这个论据不成立，最初的
 * 版本写过这个论据，已被 qa 实测推翻，不要再用）：
 *
 * 1. **结构性对齐，不是新增信息损失**：普通生成路径本来就 100% 丢弃
 *    thinking（`extractTextContent` 只提取 `type==="text"` 块）——模型在
 *    正常多轮对话里**从来看不到历史 thinking**，compact 这条路径保留它是
 *    唯一的例外。如果 thinking 对模型摘要有价值，普通路径早就该带上了。
 *    丢弃它只是让 compact 路径的输入形状和生成路径对齐，不是砍掉一个
 *    "本来有用"的信息源。
 * 2. **端到端 A/B 实测（qa）**：同一份 805 条真实消息切片、真实 39 个工具
 *    定义（117759 字节）、真实 compact prompt 模板，打 gpt-5.6-sol——
 *    保留 thinking：400 `Prompt is too long`；去掉 thinking：200，真实
 *    `usage.input_tokens=282519`。唯一变量是 thinking 在不在。更大的
 *    切片（979 条消息）测"去掉 thinking"依然成功，真实 input_tokens
 *    到过 312084。
 *    ★ 边界：qa 只测到 312084 这个成功点，**没有测到失败点**——不能把
 *    "膨胀比下降后理论上可以推到 ~333K"当成已验证的上限，那是反推值，
 *    不是实测值，`resolveCompactTokenBudget` 的预算表也没有按这个数字设。
 *
 * `redacted_thinking` 一并丢弃：它的 `data` 字段是加密后的不透明载荷，本来
 * 就不可读，保留它对压缩模型摘要没有任何信息增益，纯粹是白占体积。
 *
 * 影响面：`opaqueCompactSemanticDigest`（内容寻址 edge 的语义 digest）以
 * `compactRequest.input` 为输入分量之一，这个函数的输出变了，同一段历史
 * 算出的 digest 也会变——但这正是内容寻址的设计意图（"这次到底压缩了什么"
 * 由请求内容本身决定），不是需要修的兼容性问题：旧 digest 不会被新序列化
 * 意外撞上，也不会被新序列化撞出脏读，只是同一份历史下"语义摘要"这个值本身
 * 变了，等价于历史内容本身发生了一次单向格式迁移。已有的、按旧公式落盘的
 * successor edge 记录不受影响（AEAD 用的是落盘时已经算好的 binding，不会
 * 重算），只是不会再被新请求复用回放——影响与 8.6 那次 variant hash 公式调整
 * 完全同构：具体分析见 `opaqueCompactVariantHash` 头部注释。
 */
export function anthropicHistoryToCompactCodexInput(
  messages: AnthropicMessagesRequest["messages"],
): CodexInputItem[] {
  const input: CodexInputItem[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({
        role: message.role,
        content: [{
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        }],
      });
      continue;
    }

    for (const block of message.content) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        // 8.7：故意丢弃，理由见函数头部注释——不落入下面的 JSON 包装兜底。
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        input.push({
          role: message.role,
          content: [{
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: block.text,
          }],
        });
        continue;
      }
      if (message.role === "user" && block.type === "image" && isRecord(block.source)) {
        const source = block.source;
        if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
          input.push({
            role: "user",
            content: [{ type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` }],
          });
          continue;
        }
      }
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: jsonText(block.input ?? {}),
        });
        continue;
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: jsonText({ anthropic_tool_result: block }),
        });
        continue;
      }

      input.push({
        role: message.role,
        content: [{
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: jsonText({ anthropic_content_block: block }),
        }],
      });
    }
  }
  return input;
}

/**
 * 统计一次 compact 输入的体积构成，供 `phase=compact_start` 落盘。
 *
 * 生产实测（tencent1，24.4 小时窗口）：472 次 compact 尝试里 440 次失败，失败原因
 * 100% 是上游 400 `Prompt is too long`，零例外。但此前 `compact_start` 只打
 * `items=N`，而 items 和成败几乎无关——成功过 875 items 的，失败过 142 items 的，
 * 区间大幅重叠。真正决定生死的是**字节体积**，没有这个数就没法给"超限前先裁剪"
 * 定阈值，所以这里把字节按 item 类型拆开。
 *
 * 两类最可能的膨胀来源都在拆分里单列：
 * - `thinking` —— ★ 8.7 起 `anthropicHistoryToCompactCodexInput` 已经在源头丢弃
 *   thinking/redacted_thinking 块（见该函数头部注释），这个桶今后应当恒为空；
 *   保留这条分类不是没用了，是观测这次修复是否生效的直接信号——如果某天这个
 *   桶又非空了，说明丢弃逻辑被绕过或回归了。历史遗留说明：这里一度是 compact
 *   与普通路径体积差的 91.2%（无损序列化按设计 100% 保留，普通请求路径 100%
 *   丢弃），是 8.7 这次改动要修的目标本身；
 * - `tool_result` —— 上游模型元数据里明写了 `truncationPolicyLimit: 10000`，原生
 *   codex 据此在写入时就截断工具输出，我们完全没用这个字段，整段原样带走。
 *   ★ 8.7 附带实测：把 tool_result 截到这个阈值，中位数只省 3.2% 体积——不是
 *   主要杠杆，`planCompactRequestForBudget` 仍然会用它兜底裁一次，但不能指望
 *   它单独解决超限问题。
 */
export function summarizeCompactInputBytes(input: CodexInputItem[]): {
  totalBytes: number;
  breakdown: string;
  /**
   * ★ #115：`classifyInputItem` 的 `"image"`/`"text"` 桶字节数单列出来——
   * 团队评估 #112 时确认"cheap 估算失真的两个已知根因之一就是图片"（另一个
   * 是分词器熔断外推），#115 落地"cheap 来源放宽阈值"之后，这两个数直接
   * 供 `budget_exceeded` 事件做内容画像：同样是 `estimate_source:"cheap"`
   * 触发的放宽，图片占比高的请求和纯文本大请求是完全不同的失真机制，混在
   * 一起没法回答"这次放宽到底救回了哪一类误判"。
   *
   * 沿用 `classifyInputItem` 已有的分类口径，**不是**新开一套统计逻辑——
   * 已知的不精确之处同样沿用该函数文档的注意事项（只看每个 item 的第一个
   * content part 归类，多 part 混合内容会把字节计入第一个 part 的桶）。
   */
  imageBytes: number;
  textBytes: number;
} {
  const buckets = new Map<string, { count: number; bytes: number }>();
  let totalBytes = 0;
  for (const item of input) {
    const bytes = Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    totalBytes += bytes;
    const kind = classifyInputItem(item);
    const slot = buckets.get(kind) ?? { count: 0, bytes: 0 };
    slot.count += 1;
    slot.bytes += bytes;
    buckets.set(kind, slot);
  }
  const breakdown = [...buckets.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([kind, v]) => `${kind}:${v.count}/${v.bytes}`)
    .join(",");
  return {
    totalBytes,
    breakdown,
    imageBytes: buckets.get("image")?.bytes ?? 0,
    textBytes: buckets.get("text")?.bytes ?? 0,
  };
}

/** 给单个 input item 归类，用于体积拆分；只看结构，不改内容。 */
function classifyInputItem(item: CodexInputItem): string {
  if ("type" in item) {
    if (item.type === "function_call") return "tool_call";
    if (item.type === "function_call_output") return "tool_result";
    return "other";
  }
  const content = item.content;
  if (typeof content === "string") return "text";
  const first = content[0];
  if (!first) return "empty";
  if (first.type === "input_image") return "image";
  // 无法映射成原生 Codex 结构的 Anthropic 块被 anthropicHistoryToCompactCodexInput
  // 包成 {"anthropic_content_block":…} 原样带走（例如 document、未来新增的块类型）；
  // 要拆出来必须解回去看内层 type。★ 8.7 起 thinking / redacted_thinking 不再走
  // 这条路——它们在源头就被丢弃，根本不会出现在 input 里，因此也不会被这里分类
  // 出来（这个函数不需要为它们特殊处理，是因为它们已经不存在了，不是因为这里
  // 漏看）。parse 只发生在这个前缀命中时，且 compact 不是热路径（一次会话一次），
  // 成本可接受；解析失败一律归到 wrapped 而不是猜。
  const text = "text" in first ? first.text : "";
  if (!text.startsWith("{\"anthropic_content_block\":")) return "text";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.anthropic_content_block)) {
      const innerType = parsed.anthropic_content_block.type;
      if (typeof innerType === "string") return innerType;
    }
  } catch {
    // 落到 wrapped
  }
  return "wrapped";
}

function messagesBeforeCompactPrompt(
  req: AnthropicMessagesRequest,
): AnthropicMessagesRequest["messages"] {
  const history = req.messages.slice(0, -1);
  const lastMessage = req.messages.at(-1);
  if (!lastMessage || typeof lastMessage.content === "string") return history;

  const candidate = extractTrailingCompactText(lastMessage.content);
  if (candidate === null) return history;
  const remainingContent = lastMessage.content.filter(
    (_block, index) => index !== candidate.promptBlockIndex,
  );
  if (remainingContent.length === 0) return history;

  // Claude Code may coalesce preceding user text and the compact instruction in
  // one message. Remove only the text block that matched the compact prompt.
  return [
    ...history,
    { ...lastMessage, content: remainingContent },
  ];
}

export interface ClaudeCodeOpaqueCompactRequest {
  compactRequest: CodexCompactRequest;
  preservedTail: CodexInputItem[];
}

function isFunctionCallItem(
  item: CodexInputItem | undefined,
): item is Extract<CodexInputItem, { type: "function_call" }> {
  return item !== undefined && "type" in item && item.type === "function_call";
}

function isFunctionCallOutputItem(
  item: CodexInputItem | undefined,
): item is Extract<CodexInputItem, { type: "function_call_output" }> {
  return item !== undefined && "type" in item && item.type === "function_call_output";
}

function splitTrailingCompletedToolChain(input: CodexInputItem[]): {
  compactInput: CodexInputItem[];
  preservedTail: CodexInputItem[];
} {
  let outputStart = input.length;
  while (outputStart > 0 && isFunctionCallOutputItem(input[outputStart - 1])) {
    outputStart -= 1;
  }
  if (outputStart === input.length) return { compactInput: input, preservedTail: [] };

  let callStart = outputStart;
  while (callStart > 0 && isFunctionCallItem(input[callStart - 1])) {
    callStart -= 1;
  }
  if (callStart === outputStart) return { compactInput: input, preservedTail: [] };

  const calls = input.slice(callStart, outputStart).filter(isFunctionCallItem);
  const outputs = input.slice(outputStart).filter(isFunctionCallOutputItem);
  const callIds = calls.map((item) => item.call_id);
  const outputIds = outputs.map((item) => item.call_id);
  const uniqueCallIds = new Set(callIds);
  const uniqueOutputIds = new Set(outputIds);
  if (
    uniqueCallIds.size !== calls.length ||
    uniqueOutputIds.size !== outputs.length ||
    uniqueCallIds.size !== uniqueOutputIds.size ||
    [...uniqueCallIds].some((callId) => !uniqueOutputIds.has(callId))
  ) {
    return { compactInput: input, preservedTail: [] };
  }

  return {
    compactInput: input.slice(0, callStart),
    preservedTail: input.slice(callStart),
  };
}

export function buildClaudeCodeOpaqueCompactRequest(
  req: AnthropicMessagesRequest,
  translated: CodexResponsesRequest,
): ClaudeCodeOpaqueCompactRequest {
  const compactRequest = buildClaudeCodeCompactRequest(req, translated);
  const split = splitTrailingCompletedToolChain(compactRequest.input);
  return {
    compactRequest: { ...compactRequest, input: split.compactInput },
    preservedTail: split.preservedTail,
  };
}

export function buildClaudeCodeCompactRequest(
  req: AnthropicMessagesRequest,
  translated: CodexResponsesRequest,
): CodexCompactRequest {
  return {
    model: translated.model,
    input: anthropicHistoryToCompactCodexInput(messagesBeforeCompactPrompt(req)),
    instructions: translated.instructions ?? "",
    ...(translated.tools?.length ? { tools: translated.tools } : {}),
    ...(translated.parallel_tool_calls !== undefined ? { parallel_tool_calls: translated.parallel_tool_calls } : {}),
    ...(translated.reasoning ? { reasoning: translated.reasoning } : {}),
    ...(translated.text ? { text: translated.text } : {}),
    ...(translated.service_tier ? { service_tier: translated.service_tier } : {}),
    ...(translated.prompt_cache_key ? { prompt_cache_key: translated.prompt_cache_key } : {}),
    ...(translated.client_metadata ? { client_metadata: translated.client_metadata } : {}),
    ...(translated.turnState ? { turnState: translated.turnState } : {}),
    ...(translated.turnMetadata ? { turnMetadata: translated.turnMetadata } : {}),
    ...(translated.betaFeatures ? { betaFeatures: translated.betaFeatures } : {}),
    ...(translated.version ? { version: translated.version } : {}),
    ...(translated.includeTimingMetrics ? { includeTimingMetrics: translated.includeTimingMetrics } : {}),
    ...(translated.codexWindowId ? { codexWindowId: translated.codexWindowId } : {}),
    ...(translated.parentThreadId ? { parentThreadId: translated.parentThreadId } : {}),
  };
}

/**
 * compact 请求的**语义**摘要（内容寻址 edge 的 digest 分量）。
 *
 * 设计意图：同一条 lineage 上"这次 compact 到底压缩了什么"必须由请求内容本身
 * 决定，而不是由客户端可自由变化的传输/路由字段决定。因此这里只取真正影响
 * compact 输出语义的字段，按**固定顺序**投影成一个对象再 JSON.stringify：
 *
 *   model, input, instructions, tools, parallel_tool_calls, reasoning, text, service_tier
 *
 * 被**显式排除**的是 transport/routing 字段：prompt_cache_key、client_metadata、
 * turnState、turnMetadata、version、betaFeatures、includeTimingMetrics、
 * codexWindowId、parentThreadId。它们每次请求都可能变（缓存键、窗口 id、
 * 客户端版本号），把它们纳入 digest 会让同一份历史产生无穷多个 edge，
 * 内容寻址退化成随机寻址。
 *
 * 缺失与空值统一策略：可选字段一律归一到一个确定的空值（tools → `[]`，
 * 其余 → `null`），因此"字段缺失"与"字段为空数组/空对象"得到同一个 digest，
 * 不会因为上游翻译层的写法差异分裂成两条 edge。
 */
export function opaqueCompactSemanticDigest(request: CodexCompactRequest): string {
  const projection = {
    model: request.model,
    input: request.input,
    instructions: request.instructions ?? "",
    // 缺失与空数组必须等价：翻译层对"无工具"两种写法都出现过。
    tools: request.tools?.length ? request.tools : [],
    parallel_tool_calls: request.parallel_tool_calls ?? null,
    reasoning: request.reasoning ?? null,
    text: request.text ?? null,
    service_tier: normalizeServiceTierForUpstream(request.service_tier) ?? null,
  };
  return createHash("sha256").update(canonicalJson(projection)).digest("base64url");
}

/**
 * ★ 8.8 · compact 输入的 token 预算表——按型号校准，不用单一常量、也不用
 * 声明值乘系数。
 *
 * 起因：v2.0.88 生产实测撞过一次真实误判——`gpt-5.6-terra` 当时不在表里，
 * 退到旧默认值 260,000，一个 350,454 token、**本来能成功**的请求（terra
 * 实测能吃到 405,173）被误判超限，降级到全量压缩慢路径，用户自己感知到
 * 变慢。这次重写就是修这个真实回归，不是预防性加固。
 *
 * qa 完整实测矩阵（8 个带 `contextWindow` 声明的型号全测了，17 次真实调用；
 * "成功最大"一律是上游真实返回的 `usage.input_tokens`；"最小失败"里带 ★ 的
 * 是按 chars/2.18 **估算**——400 响应不带 usage，量不到真实值，两种数字
 * 确定性不同，不要混用）：
 *
 *   | 型号 | 声明 ctxWindow/maxCtx | 成功最大（真实 usage） | 最小失败 | vs 声明值 |
 *   |---|---|---|---|---|
 *   | gpt-5.4              | 272,000 / 1,000,000 | 715,220 | ~966,382★ | 2.63x（但没到声明的 100 万） |
 *   | codex-auto-review    | 272,000 / 272,000   | 611,760 | 未找到失败点 | ≥2.25x |
 *   | gpt-5.6-terra        | 272,000 / 272,000   | 405,173 | ~457,681★ | 1.49x |
 *   | gpt-5.6-luna         | 272,000 / 272,000   | 405,128 | ~509,000  | 1.49x |
 *   | gpt-5.6-sol          | 272,000 / 272,000   | 405,083 | 未测到    | 1.49x |
 *   | gpt-5.5              | 272,000 / 272,000   | 284,961 | ~405,251★ | ~1.05x |
 *   | gpt-5.4-mini         | 272,000 / 272,000   | 271,261 | ~285,000  | ~1.00x |
 *   | gpt-5.3-codex-spark  | 128,000 / 128,000   | 119,036 | ~128,448★ | ~0.93x |
 *
 * ★★ 结论一：「声明值 × 固定系数」这条路彻底死了。同样声明 272000，实测
 * 从 1.00x（mini）到 2.63x（gpt-5.4），差 2.63 倍——不存在一个系数能同时
 * 拟合这整张表。任何试图用公式从 `getModelInfo(model)?.contextWindow` 推导
 * 预算的做法都是错的，只能逐型号实测入表，这也是为什么 `COMPACT_TOKEN_
 * BUDGET_BY_MODEL` 是一张手工维护的表而不是一个函数。
 *
 * ★★ 结论二：`gpt-5.3-codex-spark` 是唯一的反例，也是最危险的一个——它的
 * 真实上限几乎贴着声明值走（~0.93x），**不是"留了安全边际"，是"声明值
 * 基本可信"**。如果照着其他型号"实测普遍是声明值 1.49 倍"的经验给它套
 * 激进预算（比如 390,000），会直接把它推过真实上限 3.3 倍，必炸。所以
 * spark 的预算必须单独按它自己的实测下界给，不能跟着别的型号"抄近路"。
 *
 * 每档预算 = 实测成功最大值打 ~95% 折（留出估算噪声——字节→token 是近似
 * 换算，见 `estimateCompactInputTokens`——的余量），同代且实测值接近的型号
 * 才合并同一档；gpt-5.5（284,961）虽然和 sol/terra/luna 同代但实测明显更低，
 * 刻意没有合并进 390,000 那一档。
 */
const COMPACT_TOKEN_BUDGET_BY_MODEL: Readonly<Record<string, number>> = {
  "gpt-5.3-codex-spark": 110_000,
  "gpt-5.4-mini": 260_000,
  "gpt-5.5": 270_000,
  "gpt-5.6-sol": 390_000,
  "gpt-5.6-terra": 390_000,
  "gpt-5.6-luna": 390_000,
  "codex-auto-review": 580_000,
  "gpt-5.4": 680_000,
};

/**
 * 未入表型号（大概率是尚未出现过的新型号）的兜底预算——**刻意维持
 * 260,000，不跟着 spark 的实测下界（119,036）往下压**。两个方向的权衡
 * 不对称，理由：
 *
 * - 已知的小窗口型号（mini、spark）现在都显式入表了，兜底只服务于未来
 *   新出现、还没实测过的型号；新型号大概率是新一代，容量倾向于更大而不是
 *   更小（本轮 8 型号矩阵里除 spark 外全部 ≥260,000），260,000 对它们是
 *   保守估计，不是激进估计。
 * - 就算某个未来型号真的撞了这个预算线，后果是"多裁剪/多降级一次"，
 *   `planCompactRequestForBudget` 判定超限后会走降级路径而不是 409 杀
 *   会话（8.7 已经把这条路接住了）——是慢，不是错。
 * - 反过来把兜底压到 spark 的量级（110,000），会让所有未来新模型的正常
 *   大小请求一律被预判拦下、无谓走慢路径，且这个代价是确定会发生的（每个
 *   新模型的每次正常请求都要交这份税），不像"撞线"只在极端会话才发生。
 *   两个方向都不会导致数据损坏或误判成功（降级路径本身安全），但错误的
 *   代价不对称，所以选对新模型更友好的方向。
 */
const COMPACT_TOKEN_BUDGET_DEFAULT = 260_000;

export function resolveCompactTokenBudget(model: string): number {
  return COMPACT_TOKEN_BUDGET_BY_MODEL[model] ?? COMPACT_TOKEN_BUDGET_DEFAULT;
}

/**
 * 字节 → token 的粗估换算比例（bytes per token）。
 *
 * ★ 8.9：从 2.18 改成 2.70——**修一个已在生产反复发生的真实误判**，不是
 * 预防性调整。
 *
 * 起因：同一个真实会话连续三次 recompact 全部被误判超限降级，用户亲眼看到
 * 压缩跑了 14 分钟还卡在全量生成慢路径（`rid=39587bd5/2d362c85/5cb8f88c`，
 * `estimated_tokens≈448k`，`budget_tokens=390000`）。但客户端状态栏当时
 * 显示的上下文是 87%/300k≈261k token——我们估的 448k 和客户端认的 261k
 * 差 1.72 倍。
 *
 * 根因：2.18 这个比例来自 qa 早期用 `find-limit.mts` 在**合成负载**
 * （`base-items-diverse.json`）上测出的 chars/token，从来没有在真实会话上
 * 验证过。qa 后来用真实会话（`c382c880` 切片）做端到端实测，拿真实
 * `usage.input_tokens`（上游返回值，不是估算）配对 bodyChars，测出来的是：
 *
 *   | 样本 | bodyChars | 真实 usage.input_tokens | 真实 chars/token |
 *   |---|---|---|---|
 *   | rung1-A | 919,302 | 340,394 | 2.70 |
 *   | rung2-B | 943,018 | 282,519 | 3.34 |
 *   | rung3-B | 1,040,657 | 312,084 | 3.33 |
 *
 * 真实会话是 2.70–3.34，合成负载测出来的 2.18 明显偏低——验算那次生产
 * 事故：`448457 × 2.18 / 2.70 ≈ 362,065`，低于预算 390,000，本来完全能
 * 成功，不该被降级。这个数量级和"客户端 261k + tools ~47k ≈ 308k"三方
 * 互相印证。
 *
 * ★★ 权衡方向反转，且必须写清楚为什么——防止以后又被改回小值：8.7 最初
 * 取区间下界（更小值→换算出更多 token→更容易触发降级）的理由是"高估是
 * 安全方向的误差，低估才危险（会放过本该拦截的请求，白打一次注定失败的
 * 上游调用）"。这个推理只在**两个方向的后果对称**时成立，但实测下来根本
 * 不对称：
 *
 * - 高估的代价：无谓降级，**这条路径已经在生产反复发生**（上面这次事故是
 *   连续三次），每次都让用户白等一次全量生成的时间。
 * - 低估的代价：撞上游 400——但 8.7 已经把这条路接住了，`messages.ts` 对
 *   `isPromptTooLongLike` 的判断会让它降级返回 200，不是 409 杀会话，只是
 *   浪费一次上游往返。而且这个代价**至今一次都没在生产发生过**（零次
 *   `Prompt is too long`）。
 *
 * 所以"往保守方向取"这件事本身没错，错的是"保守"当初被理解成"往小取"——
 * 真正的保守方向是"贴着真实会话实测的下界走"，即 2.70（三个真实样本里
 * 最小的那个），而不是盲目取一个更小的数字。2.70 比真实中位数 3.33 还
 * 保守 23%，留了噪声余量，但不会像 2.18 那样系统性地把正常大小的会话
 * 判成超限。
 *
 * 已知失真且刻意不修：base64 图片的字节数和真实 image token 数几乎无关
 * （图片按像素网格计费，不是按 base64 文本长度），这里仍然按统一比例换算，
 * 会明显高估图片占的 token 数。这条结论不受这次调整影响——生产已知的巨大
 * 失败请求（8.9MB、95% 是图片）无论用 2.18 还是 2.70 换算都远超任何型号的
 * 预算，而这正是团队已确认"怎么裁都救不回来"的那类请求：高估图片的 token
 * 数只会让它更早被判定超预算、更早跳过压缩改走降级，不会漏判成"看起来
 * 还好"。
 */
const COMPACT_BYTES_PER_TOKEN_ESTIMATE = 2.70;

/**
 * ★ 8.11：这个比例式估算现在只当"粗筛"用，不再是唯一的估算手段——见
 * `planCompactRequestForBudget`。粗筛的角色决定了它必须继续保持"系统性
 * 偏高"这个方向性质：只有粗筛怀疑超限时才会触发下面更贵的精确估算
 * （`estimateCompactInputTokensPrecise`，真分词器），如果粗筛本身开始
 * 系统性偏低，会让一部分真正超限的请求连粗筛这一关都过不了、永远摸不到
 * 精确估算，直接把超预算的请求放给上游。
 */
export function estimateCompactInputTokens(totalBytes: number): number {
  return Math.ceil(totalBytes / COMPACT_BYTES_PER_TOKEN_ESTIMATE);
}

/**
 * 每个 input item 的固定结构开销（token）——弥补"只 tokenize 语义内容、
 * 不 tokenize JSON 包装"必然产生的欠估。
 *
 * 依据（评估阶段 4 组真实样本，见 `compact-tokenizer.ts` 头部注释里引用的
 * 完整数据）：隐含结构开销实测在 2.86～5.94 token/item 之间波动，取中间值
 * 4，四组样本全部压到 <0.5% 误差。★ 这个常数只用 4 组样本校准，样本全部
 * 来自同一个用户、同一个模型（gpt-5.6-sol）——`compact-outcome-log.ts`
 * 落盘的 `estimated_tokens`/`budget_tokens` 会随生产流量持续积累更多真实
 * 配对，以后有条件时应该用更大样本重新校准，见 `estimate-accuracy.test.ts`
 * 头部注释。这里的回归测试只锁"这个常数没有离谱漂移"（2~8 token/item 的
 * 合理区间），不锁死具体等于 4。★ 导出仅供
 * `codex-compact-per-item-overhead.test.ts` 的回归断言使用——那条测试锁的
 * 是"这个常数没有离谱漂移"，不是重新推导它应该等于多少。
 */
export const PER_ITEM_TOKEN_OVERHEAD = 4;

/**
 * 精确估算（分词器 + 结构开销模型）之上再叠加的安全边际。
 *
 * ★ 8.11：分词器把误差带从 ±41% 收窄到 <1.5%，但**不能撤掉边际**——分词器
 * 模拟的是 OpenAI 公开的 o200k_base 编码表，不是上游内部真正用来计费的
 * 那一套（我们看不到，也没有渠道验证两者是否逐字节一致）。评估阶段实测的
 * 最大误差是 1.47%（rung3-B，未加结构开销修正前），这里留 3%——大约是
 * 实测最大误差的 2 倍，覆盖"评估用的 4 组样本没覆盖到的内容形态"这类
 * 未知风险，同时远小于旧的比例估算法需要的边际（2.70 那套隐含了几十个
 * 百分点的安全冗余）。
 */
const TOKENIZER_ESTIMATE_SAFETY_MARGIN = 1.03;

/**
 * 一次 compact 请求里是否含有图片内容（`input_image` content part）。
 *
 * ★ 8.11：图片是分词器路径刻意排除在外的盲区，必须显式处理，不能"碰巧
 * 没处理"——评估阶段用的 4 组真实样本都不含图片，没有真实数据支撑"给图片
 * 一个固定 token 估算值"这个做法准不准。base64 图片的字节数和真实 image
 * token 数几乎无关（图片按像素网格计费，不是按 base64 文本长度），把一大段
 * base64 喂给分词器只会得到一个毫无意义的数字，可能离谱高估也可能离谱
 * 低估。
 *
 * 选择：含图片的请求**整体跳过精确估算**，退回粗筛比例估算——粗筛对图片
 * 天然保守（`estimateCompactInputTokens` 头部注释：base64 字节数会把图片
 * 的 token 占用系统性高估，让含图片的大请求更容易被判超预算、更早改走
 * 降级，不会漏判成"看起来还好"）。这是团队评估阶段列的两个选项之一
 * （另一个是"按张数/尺寸给图片估一个固定值"）——这里选前者，因为它不需要
 * 新增一个同样没有真实数据支撑的估算模型，且和现状（8.9 之前）的安全性质
 * 完全一致，只是现在明确知道并且写下来了这是故意的选择，不是遗漏。
 */
function compactRequestHasImageContent(compactRequest: CodexCompactRequest): boolean {
  for (const item of compactRequest.input) {
    if ("type" in item) continue; // function_call / function_call_output 不携带图片
    if (typeof item.content === "string") continue;
    if (item.content.some((part) => part.type === "input_image")) return true;
  }
  return false;
}

/**
 * 从一次 compact 请求里抽出"语义内容"——文本/参数/输出字符串，去掉 JSON
 * 包装（字段名、引号、花括号）。这是分词器路径能达到 <1.5% 误差的关键
 * 前提，见 `compact-tokenizer.ts` 头部注释里"为什么不能直接 tokenize
 * JSON.stringify"那段完整论证，这里不重复。
 *
 * 结构上和 `summarizeCompactInputBytes`/`classifyInputItem` 走的是同一套
 * "按 item 类型分派"模式（team-lead 要求"复用它的结构"）——但这里要的是
 * 语义文本本身，不是字节长度，所以是并列的独立实现，不是同一个函数的
 * 两种用法。
 *
 * `input_image` 内容 part 被跳过（不进 tokenize 批次）——纵深防御：真正
 * 挡住图片请求走到这个函数的是 `compactRequestHasImageContent` 那道闸门
 * （`planCompactRequestForBudget` 里调用），这里的 skip 只是防御性的，
 * 万一闸门被绕过也不会把一大段 base64 塞进分词器。
 */
function extractCompactContentForTokenizing(
  compactRequest: CodexCompactRequest,
): { contentText: string; itemCount: number } {
  const parts: string[] = [];
  if (compactRequest.instructions) parts.push(compactRequest.instructions);

  for (const item of compactRequest.input) {
    if ("type" in item) {
      if (item.type === "function_call") {
        parts.push(item.name, item.arguments);
      } else if (item.type === "function_call_output") {
        parts.push(item.output);
      }
      continue;
    }
    if (typeof item.content === "string") {
      parts.push(item.content);
      continue;
    }
    for (const part of item.content) {
      if (part.type === "input_image") continue; // 见函数文档"纵深防御"说明
      if ("text" in part) parts.push(part.text);
    }
  }

  if (compactRequest.tools?.length) {
    for (const tool of compactRequest.tools) parts.push(JSON.stringify(tool));
  }

  return { contentText: parts.join("\n"), itemCount: compactRequest.input.length };
}

/**
 * 精确估算：语义内容真实 tokenize + 每 item 固定结构开销 + 安全边际。
 *
 * 调用方（`planCompactRequestForBudget`）只在粗筛（`estimateCompactInputTokens`）
 * 已经判定超限时才会调用这个函数——分词器的懒加载成本因此只有"粗筛怀疑
 * 超限"的请求才会真正付出，正常大小的会话永远不会触发。
 *
 * 返回 `null` 时（分词器加载失败——理论上不该发生，防御性处理）调用方
 * 必须回退到粗筛估算，不能让整条 compact 链路因为分词器不可用而报错。
 *
 * ★ #97：`extrapolated`/`processedFraction` 原样透传自
 * `tokenizeCompactContent`——安全边际/每 item 开销只影响 `tokens` 这个
 * 数值本身，不影响"这个数是不是外推出来的"这个判断，两件事独立。
 */
async function estimateCompactInputTokensPrecise(
  compactRequest: CodexCompactRequest,
): Promise<{ tokens: number; extrapolated: boolean; processedFraction?: number } | null> {
  const { contentText, itemCount } = extractCompactContentForTokenizing(compactRequest);
  const contentResult = await tokenizeCompactContent(contentText);
  if (contentResult === null) return null;
  const raw = contentResult.tokens + itemCount * PER_ITEM_TOKEN_OVERHEAD;
  return {
    tokens: Math.ceil(raw * TOKENIZER_ESTIMATE_SAFETY_MARGIN),
    extrapolated: contentResult.extrapolated,
    processedFraction: contentResult.processedFraction,
  };
}

/**
 * 给一次预算判定选一种估算方法：含图片时强制粗筛（见
 * `compactRequestHasImageContent` 文档）；否则尝试精确估算，精确估算不可用
 * （分词器加载失败）时回退粗筛。返回的 `source`/`processedFraction` 供
 * 调用方打日志/落盘诊断用，不参与判定本身。
 *
 * ★ #97（team-lead 派发，reviewer 交叉审查 #96 时发现的观测缺口）：`source`
 * 从两值（`"cheap" | "tokenizer"`）扩成三值——半截版本（只加
 * `"cheap"`/`"tokenizer"` 两值、不区分外推）会把"精确算完的 417K"和
 * "熔断后从 20% 外推的 417K"标成同一个 `"tokenizer"`，两者可信度天差
 * 地别，共用一个标签比完全不记录更糟（"tokenizer"会被误读成"这个数
 * 很准"）——这正是这整轮改动一直在治的"不同根因共用同一个标签"，不能
 * 在这里自己重新制造一次。
 */
async function estimateTokensForBudgetCheck(
  compactRequest: CodexCompactRequest,
  toolsBytes: number,
): Promise<{ tokens: number; source: "cheap" | "precise" | "precise_extrapolated"; processedFraction?: number }> {
  if (!compactRequestHasImageContent(compactRequest)) {
    const precise = await estimateCompactInputTokensPrecise(compactRequest);
    if (precise !== null) {
      return precise.extrapolated
        ? { tokens: precise.tokens, source: "precise_extrapolated", processedFraction: precise.processedFraction }
        : { tokens: precise.tokens, source: "precise" };
    }
  }
  const { totalBytes } = summarizeCompactInputBytes(compactRequest.input);
  return { tokens: estimateCompactInputTokens(totalBytes + toolsBytes), source: "cheap" };
}

/**
 * 超限时的兜底裁剪——对齐原生 codex 的
 * `trim_function_call_history_to_fit_context_window`（`codex-rs` 的
 * `compact_remote.rs`）：把体积最大的几条 tool 输出替换成占位文本，不整体
 * 丢弃对话内容，也不裁 `tools`（裁了模型就不知道有哪些工具可用，语义损失
 * 远大于省下的字节）。
 *
 * ★ 不要指望它救场：生产实测把 tool_result 截到 `perOutputByteLimit`（10000
 * 字节，来自上游模型元数据 `truncationPolicyLimit`，原生 codex 用同一个值
 * 在写入历史时就截断），中位数只省 3.2% 体积。真正的膨胀来源是 thinking
 * （task #24 已经在源头去掉）和 `tools` 定义本身（固定 ~101KB，这里没法裁）。
 * 这一步存在的意义是"能省一点是一点，省不下来就诚实承认裁不动"，不是
 * 主要的超限对策——真正兜底的是 `planCompactRequestForBudget` 在裁完仍然
 * 超预算时上报 `withinBudget:false`，交给调用方跳过这次 compact、直接降级。
 */
export function trimCompactInputForBudget(
  input: CodexInputItem[],
  perOutputByteLimit: number,
): { input: CodexInputItem[]; trimmedCount: number } {
  let trimmedCount = 0;
  const trimmed = input.map((item) => {
    if (!("type" in item) || item.type !== "function_call_output") return item;
    const outputBytes = Buffer.byteLength(item.output, "utf8");
    if (outputBytes <= perOutputByteLimit) return item;
    trimmedCount += 1;
    // 按字符数近似截断（不是精确字节边界）——多字节字符可能被切在中间，
    // 但这里只是"省点体积"的尽力而为，不是需要精确的安全边界，简单更可靠。
    return {
      ...item,
      output:
        `${item.output.slice(0, perOutputByteLimit)}` +
        `\n...[truncated ${outputBytes - perOutputByteLimit} bytes to fit compact budget]`,
    };
  });
  return { input: trimmed, trimmedCount };
}

/**
 * ★ #115（用户拍板，原话"大胆一点"，#112 评估阶段已确认根因）：`cheap`
 * 来源的估算——即精确分词器整条路径都没跑（含图片，见
 * `compactRequestHasImageContent`）或跑失败退回粗筛的那两种"算不准"场景
 * ——预判阈值从 `budgetTokens` 放宽到 `budgetTokens × CHEAP_ESTIMATE_BUDGET_MULTIPLIER`，
 * 超过放宽后的阈值才直接跳过上游；`budgetTokens` ~ `budgetTokens × 4` 之间
 * 放行给上游，用真实的 400/成功结果裁决，不再由这一个粗筛数字说了算。
 *
 * 为什么只动 `cheap`、`precise`/`precise_extrapolated` 一行不动：分词器
 * 路径实测误差 <1.5%（`TOKENIZER_ESTIMATE_SAFETY_MARGIN` 头部注释），
 * 可信——可信的判断没有理由放宽，放宽等于主动引入误判。`cheap` 恰恰相反，
 * 它触发预算预判拦截的场景本来就是"我们不信任这个数字，但没有更好的
 * 数字"（含图片的请求：base64 字节数和真实 image token 数几乎无关，见
 * `estimateCompactInputTokens` 头部注释；分词器加载/执行失败：极端 edge
 * case，不应该由一个连自己都不准的数字去承担"一次性拦死"的后果）——算不
 * 准就不该硬拦截，该做的是把决定权交给真正知道答案的一方（上游）。
 *
 * 为什么是 4 不是别的倍数——★ forensics 从生产捞的真实取证（不是拍脑袋，
 * 也不是只有下面这条定性论据）：4 个 `budget_exceeded` 样本、模型
 * `gpt-5.6-sol`（预算 390000），估算 vs 真实 `usage.input_tokens` 高估比例：
 *
 * | rid        | 估算 tokens | 真实 input | 高估   |
 * |------------|------------|-----------|--------|
 * | e7fd8794   | 868679     | 267633    | 3.25x  |
 * | d19cf0a5   | 589908     | 267699    | 2.20x  |
 * | bbfa4d06   | 460656     | 254247    | 1.81x  |
 * | 355e4ffb   | 453885     | 263436    | 1.72x  |
 *
 * 四次真实值全部落在预算（390000）以下——四次都是误判。最大高估 3.25x，
 * 4× 在这个实测下界之上留了余量，同时仍然覆盖 `estimateCompactInputTokens`
 * 头部注释记录的那个已知极端案例（8.9MB、95% 图片，无论按 2.18 还是 2.70
 * 换算都远超任何型号预算的数量级）——4× 放宽后那类请求仍然拦得住，不会把
 * "确定救不回来"的请求放给上游白打一次。
 *
 * ★★ 这份数据必须带着两条限定一起看，否则会被当成比实际更强的证据：
 *
 * 1. **样本是 2 个独立会话，不是 4 个独立样本**——按 `conv_hash` 去重后，
 *    `d19cf0a5`/`bbfa4d06`/`355e4ffb` 是同一会话（`74cb4942`）的三次连续
 *    尝试，`e7fd8794` 属于另一个会话（`91c1ac60`）。**n=2，不足以单独定
 *    任何分组常数**（比如"图片类" vs "纯文本大会话类"分别应该放宽多少）
 *    ——这正是加 `has_image`/`image_bytes`/`text_bytes` 埋点的原因：等
 *    生产样本攒够了，才能把 4 这个笼统数字拆成分内容类型的、真正有统计
 *    意义的校准值。
 * 2. **有一个未查明的异常，不强行解释**——同一会话 `74cb4942` 的三次尝试
 *    里，第 1 次走的是"图片豁免"路径（`estimate_source=cheap`，27ms，
 *    没碰分词器），后 2 次走的是"分词器熔断"路径（`estimate_source=cheap`，
 *    ~4100ms，触发 2000ms 熔断退回粗筛）——内容大概率相近（同一会话连续
 *    尝试）却被分类进了两种不同的"算不准"机制。**不能排除熔断路径这两次
 *    的根源其实也是图片**（即两条看似独立的失真机制，实际可能是同一个
 *    根因在不同代码路径上的两种表现）。forensics 和这次评估都只把它标记
 *    为"未查明"，没有强行给出机制解释——这条注释延续同样的克制，不在这里
 *    编一个听起来合理但没有验证过的归因。
 *
 * **4 这个数字的定位：是有实测下界（3.25x）支撑、留了余量的起点值，不是
 * 校准结果**——n=2 不足以说"4 就是对的"，只能说"4 在已知的 2 个会话样本
 * 之上留了安全边际，且没有让已知极端案例失守"。等埋点攒够生产样本、能
 * 按内容类型分组之后，应该重新审视这个数字，不是把它当成长期不变的常数。
 *
 * 不动 `COMPACT_TOKEN_BUDGET_BY_MODEL`（每型号真实测过的预算表）和
 * `CUMULATIVE_TIME_BUDGET_MS`/`MIN_PROCESSED_FRACTION_FOR_EXTRAPOLATION`
 * （分词器熔断的 2000ms/20% 阈值）——这两处是团队#115 派发时明确划定的
 * 边界，不在这次评估范围内，改动会混淆"哪个改动对应哪个观测"。
 */
const CHEAP_ESTIMATE_BUDGET_MULTIPLIER = 4;

/**
 * ★ #115：单个估算是否落在（放宽后的）预算内。`source !== "cheap"` 时
 * 恒等于原始的"严格不超预算"判断，不受这次改动影响；`source === "cheap"`
 * 时额外放宽到 `budgetTokens × CHEAP_ESTIMATE_BUDGET_MULTIPLIER`，见
 * `CHEAP_ESTIMATE_BUDGET_MULTIPLIER` 头部的完整理由。抽成一个函数而不是
 * 在 `planCompactRequestForBudget` 里散落判断，是因为同一条放宽规则要在
 * 两个阶段（裁剪前的 `refined`、裁剪后的 `final`）各判一次，两处逻辑必须
 * 保持逐字一致——散落写两遍是下一次改阈值时漏改一处的现成陷阱。
 */
function isEstimateWithinBudget(
  tokens: number,
  budgetTokens: number,
  source: "cheap" | "precise" | "precise_extrapolated",
): boolean {
  if (tokens <= budgetTokens) return true;
  if (source !== "cheap") return false;
  return tokens <= budgetTokens * CHEAP_ESTIMATE_BUDGET_MULTIPLIER;
}

/** 单次预算校验的结果——`withinBudget:false` 时调用方应当放弃这次 compact，改走降级。 */
export interface CompactBudgetPlan {
  compactRequest: CodexCompactRequest;
  estimatedTokens: number;
  budgetTokens: number;
  withinBudget: boolean;
  trimmedCount: number;
  /**
   * ★ 8.11 起有这个字段，★ #97（team-lead 派发）扩成三值：这次
   * `estimatedTokens` 是用哪种方法算出来的——`"cheap"`（字节比例粗筛，粗筛
   * 本身就在预算内，没必要为了确认再付分词器加载成本）、`"precise"`（粗筛
   * 怀疑超限后触发的精确估算，完整跑完没有熔断）、`"precise_extrapolated"`
   * （精确估算触发了 2000ms 熔断，是按已处理比例外推出来的，可信度明显
   * 低于 `"precise"`——半截版本把这个值也标成 `"precise"` 会比完全不记录
   * 更糟，见 `estimateTokensForBudgetCheck` 文档）。
   *
   * ★ #115 更新：这句话此前是"纯诊断字段，不参与 withinBudget 判定本身"——
   * #115 之后不再成立。`source === "cheap"` 时，`withinBudget` 的判定阈值
   * 会放宽到 `budgetTokens × CHEAP_ESTIMATE_BUDGET_MULTIPLIER`，见
   * `isEstimateWithinBudget`。这个字段现在既是诊断字段，也直接参与
   * `withinBudget` 的计算。
   */
  estimateSource: "cheap" | "precise" | "precise_extrapolated";
  /** 仅 `estimateSource === "precise_extrapolated"` 时有值，见同名字段在 `tokenizeCompactContent` 的文档。 */
  processedFraction?: number;
  /**
   * ★ #97：`planCompactRequestForBudget` 一进来就会算一次粗筛值（下面的
   * `cheapEstimate`）用于短路判断——不管最终 `estimateSource` 是不是
   * `"cheap"`，这个值都已经算出来了，白白丢掉可惜。带上它，每一条
   * `budget_exceeded` 记录就变成一个"粗筛 vs 精确"的真实标定样本，以后
   * 校准 `COMPACT_BYTES_PER_TOKEN_ESTIMATE` 这类比例常数可以直接从生产
   * 数据读，不用再像 8.9 那次靠 qa 专门跑真实会话切片人工标定。
   */
  cheapEstimateTokens: number;
  /**
   * ★ #115：这次请求是否含图片内容（`compactRequestHasImageContent`，跟
   * 决定"是否整体退回粗筛"用的是同一个判断，不是另开一套口径）。图片是
   * `cheap` 来源两个已知失真场景之一，这个字段配合下面的
   * `imageBytes`/`textBytes`，让 `budget_exceeded` 事件能回答"这次放宽
   * 到底救回的是图片请求还是纯文本大请求"——不带这个字段，`estimate_source:
   * "cheap"` 本身分不出这两类，是完全不同的失真机制（见
   * `CHEAP_ESTIMATE_BUDGET_MULTIPLIER` 头部文档）。
   */
  hasImage: boolean;
  /** ★ #115：见 `summarizeCompactInputBytes` 对应字段文档，取自裁剪前的原始 input。 */
  imageBytes: number;
  /** ★ #115：见 `summarizeCompactInputBytes` 对应字段文档，取自裁剪前的原始 input。 */
  textBytes: number;
}

/**
 * ★ 8.7 · 发上游前的预算校验：估算体积 → 和型号预算比 → 超了就裁一次
 * （`trimCompactInputForBudget`）→ 仍然超就诚实报告"裁不动"（`withinBudget:
 * false`），交给调用方决定要不要跳过这次 compact、直接走降级——不在这里
 * 抛错，抛错意味着"这是个异常"，但"这个会话大到压不动"是可以预见的正常
 * 情况，应该由调用方（`respondWithOpaqueCompactMarker`）显式决定下一步，
 * 而不是靠 catch 一个 throw 出来的东西反推。
 *
 * `tools` 也计入体积（固定 ~101KB ≈ 47K token，生产实测），因为它是真实
 * 送上游的一部分——只统计 `input` 会系统性低估。
 *
 * ★ 8.11 · 两级估算，不是"直接上分词器"：
 *
 *   1. 粗筛（`estimateCompactInputTokens`，字节比例，零加载成本）——它
 *      本来就系统性偏高（见头部注释），如果连粗筛都判定在预算内，精确值
 *      只会更小，没必要为了"确认"再付一次分词器懒加载成本（~200ms + 2.3MB
 *      内存）。这是"懒加载"这个要求的核心：正常大小的会话（多数请求）
 *      永远不会触发分词器加载。
 *   2. 粗筛怀疑超限后，才用 `estimateTokensForBudgetCheck`（精确估算，
 *      含图片时强制退回粗筛，见该函数与 `compactRequestHasImageContent`
 *      的文档）重新核算一遍——这一步存在的意义正是修 terra 那类"粗筛本身
 *      就估错了"的误判：粗筛说超了，不代表真的超了，精确估算才是真正
 *      拍板的依据。
 *
 * 裁剪之后的重新核算同样走两级估算（`estimateTokensForBudgetCheck`），
 * 不会在裁剪后退化回只用粗筛——裁剪本身省不了多少（见
 * `trimCompactInputForBudget` 文档"中位数只省3.2%"），精确估算在裁剪前后
 * 都应该是更可信的判据。
 *
 * ★ #115：下面两处 `withinBudget` 判断都改成走 `isEstimateWithinBudget`
 * 而不是裸的 `tokens <= budgetTokens`——`source === "cheap"` 时会按
 * `CHEAP_ESTIMATE_BUDGET_MULTIPLIER` 放宽阈值，`source` 是 `"precise"`/
 * `"precise_extrapolated"` 时该函数行为跟放宽前逐字节一致（`tokens <=
 * budgetTokens` 那一支），不是"顺手也放宽了精确路径"。
 */
export async function planCompactRequestForBudget(
  compactRequest: CodexCompactRequest,
): Promise<CompactBudgetPlan> {
  const budgetTokens = resolveCompactTokenBudget(compactRequest.model);
  const toolsBytes = compactRequest.tools?.length
    ? Buffer.byteLength(JSON.stringify(compactRequest.tools), "utf8")
    : 0;

  const initial = summarizeCompactInputBytes(compactRequest.input);
  // ★ #115：只在裁剪前的原始 input 上算一次，见 `CompactBudgetPlan.hasImage`
  // 等字段文档——裁剪只动 function_call_output 的文本内容，不会新增/去掉
  // 图片，用裁剪前的值即可代表整次请求的内容画像，不需要在每个分支重算。
  const hasImage = compactRequestHasImageContent(compactRequest);
  const cheapEstimate = estimateCompactInputTokens(initial.totalBytes + toolsBytes);
  if (cheapEstimate <= budgetTokens) {
    return {
      compactRequest,
      estimatedTokens: cheapEstimate,
      budgetTokens,
      withinBudget: true,
      trimmedCount: 0,
      estimateSource: "cheap",
      cheapEstimateTokens: cheapEstimate,
      hasImage,
      imageBytes: initial.imageBytes,
      textBytes: initial.textBytes,
    };
  }

  const refined = await estimateTokensForBudgetCheck(compactRequest, toolsBytes);
  if (isEstimateWithinBudget(refined.tokens, budgetTokens, refined.source)) {
    return {
      compactRequest,
      estimatedTokens: refined.tokens,
      budgetTokens,
      withinBudget: true,
      trimmedCount: 0,
      estimateSource: refined.source,
      processedFraction: refined.processedFraction,
      cheapEstimateTokens: cheapEstimate,
      hasImage,
      imageBytes: initial.imageBytes,
      textBytes: initial.textBytes,
    };
  }

  const perOutputByteLimit = getModelInfo(compactRequest.model)?.truncationPolicyLimit ?? 10_000;
  const { input: trimmedInput, trimmedCount } = trimCompactInputForBudget(compactRequest.input, perOutputByteLimit);
  const trimmedRequest: CodexCompactRequest =
    trimmedCount > 0 ? { ...compactRequest, input: trimmedInput } : compactRequest;
  const final = await estimateTokensForBudgetCheck(trimmedRequest, toolsBytes);

  return {
    compactRequest: trimmedRequest,
    estimatedTokens: final.tokens,
    budgetTokens,
    withinBudget: isEstimateWithinBudget(final.tokens, budgetTokens, final.source),
    trimmedCount,
    estimateSource: final.source,
    processedFraction: final.processedFraction,
    // ★ #97：这个字段永远是"这次判断一开始、对原始（裁剪前）内容算出的
    // 粗筛值"，不重新对 `trimmedRequest` 算一次。★ 标定时的注意事项：
    // 走到这条分支说明发生过裁剪，`estimatedTokens`（= `final.tokens`）
    // 是对**裁剪后**内容算的精确值，跟这里的 `cheapEstimateTokens`（对
    // **裁剪前**内容算的）内容范围不完全一致，不是严格意义上的同一份
    // 内容的两种估算——拿这一对做比例标定前，先看 `trimmedCount` 是否为
    // 0；`trimmedCount === 0` 时（多数情况，`trimCompactInputForBudget`
    // 文档记录过"中位数只省 3.2%"）两者内容范围一致，是干净的标定样本。
    cheapEstimateTokens: cheapEstimate,
    hasImage,
    imageBytes: initial.imageBytes,
    textBytes: initial.textBytes,
  };
}

export interface CompactOnlyResult {
  output: unknown[];
  entryId: string;
  compactLatencyMs: number;
}

/**
 * ★ 8.10：`skippedUpstream`/`promptTooLong`/`estimatedTokens`/`budgetTokens`
 * 这四个字段是本轮新增，专门解决 reviewer 复审 task #24/#25 时提过、这次
 * Dashboard 需求又撞上第二次的同一个问题——此前调用方只能靠对
 * `error.message` 做字符串匹配（比如判断有没有那句 "skipping upstream
 * compact call"）来区分"预算预判提前拦下的降级"和"真打了上游被拒"，
 * 任何人改一下文案就会让判断静默失效。这里改成显式的结构化字段，调用方
 * 直接读，不用再解析文本。
 *
 * 刻意没有做的事：没有把这次改动扩大成一次错误传递机制重构（team-lead
 * 明确划的边界）——`isPromptTooLongLike` 对 `error.message`/上游原始文本
 * 的字符串匹配**没有被这几个字段取代**，那部分是在分类"上游返回的自由
 * 文本属于哪一类"，本质上就得读文本，不是这次要解决的脆弱性。这几个
 * 字段解决的只是"我们自己已经分类好的结果，要不要再重新解析一遍"这一层。
 */
export interface CompactServiceErrorClassification {
  /**
   * true 当且仅当这次失败在预算预判阶段就被拦下（`opaque-compact-bridge.ts`
   * 的 `planCompactRequestForBudget` 判定 `withinBudget:false`），从未真正
   * 联系上游、没有账号租约发生。false（默认）表示确实打了上游，不管上游
   * 是否真的返回了响应。
   */
  skippedUpstream?: boolean;
  /**
   * true 当且仅当这次失败被分类为"会话大到塞不下"这一类（不管是预算预判
   * 提前拦下的，还是真打了上游被判定 `Prompt is too long`）——`messages.ts`
   * 判断要不要跳过 409、改走降级时直接读这个字段。
   */
  promptTooLong?: boolean;
  /** 仅 `skippedUpstream:true` 时有意义：预算预判阶段算出的估算 token 数。 */
  estimatedTokens?: number;
  /** 仅 `skippedUpstream:true` 时有意义：当时对应型号的预算 token 数。 */
  budgetTokens?: number;
  /**
   * ★ #97（team-lead 派发，reviewer 交叉审查 #96 时发现的观测缺口）：
   * `estimatedTokens` 是用哪种方法算出来的，见 `CompactBudgetPlan.estimateSource`
   * 同名字段的完整文档——这里只是把 `planCompactRequestForBudget` 已经
   * 算出的值原样透传到 `budget_exceeded` 这条 outcome 记录上。仅
   * `skippedUpstream:true` 时有意义。
   */
  estimateSource?: "cheap" | "precise" | "precise_extrapolated";
  /** 仅 `estimateSource === "precise_extrapolated"` 时有值，见同名字段在 `tokenizeCompactContent` 的文档。 */
  processedFraction?: number;
  /**
   * ★ #97：`planCompactRequestForBudget` 判断一开始就会算的粗筛值，跟
   * `estimatedTokens`（可能是精确值）并存——每一条 `budget_exceeded`
   * 记录因此变成一个"粗筛 vs 精确"的真实标定样本，见
   * `CompactBudgetPlan.cheapEstimateTokens` 的完整文档（含"裁剪发生时两者
   * 内容范围不完全一致"的注意事项）。仅 `skippedUpstream:true` 时有意义。
   */
  cheapEstimateTokens?: number;
  /**
   * ★ #83：`recompact_failed_original_account` 聚合桶的失败子因。
   *
   * 命名经 team-lead 请 scout 仲裁过（scout 初稿建议了一套 `upstream_*`/
   * `bound_account_*` 前缀风格，仲裁结论是这套无前缀命名在这个受限值域内
   * 不含歧义，维持原样，"纯风格差异，不要求改"）。协议层（stale_generation
   * 等）的取值直接复用 `OpaqueCompactStateFailure` 现成的值——见
   * `messages.ts` 的 `deriveRecompactFailureCause`，理由同样是仲裁结论：
   * 同一个 CAS 失败只应该有一个 machine-readable 名字，另造一套前缀等价名
   * 是"一对多命名分裂"，跟这次要治的"多对一聚合丢分类"是同一个病的镜像。
   *
   * 401 拆成 `account_deactivated`/`token_expired` 两个值同样经仲裁确认
   * 保留——依据是 `handleCodexApiError` 内部本来就有的 isDeactivated 判据
   * （`pool.markStatus` 分别标 banned/expired），拆分只是把代码里已经区分
   * 出来的信息透传出来，不是新加的维度，合并回一个值反而会丢信息。
   */
  cause?: RecompactFailureCause;
  /**
   * ★ #88：这次尝试从 `respondWithOpaqueCompactMarker` 入口到这次失败为止
   * 的总耗时（毫秒）。不是在 `executeCompactOnly` 内部各个 throw site 现场
   * 算的——那样起点会变成"进 executeCompactOnly 那一刻"，漏掉 bridge 层
   * budget 预判/digest 计算/幂等回放查询的时间，跟 `success` outcome 的
   * `duration_ms`（起点是 bridge 入口）语义就不一致，两种 outcome 的耗时
   * 数字没法直接比较。做法见 `opaque-compact-bridge.ts` 里包一层
   * try/catch，用同一个 `started` 补这个字段后再重新抛出。
   */
  durationMs?: number;
  /**
   * ★ #88：这次失败尝试真正花在等上游响应的时间——只在真的发出过一次
   * `createCompactResponse` 调用、拿到失败响应/错误之后才有值（即
   * `executeCompactOnly` 内部 catch 块里设置，`durationMs` 是 bridge 层
   * 补的总耗时，`upstreamMs` 是这个总耗时里"确定花在上游"的那一段）。
   * 耗尽重试放弃时，这个值是**最后一次**尝试的上游耗时，不是所有已尝试
   * 账号的耗时总和（那个用 `retryCount` 看"换了几个账号"，是另一个维度）。
   * 从未真正联系上游的失败（no_account/account_mismatch/budget_exceeded）
   * 没有这个字段，不强凑 0。
   */
  upstreamMs?: number;
  /**
   * ★ #115：见 `CompactBudgetPlan.hasImage` 同名字段文档。仅
   * `skippedUpstream:true` 时有意义——透传自 `planCompactRequestForBudget`
   * 的 `budgetPlan.hasImage`。
   */
  hasImage?: boolean;
  /** ★ #115：见 `CompactBudgetPlan.imageBytes` 同名字段文档。仅 `skippedUpstream:true` 时有意义。 */
  imageBytes?: number;
  /** ★ #115：见 `CompactBudgetPlan.textBytes` 同名字段文档。仅 `skippedUpstream:true` 时有意义。 */
  textBytes?: number;
}

/**
 * ★ #83：`executeCompactOnly` 内部失败原因的结构化分类，供 `messages.ts`
 * 的 `recompact_failed_original_account` 聚合点拆分子因（此前所有走
 * `requiredEntryId` 跨账号闸门的失败，无论上游真实原因是什么，都被改写成
 * 同一句"账号失败、不重试"文案+409，具体分类在 `codex-compact-service.ts:
 * 1109-1151` 这一步就已经丢了，不是后面哪个日志 sink 没接对）。
 *
 * `no_account_available`/`bound_account_unavailable` 是 `executeCompactOnly`
 * 自己在联系上游之前就能确定的两种"根本没打成"，固定赋值，不需要分类器：
 * 前者是账号池整体没有可用租约（含 root compact 场景），后者是池子返回了
 * 账号、但不是这次 recompact 绑定的那一个（调度/affinity 不变量出问题，
 * 从未真正发起过 compact 调用）——两者语义不同，命名刻意不合并，仲裁已
 * 确认这个划分合理。其余的值来自 `classifyCompactUpstreamFailure`。
 */
export type RecompactFailureCause =
  | "no_account_available"
  | "bound_account_unavailable"
  | "prompt_too_long"
  | "model_not_supported"
  | "rate_limited"
  | "quota_exhausted"
  | "account_banned"
  | "account_deactivated"
  | "token_expired"
  | "cf_path_block"
  /**
   * ★ #83（scout 仲裁后补）：`err.status === 0` 的 transport 层失败——
   * `CodexApiError(0, msg)` 在 `codex-api.ts:527-533` 的 HTTP transport
   * throw 处产生，`proxy-error-handler.ts:78-86` 的注释把它解释为
   * timeout/connection reset/TLS 失败。此前这类失败无条件落进
   * `generic_upstream_error`，是"已经拥有但没透传的信息"，跟 #83 的目的
   * 正好相反，必须单独一个值：已知是 transient/网络类，#80 做 cooldown
   * allowlist 时必须明确排除，不能被 generic 的模糊语义连坐。
   *
   * 判据必须精确是 `err.status === 0`，不是某个范围——见下面
   * `classifyCompactUpstreamFailure` 顶部关于"为什么不拆 5xx"的说明，
   * 那条陷阱同样适用于任何试图按 status 范围猜测失败性质的写法。
   */
  | "transport_failure"
  | "generic_upstream_error"
  | "unexpected_error";

/**
 * 判据必须来自 `handleCodexApiError()` 命中的原始分支（对 `err` 的分类），
 * 不能从 `decision.status`/`decision.message` 反推——多个分支可能落到同一个
 * status（比如 model-not-supported 重试用尽后的 respond 分支与真正未分类的
 * 通用 4xx/5xx 都可能走 `toErrorStatus(err.status)`），反推等于把已经丢失
 * 的信息再猜一遍，猜错的成本比"暂时没有这个字段"更高。
 *
 * 因此这里直接复用 `handleCodexApiError` 自己用来分类的同一批 predicate
 * 函数，按它内部完全相同的优先级顺序判断（见 `proxy-error-handler.ts:
 * 92-205`）——两处判据必须保持同步，`handleCodexApiError` 加新分支时这里
 * 也要加。不复制它的副作用（`pool.markStatus`/`cookieJar.clear` 等）：
 * 那些已经由 `handleCodexApiError` 自己做过了，这里只是"再问一遍同样的
 * 问题"来定性，不重复产生副作用。
 *
 * ★ 明确不拆的地方（scout 仲裁否掉过、别再加回来）：不按 `status >= 500`
 * 分出一个 `upstream_server_error`/`upstream_transport_or_5xx`。原因是
 * `codex-api.ts:555-570` 会把 JSON 解析失败之类的**本地检测**问题人为包成
 * `CodexApiError(502, "Compact response is not valid JSON...")`——按状态码
 * 范围分类会把"远端真的 5xx"和"本地判定 payload 无效"混成同一个新分类，
 * 而且因为名字看起来更精确，这个混淆比笼统的 generic 更难被发现。真要拆，
 * 必须在 `CodexApiError` 创建处带结构化 origin/kind（transport /
 * upstream_http_5xx / invalid_compact_json / event_translation），不能从
 * 最终 status 反推——这个方向已经建了 #90 待排期，这次不做。
 */
function classifyCompactUpstreamFailure(err: CodexApiError): RecompactFailureCause {
  if (isPromptTooLongLike(err.body) || isPromptTooLongLike(err.message)) return "prompt_too_long";
  if (isModelNotSupportedError(err)) return "model_not_supported";
  if (err.status === 429) return "rate_limited";
  if (isQuotaExhaustedError(err)) return "quota_exhausted";
  if (isBanError(err)) return "account_banned";
  if (isTokenInvalidError(err)) {
    // 跟 handleCodexApiError 内部区分 banned/expired 的判据完全一致
    // （proxy-error-handler.ts 的 isDeactivated 分支）。
    return err.message.toLowerCase().includes("deactivated") ? "account_deactivated" : "token_expired";
  }
  if (isCfPathBlockError(err)) return "cf_path_block";
  if (err.status === 0) return "transport_failure";
  return "generic_upstream_error";
}

export class CompactServiceError extends Error {
  readonly skippedUpstream: boolean;
  readonly promptTooLong: boolean;
  readonly estimatedTokens?: number;
  readonly budgetTokens?: number;
  readonly cause?: RecompactFailureCause;
  /** ★ #97：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly estimateSource?: "cheap" | "precise" | "precise_extrapolated";
  /** ★ #97：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly processedFraction?: number;
  /** ★ #97：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly cheapEstimateTokens?: number;
  readonly durationMs?: number;
  readonly upstreamMs?: number;
  /** ★ #115：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly hasImage?: boolean;
  /** ★ #115：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly imageBytes?: number;
  /** ★ #115：见 CompactServiceErrorClassification 同名字段文档。 */
  readonly textBytes?: number;

  constructor(
    message: string,
    readonly status: number,
    readonly useFormat429 = false,
    /**
     * 这次 compact 尝试之前一共拿过多少个不同账号（含最终失败的这一个）。
     * 纯粹是可观测性字段——不影响任何分支决策，只用于诊断"是账号池太小
     * 一次就放弃，还是真的轮了好几个账号都不行"。调用方（`messages.ts`）
     * 把它透传进 `recordOpaqueCompactFallback` 的 `retry_count`。
     */
    readonly retryCount?: number,
    classification: CompactServiceErrorClassification = {},
  ) {
    super(message);
    this.name = "CompactServiceError";
    this.skippedUpstream = classification.skippedUpstream ?? false;
    this.promptTooLong = classification.promptTooLong ?? false;
    this.estimatedTokens = classification.estimatedTokens;
    this.budgetTokens = classification.budgetTokens;
    this.cause = classification.cause;
    this.estimateSource = classification.estimateSource;
    this.processedFraction = classification.processedFraction;
    this.cheapEstimateTokens = classification.cheapEstimateTokens;
    this.durationMs = classification.durationMs;
    this.upstreamMs = classification.upstreamMs;
    this.hasImage = classification.hasImage;
    this.imageBytes = classification.imageBytes;
    this.textBytes = classification.textBytes;
  }
}

/**
 * 一次 compact 调用需要的账号租约上下文——`executeCompactOnly`（opaque 专用）
 * 与 classic `executeCompactRender` 共用的最小字段集合。拆成独立接口而不是
 * 让 `executeCompactOnly` 继续靠 `Omit<ExecuteCompactRenderOptions, ...>`
 * 派生：classic 移除后 `ExecuteCompactRenderOptions`/`executeCompactRender`
 * 会一起消失，届时 opaque 唯一的执行函数不能还结构性依赖一个已删除概念的
 * 残留类型。
 */
export interface CompactAccountLeaseOptions {
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  compactRequest: CodexCompactRequest;
  signal: AbortSignal;
  requestId?: string;
  requiredEntryId?: string;
}

export async function executeCompactOnly(options: CompactAccountLeaseOptions): Promise<CompactOnlyResult> {
  const { accountPool, cookieJar, proxyPool, compactRequest, signal, requestId, requiredEntryId } = options;
  const tag = "ClaudeOpaqueCompact";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();
  let modelRetried = false;
  let acquired = acquireAccount(accountPool, compactRequest.model, undefined, tag, requiredEntryId);
  if (!acquired) {
    // acquireAccount 本身已经打过一行带账号池状态构成的 warn（见
    // account-acquisition.ts）；这里再补一行 rid 关联的 phase 标记，方便
    // 按 rid 在日志流里定位到"从一开始就没账号可用"这一类失败。
    console.warn(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_no_account model=${compactRequest.model}`);
    throw new CompactServiceError(
      "No available accounts. All accounts are expired or rate-limited.",
      503, false, 0,
      { cause: "no_account_available" },
    );
  }
  if (requiredEntryId !== undefined && acquired.entryId !== requiredEntryId) {
    console.warn(
      `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_account_mismatch` +
        ` required=${auditAccountTag(requiredEntryId)} got=${auditAccountTag(acquired.entryId)}`,
    );
    // usage: undefined 是对的——账号不匹配，从未发起过 compact 调用，没有响应体。
    releaseAccount(accountPool, acquired.entryId, undefined, released);
    throw new CompactServiceError(
      "The compact state account is unavailable.",
      409, false, 1,
      { cause: "bound_account_unavailable" },
    );
  }

  let entryId = acquired.entryId;
  let api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  triedEntryIds.push(entryId);

  for (;;) {
    // ★ #88：声明在 try 外面——catch 块也需要用它算这次失败尝试花了多久
    // 联系上游（`upstreamMs`），而 try 块内部的 const 出了 try 就访问不到。
    let compactStarted = Date.now();
    try {
      await staggerIfNeeded(acquired.prevSlotMs, {}, signal);
      compactStarted = Date.now();
      const inputSize = summarizeCompactInputBytes(compactRequest.input);
      console.log(
        `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_start acct=${auditAccountTag(entryId)}` +
          ` items=${compactRequest.input.length} bytes=${inputSize.totalBytes} by_kind=${inputSize.breakdown}`,
      );
      const compactResult = await withRetry(
        () => api.createCompactResponse(compactRequest, signal, (rateLimits) => {
          applyParsedRateLimits({ accountPool, entryId, rateLimits });
        }),
        { tag, signal },
      );
      const compactLatencyMs = Date.now() - compactStarted;
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_end acct=${auditAccountTag(entryId)} items=${compactResult.output.length} latency_ms=${compactLatencyMs}`);
      // qa 实测：compact 响应带真实 usage，但此前六处 releaseAccount 调用
      // 全部传 undefined——账号轮转的本地 usage 统计因此把每一次 compact
      // 都记成 0 token（同规模：1 次 compact +0，1 次普通请求 +41756）。
      // 这是六处里**唯一**的成功路径（其余五处要么在拿到响应之前就失败，
      // 要么是重试/中止分支，压根没有响应体可传）——失败路径继续传
      // undefined 是对的，不是漏改，见下方各分支旁的说明。
      // compactResult.usage 缺失时保持 undefined（不是 0）：upstream 没给
      // 就是"不知道"，recordUsage 对 undefined 字段本来就是 no-op 累加，
      // 不会把"未知"污染成"确实是 0"。
      releaseAccount(accountPool, entryId, compactResult.usage, released);
      return { output: compactResult.output, entryId, compactLatencyMs };
    } catch (error) {
      if (signal.aborted) {
        // usage: undefined 是对的——请求被中止，不存在完整响应体。
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      if (!(error instanceof CodexApiError)) {
        // 非 CodexApiError（比如响应体解析异常、意料之外的 JS 异常）——不走
        // 分类/重试，直接冒泡。这类失败此前完全没有 phase 标记，和"上游
        // 分类后决定不重试"混在一起分不清，单独打一行区分。
        console.warn(
          `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_unexpected_error` +
            ` error_name=${error instanceof Error ? error.name : typeof error}` +
            ` message=${sanitizeFreeTextForLog(error instanceof Error ? error.message : String(error))}`,
        );
        // usage: undefined 是对的——非 CodexApiError 的意外异常，没有可信响应体。
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      const decision = handleCodexApiError(error, accountPool, entryId, compactRequest.model, tag, modelRetried, cookieJar, true);
      // ★ #83：在跨账号闸门改写 decision.message/status **之前**，先从原始
      // `error`（CodexApiError）独立分类出这次失败的子因——见
      // `classifyCompactUpstreamFailure` 的文档，判据必须来自
      // `handleCodexApiError` 命中的原始分支，不能从改写后的 decision 反推。
      const upstreamCause = classifyCompactUpstreamFailure(error);
      // ★ 8.7（task #25）修复：`requiredEntryId` 分支此前**无条件**把
      // decision.message/status 换成通用的"跨账号不重试"文案+409——recompact
      // （marker 已把记录钉死在一个账号上）永远走这条分支，所以哪怕
      // `handleCodexApiError` 已经把失败原因精确分类成 prompt-too-long
      // （`proxy-error-handler.ts` 最前面那条 `isPromptTooLongLike` 检查），
      // 这里也会把分类信息整个抹掉，换成"账号失败、不重试"——`messages.ts`
      // 那边靠 `isPromptTooLongLike(fallbackErrorMessage)` 判断"要不要降级
      // 而不是 409"的逻辑因此永远看不到真实原因，是这次改动实测撞上的
      // 真实回归（e2e 测试跑出来的，不是纸面推演）。
      //
      // 修法：只有 prompt-too-long 这一类精确分类的失败才透传原始
      // decision.message/status，穿过 requiredEntryId 的限制；其余所有
      // "respond"失败（模型不支持、通用错误……）在 requiredEntryId 存在时
      // 仍然维持原样——统一换成通用的跨账号文案。刻意不推广成"只要
      // decision.action==='respond' 就透传"：那会把这次改动的影响面从
      // "prompt-too-long 可降级"扩大到"recompact 的所有失败原因都直接
      // 透传给客户端"，超出 task #25 的范围，也违背之前评估这次改动时定的
      // 原则——只信任有生产证据支撑的那一类失败，不做无依据的泛化。
      const isPromptTooLongFailure = decision.action === "respond" && isPromptTooLongLike(decision.message);
      if (decision.action === "respond" || requiredEntryId !== undefined) {
            // usage: undefined 是对的——上游返回的是错误分类结果，不是一次成功的 compact 响应。
            releaseAccount(accountPool, entryId, undefined, released);
            const crossAccountBlocked = requiredEntryId !== undefined && !isPromptTooLongFailure;
            console.warn(
              `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_abort` +
                ` reason=${crossAccountBlocked ? "cross_account_retry_disabled" : "non_retryable"}` +
                ` status=${crossAccountBlocked ? 409 : decision.status} tried=${triedEntryIds.length}`,
            );
            throw new CompactServiceError(
              crossAccountBlocked
                ? "The compact state account failed and cross-account retry is disabled."
                : decision.message,
              crossAccountBlocked ? 409 : decision.status,
              false,
              triedEntryIds.length,
              // crossAccountBlocked 已经把"是不是 prompt-too-long"这个判断
              // 消费掉了（!isPromptTooLongFailure 是它的构成条件之一），这里
              // 直接透传 isPromptTooLongFailure 本身——覆盖 crossAccountBlocked
              // 为 false 的两种情况：真实是 prompt-too-long（跨账号限制被
              // 绕过），或者是 root compact（requiredEntryId 本来就没设）。
              //
              // ★ #83：cause 用 upstreamCause（对原始 error 的独立分类），
              // 不是从 crossAccountBlocked 改写后的 message/status 反推——
              // 这正是本次要保留下来、此前被跨账号闸门抹掉的那部分信息。
              //
              // ★ #88：upstreamMs 是这次失败尝试真正花在联系上游的时间——
              // 即便它失败了，也确实发出去过一次请求、等回来了响应/错误，
              // 这段等待时间是真实的"上游耗时"，不是 0。跟 durationMs
              // （总耗时）不同——那个字段由 bridge 层在捕获这个错误时
              // 统一补上，这里不设置。
              {
                promptTooLong: isPromptTooLongFailure,
                cause: upstreamCause,
                upstreamMs: Date.now() - compactStarted,
              },
            );
          }
          // usage: undefined 是对的——这次账号的尝试失败了，即将换账号重试，没有响应体可记。
          releaseAccount(accountPool, entryId, undefined, released);
          if (decision.markModelRetried) modelRetried = true;
      acquired = acquireAccount(accountPool, compactRequest.model, triedEntryIds, tag);
      if (!acquired) {
        console.warn(
          `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_giveup` +
            ` tried=${triedEntryIds.length} last_status=${decision.status}`,
        );
        throw new CompactServiceError(
          decision.message, decision.status, decision.useFormat429 === true, triedEntryIds.length,
          // ★ #88：upstreamMs 是耗尽重试放弃前**最后这一次**尝试的上游耗时，
          // 不是所有已尝试账号的耗时总和——跟 retryCount 的"总共换了几个
          // 账号"是互补但不同的两个维度。
          { cause: upstreamCause, upstreamMs: Date.now() - compactStarted },
        );
      }
      entryId = acquired.entryId;
      triedEntryIds.push(entryId);
      api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
      console.log(
        `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=account_retry acct=${auditAccountTag(entryId)}` +
          ` prev_status=${decision.status} tried=${triedEntryIds.length}`,
      );
    }
  }
}
