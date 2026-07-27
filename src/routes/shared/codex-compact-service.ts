import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AccountPool } from "../../auth/account-pool.js";
import { CodexApiError } from "../../proxy/codex-api.js";
import type { CodexApi } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type {
  CodexCompactRequest,
  CodexCompactResponse,
  CodexInputItem,
  CodexResponsesRequest,
} from "../../proxy/codex-types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import {
  iterateCodexEvents,
  preflightContentfulStream,
  type ExtractedEvent,
  type UsageInfo,
} from "../../translation/codex-event-extractor.js";
import { codexApiErrorFromEvent } from "../../translation/codex-api-error-from-event.js";
import { withRetry } from "../../utils/retry.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import type { FormatAdapter } from "./proxy-handler-types.js";
import { buildCodexApi } from "./proxy-handler-utils.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { streamResponse } from "./response-processor.js";

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
    `[ClaudeCompactBridge] phase=fingerprint_partial sections=${structure.score}/${COMPACT_PROMPT_SECTIONS.length}` +
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

export function buildClaudeCodeRenderRequest(
  translated: CodexResponsesRequest,
  compactOutput: unknown[],
  compactPrompt: string,
  useWebSocket: boolean,
): CodexResponsesRequest {
  return {
    model: translated.model,
    instructions: translated.instructions ?? "",
    input: [
      ...compactOutput as CodexInputItem[],
      { role: "user", content: [{ type: "input_text", text: compactPrompt }] },
    ],
    stream: true,
    store: false,
    ...(translated.reasoning ? { reasoning: translated.reasoning } : {}),
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
    ...(useWebSocket ? { useWebSocket: true } : {}),
  };
}

function renderRequestWantsThinking(request: CodexResponsesRequest): boolean {
  return request.reasoning?.summary !== undefined;
}

function rejectPreContentError(stream: AsyncIterable<ExtractedEvent>): AsyncIterable<ExtractedEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.error) throw codexApiErrorFromEvent(event.error);
        yield event;
      }
    },
  };
}

export interface CompactRenderLease {
  response: AsyncIterable<ExtractedEvent>;
  api: CodexApi;
  entryId: string;
  released: Set<string>;
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
  ) {
    super(message);
    this.name = "CompactServiceError";
  }
}

export interface ExecuteCompactRenderOptions {
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  compactRequest: CodexCompactRequest;
  renderTemplate: CodexResponsesRequest;
  compactPrompt: string;
  signal: AbortSignal;
  requestId?: string;
  requiredEntryId?: string;
}

