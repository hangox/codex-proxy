import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDataDir } from "../paths.js";
import type { CodexRawUsageObservation, CodexRawUsageSink } from "./codex-api.js";

const MAX_EVENTS = 9;
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LINE_BYTES = 4 * 1024;
const REQUEST_ID_HASH_DOMAIN = "codex-raw-usage-request-v1\0";

function hashRequestId(requestId: string | undefined): string | null {
  return requestId ? createHash("sha256").update(`${REQUEST_ID_HASH_DOMAIN}${requestId}`).digest("hex").slice(0, 16) : null;
}
const CONTROLLED_PER_ATTEMPT_TOKENS = 2_500;
const CONTROLLED_TOTAL_INPUT_TOKENS = 22_500;

export type RawUsageStopReason = "manual_delete" | "ttl_expired" | "max_events" | "write_error" | "line_oversize" | "budget_exceeded" | "dispatch_uncertain" | "terminal_failure" | "usage_missing" | "invalid_context";

interface RawUsageObservationState {
  runId: string;
  filePath: string;
  lockPath: string;
  maxEvents: number;
  expiresAt: number;
  eventCount: number;
  enabled: boolean;
  runToken: string;
  lockOwnerAlive: boolean;
  lockReclaimed: boolean;
  reservedInputTokens: number;
  reservedPendingInputTokens: number;
  committedOrUncertainInputTokens: number;
  reservations: Map<string, { estimatedTokens: number; state: "reserved" | "dispatched" | "released" | "uncertain" }>;
  perAttemptTokens: number;
  totalInputTokens: number;
  stopReason?: RawUsageStopReason;
  lastError?: string;
  rejectedCount: number;
  lastRejectedReason?: string;
}

let state: RawUsageObservationState | null = null;

function releaseLock(): void {
  if (!state) return;
  try { unlinkSync(state.lockPath); } catch { /* lock may already be gone */ }
}

export interface RawUsageObservationStartOptions {
  runId?: string;
  ttlSeconds?: number;
  maxEvents?: number;
  perAttemptTokens?: number;
  totalInputTokens?: number;
}

export interface RawUsageObservationStartResult extends RawUsageObservationSnapshot {
  runToken: string;
}

export interface RawUsageObservationSnapshot {
  enabled: boolean;
  runId: string | null;
  filePath: string | null;
  maxEvents: number;
  eventCount: number;
  expiresAt: number | null;
  lockOwnerAlive: boolean;
  lockReclaimed: boolean;
  perAttemptTokens: number;
  totalInputTokens: number;
  reservedInputTokens: number;
  reservedPendingInputTokens: number;
  committedOrUncertainInputTokens: number;
  stopReason?: RawUsageStopReason;
  lastError?: string;
  rejectedCount: number;
  lastRejectedReason?: string;
}

function snapshotState(): RawUsageObservationSnapshot {
  if (!state) {
    return {
      enabled: false,
      runId: null,
      filePath: null,
      maxEvents: MAX_EVENTS,
      eventCount: 0,
      expiresAt: null,
      lockOwnerAlive: false,
      lockReclaimed: false,
      perAttemptTokens: CONTROLLED_PER_ATTEMPT_TOKENS,
      totalInputTokens: CONTROLLED_TOTAL_INPUT_TOKENS,
      reservedInputTokens: 0,
      reservedPendingInputTokens: 0,
      committedOrUncertainInputTokens: 0,
      rejectedCount: 0,
    };
  }
  return {
    enabled: state.enabled && Date.now() < state.expiresAt && state.eventCount < state.maxEvents,
    runId: state.runId,
    filePath: state.filePath,
    maxEvents: state.maxEvents,
    eventCount: state.eventCount,
    expiresAt: state.expiresAt,
    lockOwnerAlive: state.lockOwnerAlive,
    lockReclaimed: state.lockReclaimed,
    perAttemptTokens: state.perAttemptTokens,
    totalInputTokens: state.totalInputTokens,
    reservedInputTokens: state.reservedInputTokens,
    reservedPendingInputTokens: [...state.reservations.values()].filter((item) => item.state === "reserved").reduce((sum, item) => sum + item.estimatedTokens, 0),
    committedOrUncertainInputTokens: [...state.reservations.values()].filter((item) => item.state === "dispatched" || item.state === "uncertain").reduce((sum, item) => sum + item.estimatedTokens, 0),
    ...(state.stopReason ? { stopReason: state.stopReason } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    rejectedCount: state.rejectedCount,
    ...(state.lastRejectedReason ? { lastRejectedReason: state.lastRejectedReason } : {}),
  };
}

type ProcessStartIdentityProvider = (pid: number) => string | null | undefined;

function defaultProcessStartIdentity(pid: number): string | null | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] ?? undefined;
  } catch {
    return null;
  }
}

