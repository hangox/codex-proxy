import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CodexInputItem } from "../../proxy/codex-types.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import {
  computeMarkerSignature,
  safeEqualBuffers,
  type OpaqueCompactKeyring,
} from "./opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
  OpaqueCompactRepositoryError,
  type OpaqueCompactRecordMeta,
} from "./opaque-compact-repository.js";
import { canonicalJson } from "./canonical-json.js";

const MARKER_PREFIX = "codex-opaque-state:v1";
const MARKER_ANALYSIS = "Opaque compact state retained locally.";
const MARKER_PATTERN = /^<analysis>Opaque compact state retained locally\.<\/analysis>\n<summary>codex-opaque-state:v1:([A-Za-z0-9_-]{32}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})<\/summary>$/;
const MARKER_PREFIX_PATTERN = /^<analysis>Opaque compact state retained locally\.<\/analysis>\n<summary>codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}<\/summary>/;
const MARKER_TOKEN_PATTERN = /^codex-opaque-state:v1:([A-Za-z0-9_-]{32}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/;
const MARKER_TOKEN_PREFIX_PATTERN = /^codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}/;
const COMPACT_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.\n\nSummary:\n";
const COMPACT_SUMMARY_SUFFIX =
  "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, " +
  "or content you generated), read the full transcript at: ";
const COMPACT_SUMMARY_RESUME_INSTRUCTION =
  "Continue the conversation from where it left off without asking the user any further questions. " +
  "Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with " +
  "\"I'll continue\" or similar. Pick up the last task as if the break never happened.";

export type OpaqueCompactStateFailure =
  | "invalid_marker"
  | "tampered"
  /**
   * 内存模式专用："stateId 在内存 Map 里没有对应条目"（从未写入 / LRU 已淘汰 /
   * 同 session+model+variant 被更新的 compact 覆盖）。持久化模式不再产生这个
   * 值——它的等价物拆成了 `not_found`（行从未存在）与 `expired`（行曾存在，
   * 已到期）。保留 `missing` 只是不破坏既有内存模式单测，不代表两个模式的
   * "查无此状态"仍是同一件事。
   */
  | "missing"
  /** 持久化模式："lookup 在表里完全没有对应行"——从未存在过，或已被清理。 */
  | "not_found"
  | "expired"
  | "session_mismatch"
  | "model_mismatch"
  | "account_mismatch"
  | "variant_mismatch"
  | "comp_hash_mismatch"
  | "preserved_tail_conflict"
  | "state_too_large"
  // ── 持久化相关的结构化失败原因 ──────────────────────────────
  /** opaque 已开启但 store 未就绪（未初始化、被隔离、锁被别的实例持有）。 */
  | "store_unavailable"
  /** 第二实例试图开启 opaque store。 */
  | "store_locked"
  /** 磁盘 schema 版本与当前构建不兼容。 */
  | "schema_unsupported"
  /** 密钥环缺失。 */
  | "key_unavailable"
  /** 记录引用的 keyId 不在当前密钥环内。 */
  | "key_mismatch"
  /** 记录存在但 AEAD 校验失败。 */
  | "state_corrupt"
  /** 并发 recompact 落败方：另一个 compact 已经推进了 generation。 */
  | "stale_generation"
  /** sentinel 表明 store 曾初始化，但库被清零/删除/换掉。 */
  | "store_reset_detected"
  /**
   * 旧 schema → 当前 schema 的迁移失败。旧库已回滚为完整旧格式，可重试升级。
   * 与 state_corrupt 严格区分：后者意味着数据本身坏了、需要隔离取证。
   */
  | "migration_failed"
  /** keyring retention 策略不足以覆盖 state TTL。 */
  | "key_policy_invalid";

export class OpaqueCompactStateError extends Error {
  constructor(
    readonly reason: OpaqueCompactStateFailure,
    /**
     * 原始底层异常的诊断文本（通常是 `error.message`），供结构化日志排查
     * 用——**不是**给客户端看的（客户端只拿得到 `reason` 派生的固定文案，
     * 见 `describeOpaqueCompactUnavailable`）。绝大多数 throw site 传的是
     * 本文件自己写的、已知含义的 reason 字面量，这种情况下 `detail` 留空
     * 就够了（reason 本身已经说明了发生了什么）。真正需要它的是
     * `toStateError()` 的兜底分支——那里遇到的是"没能归到任何具体分类"的
     * 未知异常，`reason` 只能给出 `store_unavailable` 这个笼统值，`detail`
     * 是唯一还留着的线索。
     */
    readonly detail?: string,
  ) {
    super(reason);
    this.name = "OpaqueCompactStateError";
  }
}

export interface OpaqueCompactState {
  output: unknown[];
  preservedTail: CodexInputItem[];
  sessionId: string;
  model: string;
  accountEntryId: string;
  variantHash: string;
  compHash: string;
  createdAt: number;
  expiresAt: number;
}

interface ParsedMarker {
  marker: string;
  stateId: string;
  compHash: string;
  signature: string;
}

export interface OpaqueCompactStateStoreOptions {
  capacity?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
  secret?: Buffer;
  /** 提供后启用加密持久化；省略则退回纯内存（仅测试与默认关闭路径使用）。 */
  keyring?: OpaqueCompactKeyring;
  repository?: OpaqueCompactRepository;
}

/** 落盘 payload 的 schema 版本。升级/回滚靠它划边界。 */
const PERSISTED_PAYLOAD_VERSION = 2;

/** 落盘前的 state 明文投影。sessionId/model/variant 只以 HMAC binding 形式入库。 */
interface PersistedStatePayload {
  version: number;
  output: unknown[];
  preservedTail: CodexInputItem[];
  sessionId: string;
  model: string;
  accountEntryId: string;
  variantHash: string;
  compHash: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * 严格校验解封后的 payload。
 *
 * AEAD 通过只证明"这段密文是我们自己用对应密钥写的"，不证明它的结构符合
 * 当前版本的预期——旧版本写入、迁移 bug 或部分回滚都可能产出合法密文但畸形
 * 内容。裸 `JSON.parse(...) as T` 会让 `output` 非数组、`preservedTail`
 * undefined 这类值一路穿到 `.length` 处崩溃，或让非字符串字段绕过错误分类。
 */
function parsePersistedPayload(raw: Buffer): PersistedStatePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch {
    throw new OpaqueCompactStateError("state_corrupt");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpaqueCompactStateError("state_corrupt");
  }
  const candidate = parsed as Record<string, unknown>;

