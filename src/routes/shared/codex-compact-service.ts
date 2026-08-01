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
import { buildCodexApi } from "./proxy-handler-utils.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { auditAccountTag } from "./opaque-compact-audit.js";
import { canonicalJson } from "./canonical-json.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";
import { getModelInfo } from "../../models/model-store.js";
import { isPromptTooLongLike } from "../../proxy/prompt-too-long-error.js";

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
  return { totalBytes, breakdown };
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

export function estimateCompactInputTokens(totalBytes: number): number {
  return Math.ceil(totalBytes / COMPACT_BYTES_PER_TOKEN_ESTIMATE);
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

/** 单次预算校验的结果——`withinBudget:false` 时调用方应当放弃这次 compact，改走降级。 */
export interface CompactBudgetPlan {
  compactRequest: CodexCompactRequest;
  estimatedTokens: number;
  budgetTokens: number;
  withinBudget: boolean;
  trimmedCount: number;
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
 */
export function planCompactRequestForBudget(compactRequest: CodexCompactRequest): CompactBudgetPlan {
  const budgetTokens = resolveCompactTokenBudget(compactRequest.model);
  const toolsBytes = compactRequest.tools?.length
    ? Buffer.byteLength(JSON.stringify(compactRequest.tools), "utf8")
    : 0;

  const initial = summarizeCompactInputBytes(compactRequest.input);
  const initialEstimatedTokens = estimateCompactInputTokens(initial.totalBytes + toolsBytes);
  if (initialEstimatedTokens <= budgetTokens) {
    return {
      compactRequest,
      estimatedTokens: initialEstimatedTokens,
      budgetTokens,
      withinBudget: true,
      trimmedCount: 0,
    };
  }

  const perOutputByteLimit = getModelInfo(compactRequest.model)?.truncationPolicyLimit ?? 10_000;
  const { input: trimmedInput, trimmedCount } = trimCompactInputForBudget(compactRequest.input, perOutputByteLimit);
  const trimmedSummary = summarizeCompactInputBytes(trimmedInput);
  const estimatedTokens = estimateCompactInputTokens(trimmedSummary.totalBytes + toolsBytes);

  return {
    compactRequest: trimmedCount > 0 ? { ...compactRequest, input: trimmedInput } : compactRequest,
    estimatedTokens,
    budgetTokens,
    withinBudget: estimatedTokens <= budgetTokens,
    trimmedCount,
  };
}

export interface CompactOnlyResult {
  output: unknown[];
  entryId: string;
  compactLatencyMs: number;
}

export class CompactServiceError extends Error {
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
  ) {
    super(message);
    this.name = "CompactServiceError";
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
    throw new CompactServiceError("No available accounts. All accounts are expired or rate-limited.", 503, false, 0);
  }
  if (requiredEntryId !== undefined && acquired.entryId !== requiredEntryId) {
    console.warn(
      `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_account_mismatch` +
        ` required=${auditAccountTag(requiredEntryId)} got=${auditAccountTag(acquired.entryId)}`,
    );
    // usage: undefined 是对的——账号不匹配，从未发起过 compact 调用，没有响应体。
    releaseAccount(accountPool, acquired.entryId, undefined, released);
    throw new CompactServiceError("The compact state account is unavailable.", 409, false, 1);
  }

  let entryId = acquired.entryId;
  let api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  triedEntryIds.push(entryId);

  for (;;) {
    try {
      await staggerIfNeeded(acquired.prevSlotMs, {}, signal);
      const compactStarted = Date.now();
      const inputSize = summarizeCompactInputBytes(compactRequest.input);
      console.log(
        `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_start acct=${auditAccountTag(entryId)}` +
          ` items=${compactRequest.input.length} bytes=${inputSize.totalBytes} by_kind=${inputSize.breakdown}`,
      );
      const compactResult = await withRetry(
        () => api.createCompactResponse(compactRequest, signal),
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
        throw new CompactServiceError(decision.message, decision.status, decision.useFormat429 === true, triedEntryIds.length);
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
