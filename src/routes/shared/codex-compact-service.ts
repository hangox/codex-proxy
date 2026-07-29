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
 * Convert Anthropic history without silently dropping unfamiliar content blocks.
 * Native Codex equivalents are used where possible; blocks without an equivalent are
 * carried as JSON text so thinking signatures, redacted payloads, documents, and future
 * block types remain available to the compact model byte-for-byte after JSON decoding.
 */
export function anthropicHistoryToLosslessCodexInput(
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
    input: anthropicHistoryToLosslessCodexInput(messagesBeforeCompactPrompt(req)),
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
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_start acct=${auditAccountTag(entryId)} items=${compactRequest.input.length}`);
      const compactResult = await withRetry(
        () => api.createCompactResponse(compactRequest, signal),
        { tag, signal },
      );
      const compactLatencyMs = Date.now() - compactStarted;
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_end acct=${auditAccountTag(entryId)} items=${compactResult.output.length} latency_ms=${compactLatencyMs}`);
      releaseAccount(accountPool, entryId, undefined, released);
      return { output: compactResult.output, entryId, compactLatencyMs };
    } catch (error) {
      if (signal.aborted) {
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
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      const decision = handleCodexApiError(error, accountPool, entryId, compactRequest.model, tag, modelRetried, cookieJar, true);
      if (decision.action === "respond" || requiredEntryId !== undefined) {
            releaseAccount(accountPool, entryId, undefined, released);
            console.warn(
              `[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_abort` +
                ` reason=${requiredEntryId !== undefined ? "cross_account_retry_disabled" : "non_retryable"}` +
                ` status=${requiredEntryId !== undefined ? 409 : decision.status} tried=${triedEntryIds.length}`,
            );
            throw new CompactServiceError(
              requiredEntryId !== undefined
                ? "The compact state account failed and cross-account retry is disabled."
                : decision.message,
              requiredEntryId !== undefined ? 409 : decision.status,
              false,
              triedEntryIds.length,
            );
          }
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