  if (candidate.version !== PERSISTED_PAYLOAD_VERSION) {
    // 未知 payload 版本按 schema 不兼容处理，而不是硬猜字段。
    throw new OpaqueCompactStateError("schema_unsupported");
  }
  if (!Array.isArray(candidate.output)) throw new OpaqueCompactStateError("state_corrupt");
  if (!Array.isArray(candidate.preservedTail)) throw new OpaqueCompactStateError("state_corrupt");
  for (const field of ["sessionId", "model", "accountEntryId", "variantHash", "compHash"]) {
    if (typeof candidate[field] !== "string") throw new OpaqueCompactStateError("state_corrupt");
  }
  for (const field of ["createdAt", "expiresAt"]) {
    const value = candidate[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new OpaqueCompactStateError("state_corrupt");
    }
  }
  if ((candidate.createdAt as number) > (candidate.expiresAt as number)) {
    throw new OpaqueCompactStateError("state_corrupt");
  }
  return candidate as unknown as PersistedStatePayload;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function statePayloadHash(output: unknown[], preservedTail: CodexInputItem[]): string {
  return base64Url(createHash("sha256").update(JSON.stringify({ output, preservedTail })).digest());
}

function preservedToolItemKey(item: CodexInputItem): string | null {
  if (!("type" in item)) return null;
  if (item.type === "function_call") return `call:${item.call_id}`;
  if (item.type === "function_call_output") return `output:${item.call_id}`;
  return null;
}

function canonicalPreservedToolItem(item: CodexInputItem): string {
  // arguments/output 是上游协议的原始字符串。不能 JSON.parse 后再比较，否则超过
  // Number.MAX_SAFE_INTEGER 的数字、-0 和指数写法会发生精度或词法折叠。
  return canonicalJson(item);
}

export function mergeOpaquePreservedTails(
  previous: CodexInputItem[],
  current: CodexInputItem[],
): CodexInputItem[] {
  const merged: CodexInputItem[] = [];
  const canonicalByKey = new Map<string, string>();
  for (const item of [...previous, ...current]) {
    const key = preservedToolItemKey(item);
    if (key === null) throw new OpaqueCompactStateError("preserved_tail_conflict");
    const canonical = canonicalPreservedToolItem(item);
    const existing = canonicalByKey.get(key);
    if (existing === canonical) continue;
    if (existing !== undefined) throw new OpaqueCompactStateError("preserved_tail_conflict");
    canonicalByKey.set(key, canonical);
    merged.push(item);
  }
  return merged;
}

function compactSummaryMarkerToken(value: string): string | null {
  if (!value.startsWith(COMPACT_SUMMARY_PREFIX)) return null;
  const suffixIndex = value.indexOf(COMPACT_SUMMARY_SUFFIX, COMPACT_SUMMARY_PREFIX.length);
  if (suffixIndex < 0) return null;
  const token = value.slice(COMPACT_SUMMARY_PREFIX.length, suffixIndex).trim();
  const transcriptTail = value.slice(suffixIndex + COMPACT_SUMMARY_SUFFIX.length).trim();
  const transcriptPath = transcriptTail.split("\n", 1)[0]?.trim();
  if (!transcriptPath || !token.startsWith(`${MARKER_PREFIX}:`)) return null;
  return token;
}

function compactSummaryWrapper(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized.startsWith(COMPACT_SUMMARY_PREFIX)) return null;
  const suffixIndex = normalized.indexOf(COMPACT_SUMMARY_SUFFIX, COMPACT_SUMMARY_PREFIX.length);
  if (suffixIndex < 0) return null;
  const transcriptStart = suffixIndex + COMPACT_SUMMARY_SUFFIX.length;
  const transcriptTail = normalized.slice(transcriptStart).trim();
  const transcriptPath = transcriptTail.split("\n", 1)[0]?.trim();
  if (!transcriptPath) return null;
  const transcriptEnd = normalized.indexOf(transcriptPath, transcriptStart) + transcriptPath.length;
  const afterTranscript = normalized.slice(transcriptEnd);
  const resumeOffset = afterTranscript.search(/\S/);
  const hasResumeInstruction = resumeOffset >= 0 &&
    afterTranscript.slice(resumeOffset).startsWith(COMPACT_SUMMARY_RESUME_INSTRUCTION);
  const wrapperEnd = hasResumeInstruction
    ? transcriptEnd + resumeOffset + COMPACT_SUMMARY_RESUME_INSTRUCTION.length
    : transcriptEnd;
  const wrapper = normalized.slice(0, wrapperEnd);
  return compactSummaryMarkerToken(wrapper) === null ? null : wrapper;
}

function markerCandidate(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (MARKER_PATTERN.test(normalized) || MARKER_TOKEN_PATTERN.test(normalized)) {
    return normalized;
  }
  const strictPrefix = MARKER_PREFIX_PATTERN.exec(normalized)?.[0] ??
    MARKER_TOKEN_PREFIX_PATTERN.exec(normalized)?.[0];
  if (strictPrefix) return strictPrefix;
  const wrapper = compactSummaryWrapper(normalized);
  if (wrapper !== null) return wrapper;
  if (
    normalized.startsWith(`<analysis>${MARKER_ANALYSIS}</analysis>`) &&
    normalized.includes(`<summary>${MARKER_PREFIX}:`)
  ) {
    return normalized;
  }
  return null;
}

function markerTextFromContent(
  content: AnthropicMessagesRequest["messages"][number]["content"],
): string | null {
  if (typeof content === "string") return markerCandidate(content);
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block?.type === "text" && typeof block.text === "string") {
      const marker = markerCandidate(block.text);
      if (marker) return marker;
    }
  }
  return null;
}

export function extractOpaqueCompactStateMarker(req: AnthropicMessagesRequest): string | null {
  for (let index = req.messages.length - 1; index >= 0; index -= 1) {
    const message = req.messages[index];
    if (!message) continue;
    const marker = markerTextFromContent(message.content);
    if (marker) return marker;
  }
  return null;
}

export function hasOpaqueCompactStateReference(req: AnthropicMessagesRequest): boolean {
  return req.messages.some((message) => {
    const content = message.content;
    if (typeof content === "string") return content.includes(`${MARKER_PREFIX}:`);
    return content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.includes(`${MARKER_PREFIX}:`));
  });
}

function markerToken(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const wrapperToken = compactSummaryMarkerToken(normalized);
  if (wrapperToken !== null) return MARKER_TOKEN_PATTERN.test(wrapperToken) ? wrapperToken : null;
  if (MARKER_TOKEN_PATTERN.test(normalized)) return normalized;
  const markerMatch = MARKER_PATTERN.exec(normalized);
  return markerMatch
    ? `${MARKER_PREFIX}:${markerMatch[1]}:${markerMatch[2]}:${markerMatch[3]}`
    : null;
}

type MarkerBoundary = { start: number; end: number; kind: "wrapper" | "raw" };

function markerBoundary(value: string, marker: string): MarkerBoundary | null {
  const normalized = value.replace(/\r\n?/g, "\n");
  const normalizedMarker = marker.replace(/\r\n?/g, "\n").trim();
  const targetToken = markerToken(normalizedMarker);
  if (targetToken === null) return null;

  const wrapper = compactSummaryWrapper(normalized);
  if (wrapper !== null && markerToken(wrapper) === targetToken) {
    const wrapperIndex = normalized.indexOf(wrapper);
    if (wrapperIndex >= 0) {
      return { start: wrapperIndex, end: wrapperIndex + wrapper.length, kind: "wrapper" };
    }
  }

  const exactIndex = normalized.indexOf(normalizedMarker);
  if (exactIndex >= 0) {
    return { start: exactIndex, end: exactIndex + normalizedMarker.length, kind: "raw" };
  }

  const candidate = markerCandidate(normalized);
  if (candidate !== null && markerToken(candidate) === targetToken) {
    const candidateIndex = normalized.indexOf(candidate);
    if (candidateIndex >= 0) {
      return { start: candidateIndex, end: candidateIndex + candidate.length, kind: "raw" };
    }
  }
  return null;
}

function contentAfterMarker(value: string, marker: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n");
  const boundary = markerBoundary(normalized, marker);
  if (boundary === null) return null;
  const prefix = normalized.slice(0, boundary.start).trim();
  if (prefix) return null;
  return normalized.slice(boundary.end).replace(/^\s+/, "");
}

function stripMarkerReferences(item: CodexInputItem, marker: string): CodexInputItem | null {
  if (!("role" in item)) return item;
  if (typeof item.content === "string") {
    const suffix = contentAfterMarker(item.content, marker);
    if (suffix !== null) return suffix ? { ...item, content: suffix } as CodexInputItem : null;
    return item.content.includes(MARKER_PREFIX) ? null : item;
  }

  const content = item.content.flatMap((part) => {
    if ((part.type !== "input_text" && part.type !== "output_text") || !part.text.includes(MARKER_PREFIX)) {
      return [part];
    }
    const suffix = contentAfterMarker(part.text, marker);
    return suffix ? [{ ...part, text: suffix }] : [];
  });
  return content.length > 0 ? { ...item, content } as CodexInputItem : null;
}

function findOpaqueMarkerBoundaryIndex(input: CodexInputItem[], marker: string): number {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (!("role" in item)) continue;
    if (typeof item.content === "string") {
      if (markerBoundary(item.content, marker) !== null) return index;
      continue;
    }
    if (item.content.some((part) =>
      (part.type === "input_text" || part.type === "output_text") && markerBoundary(part.text, marker) !== null)) {
      return index;
    }
  }
  return -1;
}

export function removeOpaquePreservedTailReplay(
  input: CodexInputItem[],
  marker: string,
  preservedTail: CodexInputItem[],
): CodexInputItem[] {
  if (preservedTail.length === 0) return input;
  const boundaryIndex = findOpaqueMarkerBoundaryIndex(input, marker);
  if (boundaryIndex < 0) throw new OpaqueCompactStateError("preserved_tail_conflict");

  const expected = new Map<string, string>();
  for (const item of preservedTail) {
    const key = preservedToolItemKey(item);
    if (key === null || expected.has(key)) throw new OpaqueCompactStateError("preserved_tail_conflict");
    expected.set(key, canonicalPreservedToolItem(item));
  }

  const seen = new Set<string>();
  const retained: CodexInputItem[] = [];
  for (const [index, item] of input.entries()) {
    if (index <= boundaryIndex) {
      retained.push(item);
      continue;
    }
    const key = preservedToolItemKey(item);
    if (key === null || !expected.has(key)) {
      retained.push(item);
      continue;
    }
    if (seen.has(key) || canonicalPreservedToolItem(item) !== expected.get(key)) {
      throw new OpaqueCompactStateError("preserved_tail_conflict");
    }
    seen.add(key);
  }

  if (seen.size === 0) return input;
  if (seen.size !== expected.size) throw new OpaqueCompactStateError("preserved_tail_conflict");
  return retained;
}