let processStartIdentityProvider: ProcessStartIdentityProvider = defaultProcessStartIdentity;

export function setRawUsageLockLivenessForTesting(provider?: ProcessStartIdentityProvider): void {
  processStartIdentityProvider = provider ?? defaultProcessStartIdentity;
}

interface ObservationLockMetadata {
  schema_version: 1;
  pid: number;
  started_at: string;
  expires_at: number;
  run_id: string;
  process_start_identity: string | null;
}

function readLockMetadata(lockPath: string): ObservationLockMetadata {
  const stat = lstatSync(lockPath);
  if (!stat.isFile()) throw new Error("raw usage observation lock is not a regular file");
  const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).schema_version !== 1
    || typeof (parsed as Record<string, unknown>).pid !== "number"
    || typeof (parsed as Record<string, unknown>).started_at !== "string"
    || typeof (parsed as Record<string, unknown>).expires_at !== "number"
    || typeof (parsed as Record<string, unknown>).run_id !== "string"
    || ((parsed as Record<string, unknown>).process_start_identity !== null
      && typeof (parsed as Record<string, unknown>).process_start_identity !== "string")
  ) throw new Error("raw usage observation lock metadata is invalid");
  return parsed as ObservationLockMetadata;
}

function acquireObservationLock(lockPath: string, metadata: ObservationLockMetadata): { reclaimed: boolean; ownerAlive: boolean } {
  try {
    writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(lockPath, 0o600);
    return { reclaimed: false, ownerAlive: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("raw usage observation lock cannot be created");
  }
  let existing: ObservationLockMetadata;
  try {
    existing = readLockMetadata(lockPath);
  } catch {
    throw new Error("raw usage observation lock is malformed or inaccessible");
  }
  const ownerIdentity = processStartIdentityProvider(existing.pid);
  const ownerDead = ownerIdentity === null
    || (ownerIdentity !== undefined && existing.process_start_identity !== null && ownerIdentity !== existing.process_start_identity);
  const ownerAlive = ownerIdentity !== null
    && (ownerIdentity === undefined || existing.process_start_identity === null || ownerIdentity === existing.process_start_identity);
  if (!ownerDead && ownerAlive && existing.expires_at >= Date.now()) {
    throw new Error("raw usage observation is already active in another process");
  }
  if (!ownerDead && existing.expires_at >= Date.now()) {
    throw new Error("raw usage observation lock owner liveness is unknown");
  }
  try { unlinkSync(lockPath); } catch { throw new Error("raw usage observation stale lock cannot be reclaimed"); }
  try {
    writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(lockPath, 0o600);
    return { reclaimed: true, ownerAlive: false };
  } catch {
    throw new Error("raw usage observation lock acquisition raced with another process");
  }
}

function pruneObservationFiles(directory: string): void {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(1)) unlinkSync(join(directory, file.name));
}

function ensureActive(): RawUsageObservationState | null {
  if (!state) return null;
  if (Date.now() >= state.expiresAt) {
    state.enabled = false;
    state.stopReason ??= "ttl_expired";
    releaseLock();
    return null;
  }
  if (state.eventCount >= state.maxEvents) {
    state.enabled = false;
    state.stopReason ??= "max_events";
    releaseLock();
    return null;
  }
  return state.enabled ? state : null;
}

