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
  | "missing"
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
  /** keyring retention 策略不足以覆盖 state TTL。 */
  | "key_policy_invalid";

export class OpaqueCompactStateError extends Error {
  constructor(readonly reason: OpaqueCompactStateFailure) {
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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

export function restoreOpaqueCompactInput(
  input: CodexInputItem[],
  marker: string,
  output: unknown[],
  preservedTail: CodexInputItem[] = [],
): CodexInputItem[] {
  const boundaryIndex = findOpaqueMarkerBoundaryIndex(input, marker);
  if (boundaryIndex < 0) return [...output as CodexInputItem[], ...preservedTail];

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
  return [...output as CodexInputItem[], ...preservedTail, ...retained];
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
  }): { marker: string; state: OpaqueCompactState; generation: number } {
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

    const generation = this.persistent
      ? this.persistState(stateId, state, options.expectedGeneration ?? 0, {
          predecessorStateId: options.predecessorStateId ?? null,
          successorMarker: marker,
        })
      : this.storeInMemory(stateId, state, bytes);

    return { marker, state, generation };
  }

  /**
   * 崩溃恢复用的幂等查询：若客户端手里的 predecessor marker 已经产生过
   * successor（COMMIT 成功但响应没送达），直接返回那个 marker，不再打上游。
   */
  findSuccessorMarker(predecessorMarker: string, accountEntryId: string): string | null {
    if (!this.persistent) return null;
    let parsed: ParsedMarker;
    try {
      parsed = this.parse(predecessorMarker);
    } catch {
      // marker 本身不是有效格式 → 没有可回放的映射，走正常 compact 流程。
      return null;
    }
    if (!this.verify(parsed.stateId, parsed.compHash, parsed.signature)) return null;
    try {
      return this.repository!.findSuccessorMarker(parsed.stateId, accountEntryId);
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
      // 客户端确实在使用这个 successor —— 现在才可以安全回收它的 predecessor。
      // 这是 predecessor 被删除的唯一入口，保证了"COMMIT 后崩溃"时旧 marker 仍可用。
      const meta = (loaded as { meta?: OpaqueCompactRecordMeta }).meta;
      if (meta !== undefined) this.repository!.confirmSuccessorUsed(meta);
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
    delivery: { predecessorStateId: string | null; successorMarker: string },
  ): number {
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
        accountEntryId: state.accountEntryId,
        expectedGeneration,
        plaintext: Buffer.from(JSON.stringify(payload), "utf-8"),
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
        predecessorStateId: delivery.predecessorStateId,
        successorMarker: delivery.successorMarker,
      });
      return saved.generation;
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
      loaded = repository.load(stateId, candidates);
    } catch (error) {
      throw toStateError(error);
    }
    if (loaded === null) throw new OpaqueCompactStateError("missing");
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
        expiresAt: payload.expiresAt,
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

/** 把仓库层的失败原因映射成对客户端可见的结构化 409 原因。 */
function toStateError(error: unknown): OpaqueCompactStateError {
  if (error instanceof OpaqueCompactStateError) return error;
  if (error instanceof OpaqueCompactRepositoryError) {
    switch (error.reason) {
      case "stale_generation":
        return new OpaqueCompactStateError("stale_generation");
      case "schema_unsupported":
        return new OpaqueCompactStateError("schema_unsupported");
      case "key_mismatch":
        return new OpaqueCompactStateError("key_mismatch");
      case "state_corrupt":
        return new OpaqueCompactStateError("state_corrupt");
      case "binding_mismatch":
        // 记录属于别的账号 —— 这是账号隔离边界，不是会话不匹配。
        return new OpaqueCompactStateError("account_mismatch");
      case "store_reset_detected":
        return new OpaqueCompactStateError("store_reset_detected");
      case "state_too_large":
        return new OpaqueCompactStateError("state_too_large");
      default:
        return new OpaqueCompactStateError("store_unavailable");
    }
  }
  return new OpaqueCompactStateError("store_unavailable");
}

// ── 运行时 store 句柄 ─────────────────────────────────────────
//
// 功能默认关闭，所以模块加载时**不能**创建任何 store：那会在 opaque=false 的
// 部署上凭空产生 DB、keyring 和锁文件。改为由 startServer() 显式安装。

let runtimeStore: OpaqueCompactStateStore | null = null;
let runtimeUnavailableReason: OpaqueCompactStateFailure | null = null;

export function setOpaqueCompactStateStore(store: OpaqueCompactStateStore | null): void {
  runtimeStore = store;
  if (store !== null) runtimeUnavailableReason = null;
}

/** store 初始化失败时记录原因，让后续请求返回精确的结构化 409。 */
export function setOpaqueCompactStateUnavailable(reason: OpaqueCompactStateFailure): void {
  runtimeStore = null;
  runtimeUnavailableReason = reason;
}

export function getOpaqueCompactStateStore(): OpaqueCompactStateStore {
  if (runtimeStore === null) {
    throw new OpaqueCompactStateError(runtimeUnavailableReason ?? "store_unavailable");
  }
  return runtimeStore;
}

export function isOpaqueCompactStateStoreReady(): boolean {
  return runtimeStore !== null;
}

/**
 * 只读 readiness。reason 是稳定、非敏感的枚举值，供路由返回结构化 409、
 * 以及运维/E2E 断言使用；不含路径、错误详情等可泄漏信息。
 */
export function getOpaqueCompactStateReadiness(): {
  ready: boolean;
  reason: OpaqueCompactStateFailure | null;
} {
  if (runtimeStore !== null) return { ready: true, reason: null };
  return { ready: false, reason: runtimeUnavailableReason ?? "store_unavailable" };
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
    case "key_policy_invalid":
      return true;
    default:
      return false;
  }
}

/**
 * 统一的动态故障入口。
 *
 * 运行期发现 store 级故障时调用：原子移除 runtimeStore、记录精确 reason，
 * 于是当前请求、后续请求、/health 与 Admin readiness 拿到的是**同一个**
 * 机器可判定的原因，而不是"当前请求泛化 409、readiness 仍显示 ready"。
 */
export function reportOpaqueCompactStoreFault(error: unknown): OpaqueCompactStateFailure | null {
  // 只有 store 自己抛出的结构化错误才可能是 store 故障。上游 4xx/5xx、网络
  // 错误等一律不是——把它们也判成 fault 会让一次普通的上游失败把整个
  // opaque 功能打成 NOT_READY，并且阻断本该允许的首次 compact 回退。
  if (!(error instanceof OpaqueCompactStateError)) return null;
  const reason = error.reason;
  if (!isFatalStoreFailure(reason)) return null;
  // 交给 runtime 层执行真正的 detach：只清指针会留下 DB/锁仍被持有的
  // 半下线状态，后续任何 start 都会撞上 store_locked（已实测）。
  return runtimeFaultHandler !== null
    ? runtimeFaultHandler(reason)
    : (setOpaqueCompactStateUnavailable(reason), reason);
}

/**
 * runtime 在启动时注册的故障接管回调（注入以避免 state ↔ runtime 循环依赖）。
 */
let runtimeFaultHandler: ((reason: OpaqueCompactStateFailure) => OpaqueCompactStateFailure) | null = null;

export function setOpaqueCompactRuntimeFaultHandler(
  handler: ((reason: OpaqueCompactStateFailure) => OpaqueCompactStateFailure) | null,
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
  // 时间字段必须与行元数据一致：任一侧漂移都说明记录不可信。
  if (payload.createdAt !== meta.createdAt || payload.expiresAt !== meta.expiresAt) return false;
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