/**
 * marker 边界**之前**那段里，属于「本轮指令」而不是「历史对话」的 item。
 *
 * 为什么需要单独捞出来：`system_prompt_strategy = developer_inline` /
 * `system_inline` 时，用户的 system prompt 不在顶层 `instructions` 里
 * （`anthropic-to-codex.ts` 刻意让 instructions 不含用户内容，注释写的
 * "nothing to bypass"），而是被 `unshift` 成 input 最前面的一个
 * `{role:"developer"|"system"}` item——**inline 模式下它只存在于这一个地方**。
 *
 * 而恢复逻辑只保留 `[boundaryIndex, end)`，于是这条 item 被整个丢掉且再没
 * 插回去。后果：inline 模式 + 客户端有 system prompt + 走 opaque compact 恢复
 * → 该轮及之后每一轮恢复请求都没有用户 system prompt，顶层 instructions 也是
 * 空的，模型完全失去系统指令，**没有任何报错**。
 *
 * 判据刻意基于 item 语义（role 是不是 developer/system），不是 index 位置：
 * inline 模式下它恰好在 index 0 只是当前实现的巧合，`unshift` 的项数将来可能
 * 变。`instructions` 模式下前缀里本来就没有这类 item，这个函数返回空数组，
 * 整条改动对该模式是 no-op。
 *
 * 只认 developer/system：user/assistant 是真历史，本来就该被压缩产物取代。
 */
function collectPrefixInstructionItems(items: CodexInputItem[]): CodexInputItem[] {
  return items.filter((item) => (
    "role" in item && (item.role === "developer" || item.role === "system")
  ));
}

export function restoreOpaqueCompactInput(
  input: CodexInputItem[],
  marker: string,
  output: unknown[],
  preservedTail: CodexInputItem[] = [],
): CodexInputItem[] {
  const boundaryIndex = findOpaqueMarkerBoundaryIndex(input, marker);
  if (boundaryIndex < 0) {
    return [
      ...collectPrefixInstructionItems(input),
      ...output as CodexInputItem[],
      ...preservedTail,
    ];
  }
  const prefixInstructions = collectPrefixInstructionItems(input.slice(0, boundaryIndex));

  const retained: CodexInputItem[] = [];
  for (let index = boundaryIndex; index < input.length; index += 1) {
    const item = input[index]!;
    if (index > boundaryIndex) {
      const cleaned = stripMarkerReferences(item, marker);
      if (cleaned !== null) retained.push(cleaned);
      continue;
    }
    if (!("role" in item)) continue;
    if (typeof item.content === "string") {
      const suffix = contentAfterMarker(item.content, marker);
      if (suffix) retained.push({ ...item, content: suffix } as CodexInputItem);
      continue;
    }
    let markerIndex = -1;
    for (let partIndex = item.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = item.content[partIndex]!;
      if ((part.type === "input_text" || part.type === "output_text") && markerBoundary(part.text, marker) !== null) {
        markerIndex = partIndex;
        break;
      }
    }
    if (markerIndex < 0) continue;
    const markerPart = item.content[markerIndex]!;
    const content = item.content.slice(markerIndex + 1);
    if (markerPart.type === "input_text" || markerPart.type === "output_text") {
      const suffix = contentAfterMarker(markerPart.text, marker);
      if (suffix) content.unshift({ ...markerPart, text: suffix });
    }
    if (content.length > 0) retained.push({ ...item, content } as CodexInputItem);
  }
  // 本轮 inline 指令必须排在最前：它是「系统指令」，语义上先于压缩产物和历史。
  return [...prefixInstructions, ...output as CodexInputItem[], ...preservedTail, ...retained];
}

const IGNORED_MARKER_PLACEHOLDER_TEXT =
  "[Earlier conversation history referenced by an opaque compact marker is unavailable and could not be " +
  "restored. Continuing without it — do not attempt to interpret the original marker text as content.]";

/**
 * 忽略一枚"确实解析出来了、但不适用于本次请求"或"压根解析不出来"的
 * marker 时，用一句明示占位替换它，而不是让签名文本原样透传给上游、或者
 * 悄悄从历史里消失。
 *
 * 两者都是"静默降质"：上游模型要么把一串无意义的签名字符串当真实历史去
 * 理解，要么在毫无提示的情况下发现上下文突然变短——这正是生产回滚事故里
 * "用户看不到任何报错，但模型已经悄悄失去了 compact 之前的全部上下文"
 * 那一环的根因（见交接文档 1.2 环 8）。8.2/8.3 把 409 改成放行之后，如果
 * 什么都不做，就是把这个环从"回滚期间才会发生"搬进了"每一次关开关/绑定
 * 不匹配/marker 损坏都会发生"的常规路径——降级本身必须可观测。
 *
 * 只对"能找到 marker 边界"的情况生效；找不到就原样返回，**不能**退化成
 * `restoreOpaqueCompactInput` 那种"边界缺失时只保留 output"的行为——那是
 * 为"marker 必然存在"的权威恢复路径设计的，用在这里会把 marker 之后用户
 * 当前发言一起丢掉，比什么都不做更危险。
 */
export function replaceIgnoredOpaqueCompactMarker(
  input: CodexInputItem[],
  marker: string,
): CodexInputItem[] {
  if (findOpaqueMarkerBoundaryIndex(input, marker) < 0) return input;
  return restoreOpaqueCompactInput(input, marker, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: IGNORED_MARKER_PLACEHOLDER_TEXT }],
    },
  ]);
}

/**
 * Reviewer Finding #2（8.1 自愈的补丁）：8.1 自愈把 `opaqueRestore` 置为
 * `{restored:false}`、放行到全新 root compact 分支，但那条分支的
 * `buildClaudeCodeOpaqueCompactRequest(req, translated)` 直接从**原始**
 * `req.messages` 重新派生 compact 输入（见 `codex-compact-service.ts` 的
 * `messagesBeforeCompactPrompt(req)`），完全不经过 `codexRequest.input`——
 * 也就是说，即便调用方已经用 {@link replaceIgnoredOpaqueCompactMarker} 清理过
 * `codexRequest.input`，这个"全新"的 compact 请求依然会把那段已确认无法
 * 使用的旧 marker 原文当成真实历史，一起送进这次本该是"干净重新开始"的
 * compact——用户永远不会知道这次自愈出来的摘要混了一段不可读的签名文本。
 * 这是"承诺 vs 实现"不一致：我们承诺"重新压缩"，却没有先清理再压缩。
 *
 * 因此自愈到全新 root compact 之前，必须先在 Anthropic 层（而不是 Codex 层）
 * 清理一遍 `req`：找到承载 marker 的那条消息，把内容整体替换成同一句占位
 * 说明，其余消息原样保留。不需要 {@link restoreOpaqueCompactInput} 那套
 * "拆分 marker 前后内容、合并 preservedTail"的完整逻辑——这里根本没有真实
 * output 可以恢复，目标只是不让死掉的签名文本进 compact 输入。
 *
 * 找不到 marker 边界（如内部 token 本身已损坏）时原样返回 `req`——与
 * {@link replaceIgnoredOpaqueCompactMarker} 同样的"尽力而为、找不到就不动"
 * 设计，不做激进退化。
 */
export function replaceIgnoredOpaqueCompactMarkerInAnthropicRequest(
  req: AnthropicMessagesRequest,
  marker: string,
): AnthropicMessagesRequest {
  for (let index = req.messages.length - 1; index >= 0; index -= 1) {
    const message = req.messages[index]!;
    const content = message.content;
    if (typeof content === "string") {
      if (markerBoundary(content, marker) === null) continue;
      const messages = [...req.messages];
      messages[index] = { ...message, content: IGNORED_MARKER_PLACEHOLDER_TEXT };
      return { ...req, messages };
    }
    const hasMarker = content.some((block) =>
      block.type === "text" && typeof block.text === "string" && markerBoundary(block.text, marker) !== null);
    if (!hasMarker) continue;
    const messages = [...req.messages];
    messages[index] = {
      ...message,
      content: content.map((block) =>
        block.type === "text" && typeof block.text === "string" && markerBoundary(block.text, marker) !== null
          ? { ...block, text: IGNORED_MARKER_PLACEHOLDER_TEXT }
          : block),
    };
    return { ...req, messages };
  }
  return req;
}