export function startRawUsageObservation(options: RawUsageObservationStartOptions = {}): RawUsageObservationStartResult {
  if (ensureActive()) throw new Error("raw usage observation is already active");
  const runId = options.runId ?? randomUUID();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("runId must contain only letters, digits, dot, underscore, or hyphen");
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`);
  }
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  if (maxEvents !== MAX_EVENTS) throw new Error(`maxEvents is fixed at ${MAX_EVENTS}`);
  const perAttemptTokens = options.perAttemptTokens ?? CONTROLLED_PER_ATTEMPT_TOKENS;
  const totalInputTokens = options.totalInputTokens ?? CONTROLLED_TOTAL_INPUT_TOKENS;
  if (perAttemptTokens !== CONTROLLED_PER_ATTEMPT_TOKENS || totalInputTokens !== CONTROLLED_TOTAL_INPUT_TOKENS) {
    throw new Error(`controlled budget is fixed at ${CONTROLLED_PER_ATTEMPT_TOKENS}/${CONTROLLED_TOTAL_INPUT_TOKENS}`);
  }

  const directory = resolve(getDataDir(), "raw-usage-observations");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lockPath = join(directory, ".active.lock");
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const lockResult = acquireObservationLock(lockPath, {
    schema_version: 1,
    pid: process.pid,
    started_at: new Date().toISOString(),
    expires_at: expiresAt,
    run_id: runId,
    process_start_identity: processStartIdentityProvider(process.pid) ?? null,
  });
  pruneObservationFiles(directory);
  const filePath = join(directory, `${runId}.jsonl`);
  try {
    writeFileSync(filePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (error) {
    try { unlinkSync(lockPath); } catch { /* ignore cleanup failure */ }
    throw error;
  }
  state = {
    runId,
    filePath,
    lockPath,
    lockOwnerAlive: true,
    lockReclaimed: lockResult.reclaimed,
    maxEvents,
    expiresAt,
    eventCount: 0,
    enabled: true,
    runToken: `${randomUUID()}${randomUUID()}`,
    reservedInputTokens: 0,
    reservedPendingInputTokens: 0,
    committedOrUncertainInputTokens: 0,
    reservations: new Map(),
    perAttemptTokens,
    totalInputTokens,
    rejectedCount: 0,
  };
  return { ...snapshotState(), runToken: state.runToken };
}

export function stopRawUsageObservation(reason: RawUsageStopReason = "manual_delete"): RawUsageObservationSnapshot {
  if (state) {
    state.enabled = false;
    state.stopReason ??= reason;
    releaseLock();
  }
  return snapshotState();
}

export function getRawUsageObservationSnapshot(): RawUsageObservationSnapshot {
  ensureActive();
  return snapshotState();
}

export interface RawUsageReadback {
  events: unknown[];
  invalidEventCount: number;
}

const READBACK_KEYS = new Set([
  "schema_version", "run_id", "ts", "request_id_hash", "attempt", "transport", "response_id",
  "terminal_event", "usage_present", "input_tokens_present", "input_tokens", "output_tokens_present",
  "output_tokens", "cached_tokens_present", "cached_tokens", "reasoning_tokens_present", "reasoning_tokens",
]);
const HASH_PATTERN = /^[0-9a-f]{16}$/;

function validateReadbackRecord(record: Record<string, unknown>): boolean {
  if (Object.keys(record).some((key) => !READBACK_KEYS.has(key)) || record.schema_version !== 1) return false;
  if (typeof record.run_id !== "string" || !RUN_ID_PATTERN.test(record.run_id)) return false;
  if (typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))) return false;
  if (!HASH_PATTERN.test(String(record.request_id_hash))) return false;
  if (!Number.isInteger(record.attempt) || (record.attempt as number) < 1) return false;
  if (record.transport !== "http" && record.transport !== "websocket") return false;
  if (record.response_id !== null && typeof record.response_id !== "string") return false;
  if (record.terminal_event !== "response.completed" && record.terminal_event !== "response.incomplete" && record.terminal_event !== "response.failed") return false;
  for (const key of ["usage_present", "input_tokens_present", "output_tokens_present", "cached_tokens_present", "reasoning_tokens_present"]) {
    if (typeof record[key] !== "boolean") return false;
  }
  for (const [presentKey, valueKey] of [["input_tokens_present", "input_tokens"], ["output_tokens_present", "output_tokens"], ["cached_tokens_present", "cached_tokens"], ["reasoning_tokens_present", "reasoning_tokens"]]) {
    const present = record[presentKey];
    const value = record[valueKey];
    if (present && (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0)) return false;
    if (!present && value !== null) return false;
  }
  if (!record.usage_present && (record.input_tokens_present || record.output_tokens_present || record.cached_tokens_present || record.reasoning_tokens_present)) return false;
  if (!record.usage_present && [record.input_tokens, record.output_tokens, record.cached_tokens, record.reasoning_tokens].some((value) => value !== null)) return false;
  if (record.cached_tokens_present && record.input_tokens_present && (record.cached_tokens as number) > (record.input_tokens as number)) return false;
  return true;
}

export function readRawUsageObservationEvents(): RawUsageReadback {
  const snapshot = getRawUsageObservationSnapshot();
  if (!snapshot.filePath) return { events: [], invalidEventCount: 0 };
  try {
    if (statSync(snapshot.filePath).size > MAX_EVENTS * MAX_LINE_BYTES) return { events: [], invalidEventCount: 1 };
    const events: unknown[] = [];
    let invalidEventCount = 0;
    for (const line of readFileSync(snapshot.filePath, "utf8").split("\n").filter(Boolean).slice(-MAX_EVENTS)) {
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { invalidEventCount++; continue; }
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { invalidEventCount++; continue; }
        const record = parsed as Record<string, unknown>;
        if (!validateReadbackRecord(record)) {
          invalidEventCount++;
          continue;
        }
        events.push(Object.fromEntries([...READBACK_KEYS].filter((key) => key in record).map((key) => [key, record[key]])));
      } catch {
        invalidEventCount++;
      }
    }
    return { events, invalidEventCount };
  } catch {
    return { events: [], invalidEventCount: 1 };
  }
}

function terminalStopReason(observation: CodexRawUsageObservation): RawUsageStopReason | undefined {
  if (observation.terminalEvent !== "response.completed") return "terminal_failure";
  if (!observation.usagePresent) return "usage_missing";
  return undefined;
}

function writeObservation(observation: CodexRawUsageObservation, observerToken: string | undefined): void {
  const active = ensureActive();
  if (!active) return;
  if (observerToken !== active.runToken) {
    if (observerToken) {
      active.enabled = false;
      active.stopReason = "invalid_context";
    }
    return;
  }

  const usage = observation.usage;
  const inputTokensPresent = usage?.input_tokens_present ?? usage?.input_tokens !== undefined;
  const outputTokensPresent = usage?.output_tokens_present ?? usage?.output_tokens !== undefined;
  const cachedTokensPresent = usage?.cached_tokens_present ?? usage?.cached_tokens !== undefined;
  const reasoningTokensPresent = usage?.reasoning_tokens_present ?? usage?.reasoning_tokens !== undefined;
  const row = {
    schema_version: 1,
    run_id: active.runId,
    ts: new Date().toISOString(),
    request_id_hash: hashRequestId(observation.requestId),
    attempt: observation.attempt ?? null,
    transport: observation.transport ?? null,
    response_id: observation.responseId,
    terminal_event: observation.terminalEvent,
    usage_present: observation.usagePresent,
    input_tokens_present: inputTokensPresent,
    input_tokens: inputTokensPresent ? usage?.input_tokens ?? null : null,
    output_tokens_present: outputTokensPresent,
    output_tokens: outputTokensPresent ? usage?.output_tokens ?? null : null,
    cached_tokens_present: cachedTokensPresent,
    cached_tokens: cachedTokensPresent ? usage?.cached_tokens ?? null : null,
    reasoning_tokens_present: reasoningTokensPresent,
    reasoning_tokens: reasoningTokensPresent ? usage?.reasoning_tokens ?? null : null,
  };
  const line = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    active.enabled = false;
    active.stopReason = "line_oversize";
    return;
  }
  try {
    chmodSync(active.filePath, 0o600);
    appendFileSync(active.filePath, line, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    active.enabled = false;
    active.stopReason = "write_error";
    active.lastError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    console.warn(`[RawUsageObserver] disabled after secure write failure: ${active.lastError}`);
    return;
  }
  active.eventCount += 1;
  const stopReason = terminalStopReason(observation);
  if (stopReason) active.stopReason = stopReason;
  if (active.eventCount >= active.maxEvents) active.stopReason ??= "max_events";
  if (stopReason || active.eventCount >= active.maxEvents) {
    active.enabled = false;
    releaseLock();
  }
}

export function isRawUsageObservationTokenActive(token: string | undefined): boolean {
  const active = ensureActive();
  return active !== null && token === active.runToken;
}

export function isRawUsageObservationRequestAllowed(
  token: string | undefined,
  runId: string | undefined,
  requestId: string | undefined,
): boolean {
  const active = ensureActive();
  if (!active) return false;
  if (token !== active.runToken || runId !== active.runId) {
    active.rejectedCount += 1;
    active.lastRejectedReason = "token_or_run_mismatch";
    return false;
  }
  const pattern = new RegExp(`^prompt-cache-${active.runId.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}-[1-9]$`);
  if (!requestId || !pattern.test(requestId)) {
    active.rejectedCount += 1;
    active.lastRejectedReason = "request_scope_mismatch";
    return false;
  }
  return true;
}

export function reserveRawUsageAttempt(token: string | undefined, estimatedTokens: number): string | false {
  const active = ensureActive();
  if (!active || token !== active.runToken) return false;
  if (!Number.isInteger(estimatedTokens) || estimatedTokens < 0 || estimatedTokens > active.perAttemptTokens) {
    active.enabled = false;
    active.stopReason = "budget_exceeded";
    releaseLock();
    return false;
  }
  if (active.reservedInputTokens + estimatedTokens > active.totalInputTokens) {
    active.enabled = false;
    active.stopReason = "budget_exceeded";
    releaseLock();
    return false;
  }
  const ticketId = randomUUID();
  active.reservations.set(ticketId, { estimatedTokens, state: "reserved" });
  active.reservedInputTokens += estimatedTokens;
  return ticketId;
}

export function markRawUsageDispatch(token: string | undefined, ticketId: string, state: "dispatched" | "uncertain"): void {
  const active = ensureActive();
  const ticket = active?.reservations.get(ticketId);
  if (!active || token !== active.runToken || !ticket || ticket.state !== "reserved") return;
  ticket.state = state;
  if (state === "uncertain") {
    active.enabled = false;
    active.stopReason = "dispatch_uncertain";
    releaseLock();
  }
}

export function releaseRawUsageReservation(token: string | undefined, ticketId: string): void {
  const active = ensureActive();
  const ticket = active?.reservations.get(ticketId);
  if (!active || token !== active.runToken || !ticket || ticket.state !== "reserved") return;
  ticket.state = "released";
  active.reservedInputTokens -= ticket.estimatedTokens;
}

export function recordRawUsageObservation(
  observation: CodexRawUsageObservation,
  observerToken: string | undefined,
  observerRunId: string | undefined,
): void {
  if (!isRawUsageObservationRequestAllowed(observerToken, observerRunId, observation.requestId)) return;
  writeObservation(observation, observerToken);
}

export function getRawUsageObservationSink(): CodexRawUsageSink | undefined {
  const active = ensureActive();
  if (!active) return undefined;
  const boundToken = active.runToken;
  return (observation) => writeObservation(observation, boundToken);
}