export async function executeCompactOnly(options: Omit<ExecuteCompactRenderOptions, "renderTemplate" | "compactPrompt">): Promise<CompactOnlyResult> {
  const { accountPool, cookieJar, proxyPool, compactRequest, signal, requestId, requiredEntryId } = options;
  const tag = "ClaudeOpaqueCompact";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();
  let modelRetried = false;
  let acquired = acquireAccount(accountPool, compactRequest.model, undefined, tag, requiredEntryId);
  if (!acquired) throw new CompactServiceError("No available accounts. All accounts are expired or rate-limited.", 503);
  if (requiredEntryId !== undefined && acquired.entryId !== requiredEntryId) {
    releaseAccount(accountPool, acquired.entryId, undefined, released);
    throw new CompactServiceError("The compact state account is unavailable.", 409);
  }

  let entryId = acquired.entryId;
  let api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  triedEntryIds.push(entryId);

  for (;;) {
    try {
      await staggerIfNeeded(acquired.prevSlotMs, {}, signal);
      const compactStarted = Date.now();
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_start entry=${entryId} items=${compactRequest.input.length}`);
      const compactResult = await withRetry(
        () => api.createCompactResponse(compactRequest, signal),
        { tag, signal },
      );
      const compactLatencyMs = Date.now() - compactStarted;
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_end entry=${entryId} items=${compactResult.output.length} latency_ms=${compactLatencyMs}`);
      releaseAccount(accountPool, entryId, undefined, released);
      return { output: compactResult.output, entryId, compactLatencyMs };
    } catch (error) {
      if (signal.aborted) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      if (!(error instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      const decision = handleCodexApiError(error, accountPool, entryId, compactRequest.model, tag, modelRetried, cookieJar, true);
      if (decision.action === "respond" || requiredEntryId !== undefined) {
            releaseAccount(accountPool, entryId, undefined, released);
            throw new CompactServiceError(
              requiredEntryId !== undefined
                ? "The compact state account failed and cross-account retry is disabled."
                : decision.message,
              requiredEntryId !== undefined ? 409 : decision.status,
            );
          }
          releaseAccount(accountPool, entryId, undefined, released);
          if (decision.markModelRetried) modelRetried = true;
      acquired = acquireAccount(accountPool, compactRequest.model, triedEntryIds, tag);
      if (!acquired) {
        throw new CompactServiceError(decision.message, decision.status, decision.useFormat429 === true);
      }
      entryId = acquired.entryId;
      triedEntryIds.push(entryId);
      api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=account_retry entry=${entryId}`);
    }
  }
}

/** Execute compact and render while holding one account lease for both upstream calls. */
export async function executeCompactRender(options: ExecuteCompactRenderOptions): Promise<CompactRenderLease> {
  const { accountPool, cookieJar, proxyPool, compactRequest, renderTemplate, compactPrompt, signal, requestId } = options;
  const tag = "ClaudeCompactBridge";
  const triedEntryIds: string[] = [];
  const released = new Set<string>();
  let modelRetried = false;
  let acquired = acquireAccount(accountPool, compactRequest.model, undefined, tag);
  if (!acquired) throw new CompactServiceError("No available accounts. All accounts are expired or rate-limited.", 503);

  let entryId = acquired.entryId;
  let api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
  triedEntryIds.push(entryId);

  for (;;) {
    try {
      await staggerIfNeeded(acquired.prevSlotMs, {}, signal);
      const compactStarted = Date.now();
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_start entry=${entryId} items=${compactRequest.input.length}`);
      const compactResult = await withRetry(
        () => api.createCompactResponse(compactRequest, signal),
        { tag, signal },
      );
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=compact_end entry=${entryId} items=${compactResult.output.length} latency_ms=${Date.now() - compactStarted}`);

      const renderStarted = Date.now();
      const requestWithOutput = buildClaudeCodeRenderRequest(
        renderTemplate,
        compactResult.output,
        compactPrompt,
        renderTemplate.useWebSocket === true,
      );
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=render_start entry=${entryId} items=${requestWithOutput.input.length}`);
      const response = await withRetry(
        () => api.createResponse(requestWithOutput, signal),
        { tag, signal },
      );
      const preflight = await preflightContentfulStream(
        rejectPreContentError(iterateCodexEvents(api, response)),
        { includeReasoning: renderRequestWantsThinking(requestWithOutput) },
      );
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=render_preflight entry=${entryId} latency_ms=${Date.now() - renderStarted}`);
      return { response: preflight.stream, api, entryId, released };
    } catch (error) {
      if (signal.aborted) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      if (!(error instanceof CodexApiError)) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw error;
      }
      const decision = handleCodexApiError(error, accountPool, entryId, compactRequest.model, tag, modelRetried, cookieJar, true);
      if (decision.action === "respond") {
        releaseAccount(accountPool, entryId, undefined, released);
        throw new CompactServiceError(decision.message, decision.status);
      }
      // A bridge retry always restarts the compact+render group on another
      // account. Release the current slot before acquiring the replacement,
      // regardless of the ordinary handler's releaseBeforeRetry hint.
      releaseAccount(accountPool, entryId, undefined, released);
      if (decision.markModelRetried) modelRetried = true;
      acquired = acquireAccount(accountPool, compactRequest.model, triedEntryIds, tag);
      if (!acquired) {
        releaseAccount(accountPool, entryId, undefined, released);
        throw new CompactServiceError(decision.message, decision.status, decision.useFormat429 === true);
      }
      entryId = acquired.entryId;
      triedEntryIds.push(entryId);
      api = buildCodexApi(acquired.token, acquired.accountId, cookieJar, entryId, proxyPool);
      console.log(`[${tag}] rid=${requestId?.slice(0, 8) ?? "-"} phase=account_retry entry=${entryId}`);
    }
  }
}

export async function respondWithCompactRender(options: {
  c: Context;
  accountPool: AccountPool;
  lease: CompactRenderLease;
  fmt: FormatAdapter;
  model: string;
  requestId: string;
  abortController: AbortController;
}): Promise<Response> {
  const { c, accountPool, lease, fmt, model, requestId, abortController } = options;
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  let usage: UsageInfo | undefined;
  return stream(c, async (writer) => {
    writer.onAbort(() => {
      abortController.abort();
      console.warn(`[ClaudeCompactBridge] rid=${requestId.slice(0, 8)} phase=client_abort entry=${lease.entryId}`);
    });
    try {
      await streamResponse({
        writer,
        api: lease.api,
        response: lease.response,
        model,
        adapter: fmt,
        onUsage: (value) => { usage = value; },
        diagnostics: {
          requestId: requestId.slice(0, 8),
          tag: fmt.tag,
          provider: "codex",
          path: "/codex/responses",
          accountEntryId: lease.entryId,
          abortSignal: abortController.signal,
        },
        rethrowEmptyResponseBeforeWrite: true,
      });
    } finally {
      abortController.abort();
      releaseAccount(accountPool, lease.entryId, usage, lease.released);
    }
  });
}