/**
 * State store。
 *
 * 两种模式共用同一套 marker 语义：
 * - **持久化模式**（传入 keyring + repository）：marker 用 keyring 派生的稳定
 *   HMAC 子密钥签名，state 以 AEAD 密文落在 SQLite 里，因此重启后 marker 仍有效。
 * - **内存模式**（仅传 secret 或什么都不传）：保留原有纯 RAM 行为，供单测和
 *   "功能默认关闭时不碰磁盘"这条硬约束使用。
 */
export class OpaqueCompactStateStore {
  private readonly states = new Map<string, OpaqueCompactState>();
  private readonly stateBytes = new Map<string, number>();
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly secret: Buffer;
  private readonly keyring: OpaqueCompactKeyring | null;
  private readonly repository: OpaqueCompactRepository | null;
  private totalBytes = 0;

  constructor(options: OpaqueCompactStateStoreOptions = {}) {
    this.capacity = options.capacity ?? 128;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    this.secret = options.secret ?? randomBytes(32);
    this.keyring = options.keyring ?? null;
    this.repository = options.repository ?? null;
  }

  /** 是否处于持久化模式。 */
  get persistent(): boolean {
    return this.keyring !== null && this.repository !== null;
  }

  save(options: {
    output: unknown[];
    preservedTail?: CodexInputItem[];
    sessionId: string;
    model: string;
    accountEntryId: string;
    variantHash?: string;
    /** 重复 compact 时传入 resolve 得到的 generation；首次为 0。 */
    expectedGeneration?: number;
    /** 本次 compact 所基于的 predecessor stateId，用于崩溃后幂等回放。 */
    predecessorStateId?: string | null;
    /**
     * 本次 compact 请求的语义摘要，edge 的内容寻址分量。
     * 必填：缺了它 edge 会退化成 (predecessor) 单键，同一 predecessor 上的
     * 不同分叉会互相覆盖。
     */
    compactInputDigest: string;
    /** 本实例已知的账号集合；回放 winner edge 时解封数据密钥必需。 */
    accountCandidates?: readonly string[];
  }): {
    marker: string;
    state: OpaqueCompactState;
    generation: number;
    /** true 表示本次是并发/重试的 loser，返回的是既有 winner，未写入新 state。 */
    replayed: boolean;
  } {
    const stateId = base64Url(randomBytes(24));
    const preservedTail = options.preservedTail ?? [];
    const compHash = statePayloadHash(options.output, preservedTail);
    const createdAt = this.now();
    const state: OpaqueCompactState = {
      output: options.output,
      preservedTail,
      sessionId: options.sessionId,
      model: options.model,
      accountEntryId: options.accountEntryId,
      variantHash: options.variantHash ?? "",
      compHash,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (bytes > this.maxBytes) throw new OpaqueCompactStateError("state_too_large");

    const marker =
      `<analysis>${MARKER_ANALYSIS}</analysis>\n<summary>${MARKER_PREFIX}:${stateId}:${compHash}:${this.sign(stateId, compHash)}</summary>`;

    if (!this.persistent) {
      return { marker, state, generation: this.storeInMemory(stateId, state, bytes), replayed: false };
    }

    const candidates = options.accountCandidates ?? [options.accountEntryId];
    const outcome = this.persistState(stateId, state, options.expectedGeneration ?? 0, {
      predecessorStateId: options.predecessorStateId ?? null,
      successorMarker: marker,
      compactInputDigest: options.compactInputDigest,
      accountCandidates: candidates,
    });
    if (outcome.kind === "committed") {
      return { marker, state, generation: outcome.generation, replayed: false };
    }

    // 并发/重试的 loser：winner 已经落盘，本次候选 state 一个字节都没写。
    // 必须交出 winner 的**真实** state，而不是手里这份候选——两者由不同的
    // 上游调用产生，内容不同，marker 里的 compHash 也只对 winner 成立。
    // 直接返回候选 state 会让调用方按 A 的内容去还原 B 的 marker，restore 时
    // 必然 comp_hash_mismatch。
    //
    // confirmDelivery=false 是关键：客户端此刻还没拿到 winner marker，现在就
    // 回收 incoming edge 等于亲手拆掉自己正要用的幂等凭据——响应再丢一次就
    // 只能重打上游。确认交付只发生在客户端真的带着 marker 回来时。
    const winner = this.resolve({
      marker: outcome.marker,
      sessionId: options.sessionId,
      model: options.model,
      accountCandidates: candidates,
      variantHash: state.variantHash,
      confirmDelivery: false,
    });
    const { generation: winnerGeneration, stateId: _winnerStateId, ...winnerState } = winner;
    return {
      marker: outcome.marker,
      state: winnerState,
      generation: winnerGeneration,
      replayed: true,
    };
  }

  /**
   * 崩溃恢复用的幂等查询：若客户端手里的 predecessor marker 已经产生过
   * successor（COMMIT 成功但响应没送达），直接返回那个 marker，不再打上游。
   */
  findSuccessorMarker(options: {
    /** predecessor 的 marker；null 表示 root（首次 compact）。 */
    predecessorMarker: string | null;
    sessionId: string;
    model: string;
    compactInputDigest: string;
    variantHash: string;
    accountCandidates: readonly string[];
  }): string | null {
    if (!this.persistent) return null;
    // marker 的解析与验签留在 state 层：repository 只认 stateId，不该知道
    // marker 的语法与签名密钥。
    let predecessorStateId: string | null = null;
    if (options.predecessorMarker !== null) {
      let parsed: ParsedMarker;
      try {
        parsed = this.parse(options.predecessorMarker);
      } catch {
        // marker 本身不是有效格式 → 没有可回放的映射，走正常 compact 流程。
        return null;
      }
      if (!this.verify(parsed.stateId, parsed.compHash, parsed.signature)) return null;
      predecessorStateId = parsed.stateId;
    }
    try {
      const marker = this.repository!.findSuccessorMarker({
        sessionId: options.sessionId,
        model: options.model,
        predecessorStateId,
        compactInputDigest: options.compactInputDigest,
        binding: this.repository!.bindingFor(options.sessionId, options.model, options.variantHash),
        accountCandidates: options.accountCandidates,
      });
      if (marker === null) return null;

      // repository 已认证 edge 与 target 存在；返回客户端前再走 state 层完整认证：
      // marker 验签、state AEAD、payload schema、session/model/account/compHash 必须全部
      // 通过。confirmDelivery=false 保留这条 edge，直到客户端真正带 marker 回来。
      this.resolve({
        marker,
        sessionId: options.sessionId,
        model: options.model,
        accountCandidates: options.accountCandidates,
        variantHash: options.variantHash,
        confirmDelivery: false,
      });
      return marker;
    } catch (error) {
      // 只有"没有映射"才返回 null。损坏/密钥不符/账号不符都必须向上抛：
      // 吞掉会让进程重打一次上游、随后撞上 stale_generation，把真正的
      // 损坏原因彻底掩盖。
      throw toStateError(error);
    }
  }

  resolve(options: {
    marker: string;
    sessionId: string;
    model: string;
    /** 严格账号断言：给定时记录必须属于该账号。 */
    accountEntryId?: string;
    /** 本实例已知的账号集合；持久化模式下解封数据密钥必需。 */
    accountCandidates?: readonly string[];
    variantHash?: string;
    /**
     * 是否把这次 resolve 当作"客户端已收到该 marker"的证据（默认 true）。
     * 只有 save 的 replay 路径传 false：那时 marker 还没送出去，回收 incoming
     * edge 会拆掉正要交付的幂等凭据。
     */
    confirmDelivery?: boolean;
  }): OpaqueCompactState & { generation: number; stateId: string } {
    const parsed = this.parse(options.marker);
    if (!this.verify(parsed.stateId, parsed.compHash, parsed.signature)) {
      throw new OpaqueCompactStateError("tampered");
    }

    const loaded = this.persistent
      ? this.loadPersisted(parsed.stateId, options)
      : this.loadFromMemory(parsed.stateId);
    const { state, generation } = loaded;

    if (state.expiresAt <= this.now()) {
      this.deleteState(parsed.stateId);
      throw new OpaqueCompactStateError("expired");
    }
    if (state.sessionId !== options.sessionId) throw new OpaqueCompactStateError("session_mismatch");
    if (state.model !== options.model) throw new OpaqueCompactStateError("model_mismatch");
    if (options.accountEntryId !== undefined && state.accountEntryId !== options.accountEntryId) {
      throw new OpaqueCompactStateError("account_mismatch");
    }
    if (options.variantHash !== undefined && state.variantHash !== options.variantHash) {
      throw new OpaqueCompactStateError("variant_mismatch");
    }
    if (
      state.compHash !== parsed.compHash ||
      statePayloadHash(state.output, state.preservedTail) !== state.compHash
    ) {
      throw new OpaqueCompactStateError("comp_hash_mismatch");
    }

    if (this.persistent) {
      // 客户端确实在使用这个 state —— 现在才可以安全回收指向它的 incoming edge。
      // 这保证了"COMMIT 后崩溃、marker 没送达"时旧输入仍能回放出同一个 marker。
      const meta = (loaded as { meta?: OpaqueCompactRecordMeta }).meta;
      if (meta !== undefined && (options.confirmDelivery ?? true)) {
        this.repository!.confirmSuccessorUsed(meta);
      }
    } else {
      // 内存模式维持 LRU 顺序。
      this.states.delete(parsed.stateId);
      this.states.set(parsed.stateId, state);
    }
    return { ...state, generation, stateId: parsed.stateId };
  }

  delete(marker: string): void {
    let stateId: string;
    try {
      stateId = this.parse(marker).stateId;
    } catch {
      // 只有 marker 本身无法解析才可忽略——那种情况下根本没有对应的 state。
      return;
    }
    // 持久化删除失败（权限/IO/损坏）必须向上传播：吞掉会让 store 故障
    // 伪装成"删除成功"，readiness 也不会反映真实状态。
    this.deleteState(stateId);
  }

  size(): number {
    return this.repository !== null ? this.repository.stats().count : this.states.size;
  }

  /**
   * ★ 8.20（生产事故复盘）：容量可观测性——这次排查"用户是不是被 LRU 挤掉
   * 而不是 TTL 过期"完全靠翻客户端 transcript，服务端自己对"state 有没有
   * 被挤掉、离上限还有多远"没有任何可观测性。暴露 count/bytes 现状 +
   * capacity/maxBytes 配置上限，供 `/health` 展示，下次同类问题一眼就能
   * 看出来，不用再翻日志/transcript 交叉验证。
   */
  stats(): { count: number; bytes: number; capacity: number; maxBytes: number } {
    const live = this.repository !== null ? this.repository.stats() : { count: this.states.size, bytes: this.totalBytes };
    return { count: live.count, bytes: live.bytes, capacity: this.capacity, maxBytes: this.maxBytes };
  }

  clear(): void {
    this.states.clear();
    this.stateBytes.clear();
    this.totalBytes = 0;
  }

  // ── 持久化路径 ──────────────────────────────────────────────

  private persistState(
    stateId: string,
    state: OpaqueCompactState,
    expectedGeneration: number,
    delivery: {
      predecessorStateId: string | null;
      successorMarker: string;
      compactInputDigest: string;
      accountCandidates: readonly string[];
    },
  ):
    | { kind: "committed"; generation: number }
    | { kind: "replayed"; marker: string; generation: number } {
    const repository = this.repository!;
    // binding 来自稳定索引域，跨 master key 轮换不变 —— CAS 因此不会在轮换后分裂。
    const binding = repository.bindingFor(state.sessionId, state.model, state.variantHash);
    const payload: PersistedStatePayload = {
      version: PERSISTED_PAYLOAD_VERSION,
      output: state.output,
      preservedTail: state.preservedTail,
      sessionId: state.sessionId,
      model: state.model,
      accountEntryId: state.accountEntryId,
      variantHash: state.variantHash,
      compHash: state.compHash,
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
    };
    try {
      const saved = repository.saveWithCas({
        stateId,
        binding,
        sessionId: state.sessionId,
        model: state.model,
        accountEntryId: state.accountEntryId,
        accountCandidates: delivery.accountCandidates,
        expectedGeneration,
        plaintext: Buffer.from(JSON.stringify(payload), "utf-8"),
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
        predecessorStateId: delivery.predecessorStateId,
        successorMarker: delivery.successorMarker,
        compactInputDigest: delivery.compactInputDigest,
      });
      return saved.kind === "committed"
        ? { kind: "committed", generation: saved.generation }
        : { kind: "replayed", marker: saved.marker, generation: saved.generation };
    } catch (error) {
      throw toStateError(error);
    }
  }

  private loadPersisted(
    stateId: string,
    options: {
      sessionId: string;
      model: string;
      accountEntryId?: string;
      accountCandidates?: readonly string[];
    },
  ): { state: OpaqueCompactState; generation: number; meta: OpaqueCompactRecordMeta } {
    const repository = this.repository!;
    // 账号域隔离：不知道账号就派生不出数据密钥，连解封都做不到。
    // 生产 restore 传入本实例已知的账号集合；集合为空时 fail-closed。
    const candidates = options.accountCandidates
      ?? (options.accountEntryId !== undefined ? [options.accountEntryId] : []);
    let loaded: ReturnType<OpaqueCompactRepository["load"]>;
    try {
      // 8.4 sliding TTL：this.ttlMs 是这个 store 实例配置的 TTL（默认
      // 720 分钟）。restore 成功时 repository.load() 会把 expires_at 顺延到
      // now()+ttlMs，而不是仅仅 touch last_used_at——"restore 成功"本身就是
      // "顺延"，两者不是分开的两步。
      loaded = repository.load(stateId, candidates, this.ttlMs);
    } catch (error) {
      throw toStateError(error);
    }
    // 两条语义不同的"查无此状态"分别抛出：`not_found`（行从未存在）与
    // `expired`（行曾存在、已过期，本次 load 已经把它删了）。上层（8.1 自愈）
    // 靠这个区分决定能不能放行到全新 root compact——都属于"良性缺失"，
    // 但文案（8.5）需要分别措辞。
    if (loaded.kind === "not_found") throw new OpaqueCompactStateError("not_found");
    if (loaded.kind === "expired") throw new OpaqueCompactStateError("expired");
    const payload = parsePersistedPayload(loaded.plaintext);

    // 交叉验证：解封用的是候选账号 A 的数据密钥，但 payload 自己声称账号 B 时，
    // 若直接信任 payload，就会把 A 的 opaque output 当作 B 的状态路由出去
    // （requiredEntryId 来自 payload）。正常写入两者必然一致；不一致只可能来自
    // 迁移 bug 或恶意构造，一律 fail-closed。
    if (payload.accountEntryId !== loaded.matchedAccountEntryId) {
      throw new OpaqueCompactStateError("state_corrupt");
    }
    return {
      state: {
        output: payload.output,
        preservedTail: payload.preservedTail,
        sessionId: payload.sessionId,
        model: payload.model,
        accountEntryId: payload.accountEntryId,
        variantHash: payload.variantHash,
        compHash: payload.compHash,
        createdAt: payload.createdAt,
        // ★ 8.4 blocker（reviewer 发现）：这里必须是 loaded.meta.expiresAt，
        // 不能是 payload.expiresAt。payload.expiresAt 是加密 payload 里冻结的
        // 创建时快照，sliding TTL 的设计前提就是"不重新封装密文，只改列 +
        // MAC"，所以它从创建那一刻起永远不变。repository.load() 已经把顺延
        // 后的新值算好、写回 DB、并通过 loaded.meta.expiresAt 返回——用
        // payload.expiresAt 等于把 repository 层刚刚做对的顺延又在这里读丢，
        // 下面第 759 行的过期判定会一直用创建时的原始绝对期限，跟 repository
        // 是否已经顺延完全无关，是本轮要修的 bug 本身换了一层皮再次出现。
        expiresAt: loaded.meta.expiresAt,
      },
      generation: loaded.meta.generation,
      meta: loaded.meta,
    };
  }

  // ── 内存路径 ────────────────────────────────────────────────

  private storeInMemory(stateId: string, state: OpaqueCompactState, bytes: number): number {
    for (const [existingId, existing] of this.states) {
      if (
        existing.sessionId === state.sessionId &&
        existing.model === state.model &&
        existing.variantHash === state.variantHash
      ) {
        this.deleteState(existingId);
      }
    }
    this.states.set(stateId, state);
    this.stateBytes.set(stateId, bytes);
    this.totalBytes += bytes;
    this.trimToBounds();
    return 0;
  }

  private loadFromMemory(stateId: string): { state: OpaqueCompactState; generation: number } {
    const state = this.states.get(stateId);
    if (!state) throw new OpaqueCompactStateError("missing");
    return { state, generation: 0 };
  }

  private deleteByStateId(stateId: string): void {
    if (this.repository !== null) {
      this.repository.deleteByStateId(stateId);
      return;
    }
    const bytes = this.stateBytes.get(stateId) ?? 0;
    this.states.delete(stateId);
    this.stateBytes.delete(stateId);
    this.totalBytes = Math.max(0, this.totalBytes - bytes);
  }

  // ── marker 签名 ─────────────────────────────────────────────

  /** 校验器专用：解析 marker（内部实现的受控出口）。 */
  parseMarkerForValidation(marker: string): ParsedMarker {
    return this.parse(marker);
  }

  /** 校验器专用：验签。 */
  verifyMarkerForValidation(parsed: ParsedMarker): boolean {
    return this.verify(parsed.stateId, parsed.compHash, parsed.signature);
  }

  private parse(marker: string): ParsedMarker {
    const normalized = marker.replace(/\r\n?/g, "\n").trim();
    const token = compactSummaryMarkerToken(normalized) ?? normalized;
    const match = MARKER_PATTERN.exec(token) ?? MARKER_TOKEN_PATTERN.exec(token);
    if (!match) throw new OpaqueCompactStateError("invalid_marker");
    return {
      marker: normalized,
      stateId: match[1]!,
      compHash: match[2]!,
      signature: match[3]!,
    };
  }

  private sign(stateId: string, compHash: string): string {
    const message = `${MARKER_PREFIX}:${stateId}:${compHash}`;
    if (this.keyring !== null) {
      return base64Url(computeMarkerSignature(this.keyring.active(), message));
    }
    return base64Url(createHmac("sha256", this.secret).update(message).digest());
  }

  /**
   * 验签。持久化模式下要遍历整个 key ring：轮换之后，上一代密钥签发的 marker
   * 在 previous key 的保留窗口内必须继续有效，否则轮换等同于强制所有会话重来。
   *
   * ★ 已知限制（8.4 sliding TTL 引入后仍然存在，非本次改动的回归）：sliding
   * TTL 只是把"会话必然死亡"的窗口从固定 30 分钟推长到 keyring 的
   * `previousKeyRetentionMs`，不是消除它。marker 的 HMAC 签名在创建时就已
   * 绑定当时的 active key；这里的验证是"遍历当前保留窗口内的全部 key"，
   * 一旦签发时的那把 key 因超出 `previousKeyRetentionMs` 被裁剪出 keyring
   * （物理删除，见 `opaque-compact-keyring.ts` 的裁剪逻辑），无论对应的
   * state 被 touch 得多新、多频繁，这里都会因为遍历不到匹配的 key 而返回
   * false，上层判定为 `tampered`——这是密钥轮换卫生与 marker 寿命之间的
   * 结构性上限，sliding TTL 无法突破，本轮也不打算修（详见交付记录里对
   * `retired_key_suspected` 可观测性诉求的可行性结论：marker 不携带
   * keyId，且被裁剪的旧 key 不留 tombstone，系统内没有可查询的判定信号）。
   *
   * ★ 排查线索（留给运维）：单条 `tampered` 日志无法区分"真伪造"与"这条"，
   * 但**时间分布**能看出来——如果观察到 `tampered` 集中出现在一次 key
   * 轮换（`rotateOpaqueCompactKeyring`）发生后不久，大概率是这个已知限制
   * 而不是被攻击：真正的伪造在时间上应该是随机分布的，而"活跃时间跨越了
   * 一次轮换 + 保留窗口"这类命中会跟轮换事件的时间点强相关。
   */
  private verify(stateId: string, compHash: string, signature: string): boolean {
    const message = `${MARKER_PREFIX}:${stateId}:${compHash}`;
    const provided = Buffer.from(signature, "base64url");
    if (this.keyring !== null) {
      return this.keyring.keys.some((key) =>
        safeEqualBuffers(provided, computeMarkerSignature(key, message)),
      );
    }
    return safeEqualBuffers(
      provided,
      createHmac("sha256", this.secret).update(message).digest(),
    );
  }

  private deleteState(stateId: string): void {
    this.deleteByStateId(stateId);
  }

  private trimToBounds(): void {
    while (this.states.size > this.capacity || this.totalBytes > this.maxBytes) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (!oldest) return;
      this.deleteState(oldest);
    }
  }
}

