import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CodexInputItem } from "../../proxy/codex-types.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";

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
  | "state_too_large";

export class OpaqueCompactStateError extends Error {
  constructor(readonly reason: OpaqueCompactStateFailure) {
    super(reason);
    this.name = "OpaqueCompactStateError";
  }
}

export interface OpaqueCompactState {
  output: unknown[];
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
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function outputHash(output: unknown[]): string {
  return base64Url(createHash("sha256").update(JSON.stringify(output)).digest());
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

export function restoreOpaqueCompactInput(
  input: CodexInputItem[],
  marker: string,
  output: unknown[],
): CodexInputItem[] {
  let boundaryIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (!("role" in item)) continue;
    if (typeof item.content === "string") {
      if (markerBoundary(item.content, marker) !== null) {
        boundaryIndex = index;
        break;
      }
      continue;
    }
    if (item.content.some((part) =>
      (part.type === "input_text" || part.type === "output_text") && markerBoundary(part.text, marker) !== null)) {
      boundaryIndex = index;
      break;
    }
  }
  if (boundaryIndex < 0) return [...output as CodexInputItem[]];

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
  return [...output as CodexInputItem[], ...retained];
}

export class OpaqueCompactStateStore {
  private readonly states = new Map<string, OpaqueCompactState>();
  private readonly stateBytes = new Map<string, number>();
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly secret: Buffer;
  private totalBytes = 0;

  constructor(options: OpaqueCompactStateStoreOptions = {}) {
    this.capacity = options.capacity ?? 128;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    this.secret = options.secret ?? randomBytes(32);
  }

  save(options: {
    output: unknown[];
    sessionId: string;
    model: string;
    accountEntryId: string;
    variantHash?: string;
  }): { marker: string; state: OpaqueCompactState } {
    const stateId = base64Url(randomBytes(24));
    const compHash = outputHash(options.output);
    const signature = this.sign(stateId, compHash);
    const createdAt = this.now();
    const state: OpaqueCompactState = {
      ...options,
      variantHash: options.variantHash ?? "",
      compHash,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (bytes > this.maxBytes) throw new OpaqueCompactStateError("state_too_large");
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
    return {
      marker: `<analysis>${MARKER_ANALYSIS}</analysis>\n<summary>${MARKER_PREFIX}:${stateId}:${compHash}:${signature}</summary>`,
      state,
    };
  }

  resolve(options: {
    marker: string;
    sessionId: string;
    model: string;
    accountEntryId?: string;
    variantHash?: string;
  }): OpaqueCompactState {
    const parsed = this.parse(options.marker);
    const expectedSignature = this.sign(parsed.stateId, parsed.compHash);
    if (!this.safeEqual(parsed.signature, expectedSignature)) {
      throw new OpaqueCompactStateError("tampered");
    }

    const state = this.states.get(parsed.stateId);
    if (!state) throw new OpaqueCompactStateError("missing");
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
    if (state.compHash !== parsed.compHash || outputHash(state.output) !== state.compHash) {
      throw new OpaqueCompactStateError("comp_hash_mismatch");
    }

    this.states.delete(parsed.stateId);
    this.states.set(parsed.stateId, state);
    return state;
  }

  delete(marker: string): void {
    try {
      this.deleteState(this.parse(marker).stateId);
    } catch {
      // Invalid markers have no state to delete.
    }
  }

  size(): number {
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
    this.stateBytes.clear();
    this.totalBytes = 0;
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
    return base64Url(createHmac("sha256", this.secret).update(`${MARKER_PREFIX}:${stateId}:${compHash}`).digest());
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private deleteState(stateId: string): void {
    const bytes = this.stateBytes.get(stateId) ?? 0;
    this.states.delete(stateId);
    this.stateBytes.delete(stateId);
    this.totalBytes = Math.max(0, this.totalBytes - bytes);
  }

  private trimToBounds(): void {
    while (this.states.size > this.capacity || this.totalBytes > this.maxBytes) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (!oldest) return;
      this.deleteState(oldest);
    }
  }
}

export const opaqueCompactStateStore = new OpaqueCompactStateStore();