/**
 * 把仓库层的失败原因映射成对客户端可见的结构化 409 原因。
 *
 * ★ `detail` 的来源（排查生产事故时补的字段，此前这里把原始异常直接丢了）：
 * 无论最终分类成哪个 `reason`，都统一取一次 `error.message`（或
 * `String(error)`）当 `detail`——多数分支（`state_corrupt`/`schema_unsupported`
 * 等）本身已经是明确含义的分类，`detail` 只是锦上添花；但 `default:`/末尾
 * 兜底这两个 `store_unavailable` 分支不一样——**它们是"这个异常不属于任何
 * 已知分类"的兜底**，`reason` 本身给不出任何线索，`detail` 是唯一还留着的
 * 诊断信息。此前这里直接丢弃 `error`，只留分类结果，是生产事故"根因至今
 * 查不到"的直接原因——原始异常从这一步开始就没有任何痕迹留下来，不是后面
 * 哪个日志 sink 没接对，是这里从源头没留。
 */
function toStateError(error: unknown): OpaqueCompactStateError {
  if (error instanceof OpaqueCompactStateError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof OpaqueCompactRepositoryError) {
    switch (error.reason) {
      case "stale_generation":
        return new OpaqueCompactStateError("stale_generation", detail);
      case "schema_unsupported":
        return new OpaqueCompactStateError("schema_unsupported", detail);
      case "key_mismatch":
        return new OpaqueCompactStateError("key_mismatch", detail);
      case "state_corrupt":
        return new OpaqueCompactStateError("state_corrupt", detail);
      case "binding_mismatch":
        // 记录属于别的账号 —— 这是账号隔离边界，不是会话不匹配。
        return new OpaqueCompactStateError("account_mismatch", detail);
      case "store_reset_detected":
        return new OpaqueCompactStateError("store_reset_detected", detail);
      case "migration_failed":
        return new OpaqueCompactStateError("migration_failed", detail);
      case "state_too_large":
        return new OpaqueCompactStateError("state_too_large", detail);
      default:
        return new OpaqueCompactStateError("store_unavailable", detail);
    }
  }
  return new OpaqueCompactStateError("store_unavailable", detail);
}

// ── 运行时 store 句柄 ─────────────────────────────────────────
//
// 功能默认关闭，所以模块加载时**不能**创建任何 store：那会在 opaque=false 的
// 部署上凭空产生 DB、keyring 和锁文件。改为由 startServer() 显式安装。

let runtimeStore: OpaqueCompactStateStore | null = null;
let runtimeUnavailableReason: OpaqueCompactStateFailure | null = null;
// ★ 排查生产事故补的字段：一次 store 级故障发生后，同一个 reason 会在
// runtime 恢复之前被后续每一个请求反复读到（生产事故实测 77 次/49 分钟，
// 全部来自这里）——此前 detail 没有跟 reason 一起存，等于"故障发生的那
// 一刻录到的诊断信息"只活了一次调用就丢了，后面 76 次复现全部拿不到。
let runtimeUnavailableDetail: string | undefined;

export function setOpaqueCompactStateStore(store: OpaqueCompactStateStore | null): void {
  runtimeStore = store;
  if (store !== null) {
    runtimeUnavailableReason = null;
    runtimeUnavailableDetail = undefined;
  }
}

/** store 初始化失败时记录原因，让后续请求返回精确的结构化 409。 */
export function setOpaqueCompactStateUnavailable(
  reason: OpaqueCompactStateFailure,
  detail?: string,
): void {
  runtimeStore = null;
  runtimeUnavailableReason = reason;
  runtimeUnavailableDetail = detail;
}

export function getOpaqueCompactStateStore(): OpaqueCompactStateStore {
  if (runtimeStore === null) {
    throw new OpaqueCompactStateError(runtimeUnavailableReason ?? "store_unavailable", runtimeUnavailableDetail);
  }
  return runtimeStore;
}

export function isOpaqueCompactStateStoreReady(): boolean {
  return runtimeStore !== null;
}

/**
 * 只读 readiness。`reason` 是稳定、非敏感的枚举值，供路由返回结构化 409、
 * 以及运维/E2E 断言使用；不含路径、错误详情等可泄漏信息，**可以**直接
 * 拼进客户端可见的错误文案。
 *
 * ★ `detail`（排查生产事故补的字段）是原始异常文本，**只允许流向结构化
 * 日志**（过 `sanitizeFreeTextForLog` 脱敏截断后），**绝不能**拼进任何
 * 客户端可见的响应体——调用方（`messages.ts`）必须只把它传给
 * `recordOpaqueCompactDenial`，不能传给 `describeOpaqueCompactUnavailable`
 * 或任何构造响应文案的地方。这条边界靠调用方遵守，这里只提供数据，不做
 * 强制隔离，写调用代码时必须留意。
 */
export function getOpaqueCompactStateReadiness(): {
  ready: boolean;
  reason: OpaqueCompactStateFailure | null;
  detail?: string;
} {
  if (runtimeStore !== null) return { ready: true, reason: null };
  return { ready: false, reason: runtimeUnavailableReason ?? "store_unavailable", detail: runtimeUnavailableDetail };
}

/**
 * ★ 8.20：容量可观测性——`null` 表示 store 未就绪（和 readiness 的语义
 * 一致，不重复定义"没有 store"这件事）。只含聚合数值（当前条数/总字节/
 * 配置上限），不含任何 session/account/内容相关信息，可以直接进
 * `/health`。
 */
export function getOpaqueCompactStateCapacity(): {
  count: number;
  bytes: number;
  capacity: number;
  maxBytes: number;
} | null {
  return runtimeStore?.stats() ?? null;
}

/**
 * 判定一个失败是否属于"store 本身坏了"。
 *
 * 这类错误不能只影响当前请求：它们意味着后续请求同样不可信，因此必须原子地
 * 把 runtime 转成 NOT_READY 并保留稳定 reason。相对地，session/model/variant
 * 不匹配、marker 过期、CAS 落败等是**单请求**语义错误，store 依然健康。
 */
function isFatalStoreFailure(reason: OpaqueCompactStateFailure): boolean {
  switch (reason) {
    case "store_unavailable":
    case "store_locked":
    case "schema_unsupported":
    case "key_unavailable":
    case "key_mismatch":
    case "state_corrupt":
    case "store_reset_detected":
    case "migration_failed":
    case "key_policy_invalid":
      return true;
    default:
      return false;
  }
}

/**
 * "状态不可用"的完整分区收口在这三个函数（{@link isFatalStoreFailure}、
 * 这里、{@link isUnparseableOpaqueCompactMarker}）+
 * {@link isOpaqueCompactMarkerBindingMismatch} 一共四个函数、三大族里，
 * 两两互斥。调用方（路由层）只应该调用这几个分类函数做编排，不应该再散落
 * `reason === "..."` 的字符串比较——那样每加一个 reason 都要记得同步改
 * 所有调用点，正是这次事故"多处症状、同一缺失不变式"的成因。
 *
 * 判据是"这个失败说明了什么"：
 *
 * - **族 C · 致命 / 必须拦**（{@link isFatalStoreFailure}）：单实例锁、
 *   keyring 缺失、schema 不匹配、记录 AEAD 校验失败、`state_corrupt` 等——
 *   说明 **store 本身的持久化承诺已经不成立**，必须 fail-closed，并把
 *   runtime 原子转成 NOT_READY。
 * - **族 A · 良性可自愈**（这里，{@link isSelfHealableOpaqueCompactStateFailure}）：
 *   `not_found`（行从未存在）与 `expired`（行曾存在、TTL 到期后被自然删
 *   除）——说明**时间过去了**，是系统正常工作的必然结果，不代表数据被破坏
 *   或账号越权。调用方拿到的 marker 本身就是"过期钥匙"，理应可以直接换一
 *   把新的（放行到全新 root compact），而不是把用户焊死在死会话里。这一族
 *   **需要**调用方额外确认"本次确实是 compact 请求"才能放行：对着一枚过期
 *   marker 的普通聊天请求，仍然要 409 提示用户去 /compact（现在这条提示是
 *   真的可执行的，见 8.1 的自愈）——否则就是在没有新 compact 发生的情况下
 *   静默丢弃这段历史，不是自愈是丢数据。
 * - **族 B · 这枚 marker 不适用于本次请求**（{@link isUnparseableOpaqueCompactMarker}
 *   + {@link isOpaqueCompactMarkerBindingMismatch}）：说明**这枚 marker 与
 *   当前请求无关**，无论是从未被认定为合法指令，还是认对了但绑定的上下文
 *   变了。两个子函数覆盖两条不同来路，但结论相同——忽略 marker、按普通请求
 *   继续，不需要"必须是 compact 请求"这个前提（marker 与本次请求无关，
 *   这个结论不因请求是不是 compact 而改变）：
 *   - `invalid_marker`——从未成功解析出合法的 (stateId, compHash, signature)
 *     三元组，多半是截断的 base64url 段、被引用/包裹改变了位置、拼进段落
 *     中部这类传输层损伤。
 *   - `session_mismatch` / `model_mismatch`——marker 验签**通过**了（确实是
 *     我们签发的），只是绑定的会话/模型跟当前请求对不上。`resolve()` 从未
 *     把数据返回给错的上下文，安全边界已经守住；再额外 409 对安全性没有
 *     任何增量，只是把会话推向死路。
 *   - `variant_mismatch`——同样验签通过，只是 variant 指纹跟当前请求算
 *     不一致。★ 这条是止血，不是最终修复，见下方专门说明。
 *   ★ 放行到"当普通请求继续"之后，必须用 {@link replaceIgnoredOpaqueCompactMarker}
 *   把这枚被忽略的 marker 换成明示占位，不能让签名文本原样透传给上游——
 *   否则就是把回滚事故里"静默上下文丢失"那一环从"仅回滚期间"搬进日常路径。
 *
 * 族 B **刻意不包含** `account_mismatch`：持久化路径下它来自 repository 的
 * `binding_mismatch`（记录属于本实例完全不认识的账号），是真实的跨账号
 * 访问边界，不是"上下文对不上"，因此仍然落在"既不致命也不该静默放行"的
 * 剩余集合里，继续 fail-closed。
 *
 * ★ `variant_mismatch` 归族 B 是止血措施，不是最终方案 ★
 *
 * 这条分类此前被短暂撤回过（commit `fdf28c6`），随后又恢复（本 commit）——
 * 撤回是团队沟通歧义导致的误判，恢复是基于 qa 的实证数据重新裁定。qa 用
 * 透明反向代理探针实测真实 Claude Code 流量指纹：compact 之前连续多轮
 * 请求的 `instructions`/`tools` 逐字节完全相同，但 **compact 成功后的下一
 * 次请求，`instructions` 必然变化**（长度与哈希均变，`tools` 不变）——也
 * 就是说任何用户 compact 成功后的第一句话都会必然撞上 `variant_mismatch`，
 * 它是 100% 命中的主路径问题，不是边角场景。继续 409 等同于原始事故重现
 * （每次 compact 后的第一句话都死锁）；qa 同一次运行也实测过对照：族 B 在
 * 真实场景下确实避免了死锁，客户端完全无感。
 *
 * reviewer 的批评依然成立：族 B 现有 remedy（丢弃 marker、按普通请求继续）
 * 建立在"state 与本次请求无关"之上，但 variant_mismatch 命中时 state 本身
 * 完好、内容仍可解密恢复，只是 variant 指纹算不一致——丢弃它是在浪费一份
 * 本可完整恢复的历史。但这个批评指向"需要更好的 remedy"，不是"应该
 * 409"：409 死锁是三个选项里最差的（会话直接不可用），族 B 丢弃是止血
 * （次优，会话可用但那次 compact 的历史白丢），修复 variant 计算本身才是
 * 最优解。
 *
 * ★ 最优解已经拍板并落地（`opaqueCompactVariantHash`，`opaque-compact-
 * bridge.ts`）：variant hash 去掉了 `instructions`，只保留全程稳定的
 * `tools`（+ `codexWindowId`）。三条证据链（Codex 原生用 thread_id+计数器
 * 而非内容哈希做世代标识；subagent 与 main 共享 session id 因而不能靠
 * session 层区分；qa 实测 instructions 在 compact 前后必然变化、tools
 * 全程不变）定位到 instructions 是唯一的真实故障源，具体推理见
 * `opaqueCompactVariantHash` 的文档注释。族 B 处理 variant_mismatch 因此
 * 从"每次 compact 后必然命中的主止血路径"降级为"翻译层真出 bug、或 tools
 * 集合真变化时的兜底"——止血措施仍然保留（这是 fail-safe，不是这次改动的
 * 替代品），但预期命中频率会大幅下降。
 *
 * 其余 reason（`account_mismatch`/`comp_hash_mismatch`/`tampered`/
 * `preserved_tail_conflict`/`state_too_large`/`stale_generation`）三族都不
 * 占：`tampered` 是结构合法但签名验证失败的真实伪造/完整性信号；
 * `comp_hash_mismatch`/`account_mismatch` 是数据完整性或账号隔离边界；
 * `preserved_tail_conflict`/`stale_generation` 是并发/协议冲突。放行会掩盖
 * 真正的伪造尝试、数据损坏或并发冲突，因此仍然各自返回 409。
 */
export function isSelfHealableOpaqueCompactStateFailure(reason: OpaqueCompactStateFailure): boolean {
  switch (reason) {
    case "not_found":
    case "expired":
    case "missing":
      return true;
    default:
      return false;
  }
}

/**
 * 判定一个失败是否根本没能解析出合法 marker 结构——族 B 的第一条来路，
 * 完整分区说明见 {@link isSelfHealableOpaqueCompactStateFailure}。
 * 与 `tampered`（结构合法、签名验证失败）刻意区分：那是真实的完整性信号，
 * 仍需 fail-closed；这里是"这段文本长得像 marker，但连三元组都凑不出来"，
 * 按普通文本处理即可。
 */
export function isUnparseableOpaqueCompactMarker(reason: OpaqueCompactStateFailure): boolean {
  return reason === "invalid_marker";
}

/**
 * 判定一个失败是否属于"marker 验签通过（确实是我们签发的），但绑定的
 * 会话/模型/variant 与本次请求对不上"——族 B 的第二条来路，完整分区说明
 * 见 {@link isSelfHealableOpaqueCompactStateFailure}。
 *
 * 与 `account_mismatch` 刻意区分：后者是跨账号访问边界（见上方分区说明），
 * 不在这个函数的判定范围内，继续 fail-closed。
 *
 * `variant_mismatch` 归在这里是止血措施而非最终修复，理由与 tradeoff 见
 * {@link isSelfHealableOpaqueCompactStateFailure} 的专门说明——修 variant
 * 计算本身需要产品对 `instructions` 隔离维度的取舍拍板，拍板前这里维持
 * 现状不再变动。
 */
export function isOpaqueCompactMarkerBindingMismatch(reason: OpaqueCompactStateFailure): boolean {
  switch (reason) {
    case "session_mismatch":
    case "model_mismatch":
    case "variant_mismatch":
      return true;
    default:
      return false;
  }
}

export interface OpaqueCompactStoreFaultInfo {
  reason: OpaqueCompactStateFailure;
  /** 原始异常文本，供结构化日志用；绝不能流入客户端响应，见调用方注释。 */
  detail?: string;
}

/**
 * 统一的动态故障入口。
 *
 * 运行期发现 store 级致命故障时调用：原子移除 runtimeStore、记录精确
 * reason（+ 排查生产事故补的 `detail`——原始异常文本，此前只有 reason
 * 被保留，`error.message` 在这一步之前就已经从 `toStateError()` 里带出来，
 * 但如果这里不往下传，还是会在这个入口断掉），于是当前请求、后续请求、
 * /health 与 Admin readiness 拿到的是**同一个**机器可判定的原因（和同一份
 * 诊断细节），而不是"当前请求泛化 409、readiness 仍显示 ready"。
 */
export function reportOpaqueCompactStoreFault(error: unknown): OpaqueCompactStoreFaultInfo | null {
  // 只有 store 自己抛出的结构化错误才可能是 store 故障。上游 4xx/5xx、网络
  // 错误等一律不是——把它们也判成 fault 会让一次普通的上游失败把整个
  // opaque 功能打成 NOT_READY，并且阻断本该允许的首次 compact 回退。
  if (!(error instanceof OpaqueCompactStateError)) return null;
  const reason = error.reason;
  if (!isFatalStoreFailure(reason)) return null;
  const detail = error.detail;
  // 交给 runtime 层执行真正的 detach：只清指针会留下 DB/锁仍被持有的
  // 半下线状态，后续任何 start 都会撞上 store_locked（已实测）。
  if (runtimeFaultHandler !== null) {
    return { reason: runtimeFaultHandler(reason, detail), detail };
  }
  setOpaqueCompactStateUnavailable(reason, detail);
  return { reason, detail };
}

/**
 * runtime 在启动时注册的故障接管回调（注入以避免 state ↔ runtime 循环依赖）。
 */
let runtimeFaultHandler:
  | ((reason: OpaqueCompactStateFailure, detail?: string) => OpaqueCompactStateFailure)
  | null = null;

export function setOpaqueCompactRuntimeFaultHandler(
  handler: ((reason: OpaqueCompactStateFailure, detail?: string) => OpaqueCompactStateFailure) | null,
): void {
  runtimeFaultHandler = handler;
}

/**
 * 冷启动语义校验：解封后的 payload 必须结构合法，且关键字段与行元数据一致。
 * 供 repository 在 recover 阶段调用（注入方式避免循环依赖）。
 */
export function validatePersistedPayloadForRecovery(
  keyring: OpaqueCompactKeyring,
  repository: OpaqueCompactRepository,
  plaintext: Buffer,
  meta: OpaqueCompactRecordMeta,
): boolean {
  let payload: PersistedStatePayload;
  try {
    payload = parsePersistedPayload(plaintext);
  } catch {
    return false;
  }
  // createdAt 永远不变——它是唯一仍然有效的锚点，两侧漂移说明记录不可信
  // （迁移 bug 或人为拼装）。
  if (payload.createdAt !== meta.createdAt) return false;
  // ★ 8.4 sliding TTL 之后，payload.expiresAt 与 meta.expiresAt **不再要求
  // 相等**——这不是偷懒删掉的校验，是有意为之：
  //   - meta.expiresAt（行元数据，配 expires_at_mac）是权威值，每次成功
  //     restore 都会被顺延，反映"这一行现在真实的到期时间"；
  //   - payload.expiresAt 是密文里那份不可变的原始快照，永远停在**创建时**
  //     算出的到期时间（sealRecord 之后明文再也不会被改写）。
  // 一个被访问过哪怕一次的记录，两者就会合法分道扬镳；继续要求相等会让
  // "正常顺延过的记录"在下次冷启动 recover 时被误判成 unreadable。
  // meta.expiresAt 本身的可信度由 repository.load()/recover() 里独立的
  // expires_at_mac 校验保证，不需要 payload 这边再校验一次。
  // binding 必须能由 payload 自身的 session/model/variant 重算出来，
  // 否则索引与内容已经对不上（迁移 bug 或人为拼装）。
  if (repository.bindingFor(payload.sessionId, payload.model, payload.variantHash) !== meta.binding) {
    return false;
  }
  // compHash 必须与实际内容一致。
  if (statePayloadHash(payload.output, payload.preservedTail) !== payload.compHash) return false;
  void keyring;
  return true;
}

/**
 * successor 映射的语义校验：内容必须是一个合法 marker，且其 stateId 折算出的
 * lookup 必须等于该行已认证的 successor_lookup（防止映射指向别的记录）。
 */
export function validateSuccessorMarkerForRecovery(
  store: OpaqueCompactStateStore,
  repository: OpaqueCompactRepository,
  marker: string,
  expectedSuccessorLookup: string,
): boolean {
  let parsed: ParsedMarker;
  try {
    parsed = store.parseMarkerForValidation(marker);
  } catch {
    return false;
  }
  if (!store.verifyMarkerForValidation(parsed)) return false;
  return repository.lookupFor(parsed.stateId) === expectedSuccessorLookup;
}

/** 测试专用：安装一个纯内存 store。 */
export function installInMemoryOpaqueCompactStateStore(
  options: OpaqueCompactStateStoreOptions = {},
): OpaqueCompactStateStore {
  const store = new OpaqueCompactStateStore(options);
  setOpaqueCompactStateStore(store);
  return store;
}
