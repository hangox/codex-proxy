#!/usr/bin/env node
/**
 * 原始上游 prompt cache 限额实验驱动。
 *
 * 默认只打印实验计划，不发请求。必须显式传入 --run 才会调用代理。
 * 输出只包含请求明细、哈希、长度及 usage 数值，不保存前缀、尾部文本或凭据。
 *
 * 示例：
 *   npx tsx scripts/experiments/prompt-cache-driver.ts \
 *     --prefix-file /path/to/stable-prefix.txt \
 *     --measurements 5 --run --output /tmp/prompt-cache.jsonl
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Tiktoken } from "js-tiktoken/lite";

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_PREFIX_BYTES = 32_768;
const DEFAULT_PREFIX_TOKENS = 8_192;
const DEFAULT_WARMUPS = 1;
const DEFAULT_MEASUREMENTS = 5;
const DEFAULT_MAX_REQUESTS = 64;
const DEFAULT_MAX_PREFIX_BYTES = 1_000_000;
const DEFAULT_MAX_OBSERVED_INPUT_TOKENS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_DELAY_MS = 250;

type Format = "responses" | "messages";
type EvidenceSource = "downstream" | "upstream";
type Scenario = "warmup" | "fixed-prefix" | "tail-only" | "negative-control";

interface ExperimentCase {
  index: number;
  requestId: string;
  scenario: Scenario;
  variant: string;
  prefix: string;
  tail: string;
  inputTokenLowerBound: number;
}

export interface Config {
  baseUrl: string;
  format: Format;
  model: string;
  prefix: string;
  prefixTokens: number;
  routingKey: string;
  sessionId: string;
  runId: string;
  prefixHash: string;
  tailVariants: string[];
  warmups: number;
  measurements: number;
  includeNegativeControl: boolean;
  stream: boolean;
  run: boolean;
  maxRequests: number;
  maxObservedInputTokens: number;
  timeoutMs: number;
  delayMs: number;
  apiKey?: string;
  outputPath?: string;
  tokenizer: Tiktoken;
  maxInputTokens: number;
  upstreamEvidencePath?: string;
  controlledRun: boolean;
  rawUsageToken?: string;
}

export interface UsageObservation {
  evidenceSource: EvidenceSource;
  responseId?: string;
  rawAvailable: boolean;
  rawInputTokens?: number;
  rawCachedTokens?: number;
  rawCachedTokensPresent: boolean;
  rawUsageValid: boolean;
  rawUsageInvalidReason?: string;
  rawUsageAvailabilityReason?: string;
  upstreamTerminalEvent?: string;
  clientAvailable: boolean;
  clientInputTokens?: number;
  clientCachedTokens?: number;
}

interface UpstreamEvidenceLine {
  schema_version: 1;
  run_id: string;
  ts: string;
  request_id_hash: string;
  attempt: number;
  transport: "http" | "websocket";
  response_id: string;
  terminal_event: "response.completed" | "response.incomplete" | "response.failed";
  usage_present: boolean;
  input_tokens_present: boolean;
  input_tokens: number | null;
  output_tokens_present: boolean;
  output_tokens: number | null;
  cached_tokens_present: boolean;
  cached_tokens: number | null;
  reasoning_tokens_present: boolean;
  reasoning_tokens: number | null;
}

export interface RequestRecord {
  type: "request";
  index: number;
  requestId: string;
  runId: string;
  scenario: Scenario;
  variant: string;
  prefixHash: string;
  prefixChars: number;
  routingKeyHash: string;
  sessionIdHash: string;
  tailHash: string;
  tailChars: number;
  inputTokenLowerBound: number;
  status: number | "dry-run";
  ok: boolean;
  elapsedMs: number;
  usage: UsageObservation;
  upstreamAttempt?: number;
  upstreamEvidenceConflict?: boolean;
  upstreamEvidenceRejectReason?: string;
  error?: { status: number; statusText: string };
}

export interface Summary {
  type: "summary";
  format: Format;
  model: string;
  prefixHash: string;
  prefixChars: number;
  prefixTokens: number;
  requestCount: number;
  failedCount: number;
  evidenceSufficient: boolean;
  upstreamEvidenceCount: number;
  downstreamUsageCount: number;
  unlinkedSampleCount: number;
  unknownRawUsageCount: number;
  invalidRawUsageCount: number;
  rawUsagePresentCount: number;
  rawCachedTokensPresentCount: number;
  measuredRawInputTokens: number;
  measuredRawCachedTokens: number;
  knownOnlySampleCount: number;
  knownOnlyInputTokens: number;
  knownOnlyCachedTokens: number;
  knownOnlyCacheHitRate: number | null;
  rawCacheHitRate: number | null;
  plannedInputTokenLowerBound: number;
  maxInputTokens: number;
  maxObservedInputTokens: number;
  budgetStoppedBeforeDispatch: boolean;
  observedInFlightOverrun: boolean;
  controlledRun: boolean;
  controlledStopReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const REQUEST_ID_HASH_DOMAIN = "codex-raw-usage-request-v1\0";
export function hashRequestId(requestId: string): string {
  return createHash("sha256").update(`${REQUEST_ID_HASH_DOMAIN}${requestId}`).digest("hex").slice(0, 16);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 需要一个值`);
  }
  return value;
}

function numberOption(args: string[], name: string, fallback: number, minimum: number): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} 必须是大于等于 ${minimum} 的整数`);
  }
  return value;
}

function parseFormat(value: string | undefined): Format {
  if (value === undefined || value === "responses") return "responses";
  if (value === "messages") return "messages";
  throw new Error("--format 只能是 responses 或 messages");
}

function parseList(value: string | undefined): string[] {
  const result = (value ?? "tail-a,tail-b,tail-c")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (result.length === 0) throw new Error("--tail-variants 至少需要一个尾部变体");
  return result;
}

async function loadTokenizer(): Promise<Tiktoken> {
  const [{ Tiktoken }, ranksModule] = await Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]);
  return new Tiktoken(ranksModule.default);
}

function buildGeneratedPrefix(targetTokens: number, tokenizer: Tiktoken, maxBytes: number): string {
  const unit = "Stable prompt-cache experiment prefix. Keep this prefix unchanged across requests.\n";
  let prefix = "";
  while (tokenizer.encode(prefix).length < targetTokens) {
    prefix += unit;
    if (Buffer.byteLength(prefix, "utf8") > maxBytes) {
      throw new Error(`生成固定前缀超过 --max-prefix-bytes=${maxBytes}，请降低 --prefix-tokens`);
    }
  }
  const tokens = tokenizer.encode(prefix);
  return tokens.length === targetTokens ? prefix : tokenizer.decode(tokens.slice(0, targetTokens));
}

async function loadPrefix(args: string[], maxBytes: number, tokenizer: Tiktoken): Promise<{ text: string; tokens: number }> {
  const filePath = optionValue(args, "--prefix-file");
  const literal = optionValue(args, "--prefix-text");
  const explicitBytes = optionValue(args, "--prefix-bytes");
  if (filePath && literal) throw new Error("--prefix-file 与 --prefix-text 不能同时使用");
  if (explicitBytes && optionValue(args, "--prefix-tokens")) {
    throw new Error("--prefix-bytes 与 --prefix-tokens 不能同时使用");
  }

  const prefix = filePath
    ? await readFile(filePath, "utf8")
    : literal ?? (explicitBytes
      ? (() => {
          const bytes = numberOption(args, "--prefix-bytes", DEFAULT_PREFIX_BYTES, 1);
          const unit = "Stable prompt-cache experiment prefix. Keep this prefix unchanged across requests.\n";
          let generated = "";
          while (Buffer.byteLength(generated, "utf8") < bytes) generated += unit;
          return Buffer.from(generated, "utf8").subarray(0, bytes).toString("utf8");
        })()
      : buildGeneratedPrefix(numberOption(args, "--prefix-tokens", DEFAULT_PREFIX_TOKENS, 1), tokenizer, maxBytes));
  const bytes = Buffer.byteLength(prefix, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`固定前缀为 ${bytes} bytes，超过 --max-prefix-bytes=${maxBytes}`);
  }
  if (prefix.length === 0) throw new Error("固定前缀不能为空");
  return { text: prefix, tokens: tokenizer.encode(prefix).length };
}

function buildCases(config: Config): ExperimentCase[] {
  const cases: ExperimentCase[] = [];
  let index = 1;
  const addCase = (scenario: Scenario, variant: string, prefix: string, tail: string): void => {
    const caseIndex = index++;
    const candidate: ExperimentCase = {
      index: caseIndex,
      requestId: `prompt-cache-${config.runId}-${caseIndex}`,
      scenario,
      variant,
      prefix,
      tail,
      inputTokenLowerBound: 0,
    };
    // Controlled mode budgets the serialized final wire request, not just text fragments.
    candidate.inputTokenLowerBound = config.tokenizer.encode(JSON.stringify(buildRequest(config, candidate))).length;
    cases.push(candidate);
  };
  const firstTail = config.tailVariants[0];
  if (config.controlledRun) {
    addCase("warmup", "A-warmup", config.prefix, firstTail);
    addCase("fixed-prefix", "A-repeat-1", config.prefix, firstTail);
    addCase("fixed-prefix", "A-repeat-2", config.prefix, firstTail);
    addCase("warmup", "B-warmup", config.prefix, firstTail);
    addCase("tail-only", "B-tail-1", config.prefix, config.tailVariants[0]);
    addCase("tail-only", "B-tail-2", config.prefix, config.tailVariants[1] ?? config.tailVariants[0]);
    const negativePrefix = `NEGATIVE-CONTROL-${hashText(config.prefix)}\n${config.prefix}`;
    addCase("warmup", "C-warmup", config.prefix, firstTail);
    addCase("negative-control", "C-negative-1", negativePrefix, firstTail);
    addCase("negative-control", "C-negative-2", negativePrefix, firstTail);
    return cases;
  }
  for (let i = 0; i < config.warmups; i++) {
    addCase("warmup", `warmup-${i + 1}`, config.prefix, firstTail);
  }
  for (let i = 0; i < config.measurements; i++) {
    addCase("fixed-prefix", "same-tail", config.prefix, firstTail);
  }
  for (let i = 0; i < config.measurements; i++) {
    addCase("tail-only", `tail-${i + 1}`, config.prefix, config.tailVariants[i % config.tailVariants.length]);
  }
  if (config.includeNegativeControl) {
    const negativePrefix = `NEGATIVE-CONTROL-${hashText(config.prefix)}\n${config.prefix}`;
    for (let i = 0; i < config.measurements; i++) {
      addCase("negative-control", `negative-${i + 1}`, negativePrefix, config.tailVariants[i % config.tailVariants.length]);
    }
  }
  return cases;
}

function buildRequest(config: Config, experimentCase: ExperimentCase): Record<string, unknown> {
  if (config.format === "responses") {
    return {
      model: config.model,
      instructions: experimentCase.prefix,
      prompt_cache_key: config.routingKey,
      input: [
        { role: "user", content: [{ type: "input_text", text: `EXPERIMENT_ANCHOR:${hashText(config.routingKey)}` }] },
        { role: "user", content: [{ type: "input_text", text: experimentCase.tail }] },
      ],
      stream: config.stream,
      store: false,
    };
  }
  return {
    model: config.model,
    max_tokens: 64,
    system: experimentCase.prefix,
    messages: [
      { role: "user", content: `EXPERIMENT_ANCHOR:${hashText(config.routingKey)}` },
      { role: "user", content: experimentCase.tail },
    ],
    stream: config.stream,
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractUsageRecord(value: unknown, evidenceSource: EvidenceSource): UsageObservation {
  if (!isRecord(value)) {
    return {
      evidenceSource,
      rawAvailable: false,
      rawCachedTokensPresent: false,
      rawUsageValid: false,
      clientAvailable: false,
    };
  }

  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const rawInputTokens = numberField(value.input_tokens);
  const rawOutputTokens = numberField(value.output_tokens);
  const nestedCachedTokens = inputDetails ? numberField(inputDetails.cached_tokens) : undefined;
  const directCachedTokens = numberField(value.cached_tokens);
  const nestedCachedFieldPresent = Boolean(inputDetails && Object.hasOwn(inputDetails, "cached_tokens"));
  const directCachedFieldPresent = Object.hasOwn(value, "cached_tokens");
  const rawCachedTokensPresent = nestedCachedTokens !== undefined || directCachedTokens !== undefined;
  const invalidReasons: string[] = [];
  const availabilityReasons: string[] = [];
  if (rawInputTokens === undefined) availabilityReasons.push("missing_input_tokens");
  else if (!Number.isInteger(rawInputTokens) || rawInputTokens < 0) invalidReasons.push("input_tokens_not_nonnegative_integer");
  if (rawOutputTokens === undefined) availabilityReasons.push("missing_output_tokens");
  else if (!Number.isInteger(rawOutputTokens) || rawOutputTokens < 0) invalidReasons.push("output_tokens_not_nonnegative_integer");
  if ((nestedCachedFieldPresent || directCachedFieldPresent) && nestedCachedTokens === undefined && directCachedTokens === undefined) {
    invalidReasons.push("cached_tokens_not_numeric");
  }
  const rawCachedTokens = nestedCachedTokens ?? directCachedTokens;
  if (rawCachedTokens !== undefined) {
    if (!Number.isInteger(rawCachedTokens) || rawCachedTokens < 0) invalidReasons.push("cached_tokens_not_nonnegative_integer");
    else if (rawInputTokens !== undefined && rawCachedTokens > rawInputTokens) invalidReasons.push("cached_tokens_exceeds_input_tokens");
  }
  const rawAvailable = rawInputTokens !== undefined || rawOutputTokens !== undefined || nestedCachedFieldPresent || directCachedFieldPresent;
  return {
    evidenceSource,
    rawAvailable,
    rawInputTokens,
    rawCachedTokens,
    rawCachedTokensPresent,
    rawUsageValid: rawAvailable && availabilityReasons.length === 0 && invalidReasons.length === 0,
    ...(availabilityReasons.length > 0 ? { rawUsageAvailabilityReason: availabilityReasons.join(",") } : {}),
    ...(invalidReasons.length > 0 ? { rawUsageInvalidReason: invalidReasons.join(",") } : {}),
    clientAvailable: true,
    clientInputTokens: rawInputTokens,
    clientCachedTokens: rawCachedTokens,
  };
}

function parseDataPayloads(text: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) payloads.push(parsed);
    } catch {
      // 非 JSON 的 SSE 行不参与 usage 解析，但请求明细仍会保留。
    }
  }
  return payloads;
}

function extractUsage(format: Format, text: string, contentType: string): UsageObservation {
  const isStream = contentType.includes("text/event-stream") || text.includes("data: ");
  const payloads = isStream ? parseDataPayloads(text) : (() => {
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  })();
  if (payloads.length === 0) {
    return { evidenceSource: "downstream", rawAvailable: false, rawCachedTokensPresent: false, rawUsageValid: false, clientAvailable: false };
  }

  if (format === "responses") {
    const completed = payloads.find((payload) => payload.type === "response.completed");
    const completedResponse = completed && isRecord(completed.response) ? completed.response : undefined;
    const direct = payloads[payloads.length - 1];
    const rawUsage = completedResponse?.usage ?? direct.usage;
    const observed = extractUsageRecord(rawUsage, "downstream");
    const responseId = typeof completedResponse?.id === "string"
      ? completedResponse.id
      : typeof direct.id === "string" ? direct.id : undefined;
    return responseId ? { ...observed, responseId } : observed;
  }

  const finalDelta = [...payloads].reverse().find((payload) => payload.type === "message_delta");
  const direct = payloads[payloads.length - 1];
  const clientUsage = finalDelta?.usage ?? direct.usage;
  const observed = extractUsageRecord(clientUsage, "downstream");
  // Anthropic 的 cache_read_input_tokens 是转换后的客户端字段，不是本实验要求的
  // Codex 原始 cached_tokens 证据。
  const clientInputTokens = isRecord(clientUsage) ? numberField(clientUsage.input_tokens) : undefined;
  const clientCachedTokens = isRecord(clientUsage) ? numberField(clientUsage.cache_read_input_tokens) : undefined;
  return {
    evidenceSource: "downstream",
    ...(typeof direct.id === "string" ? { responseId: direct.id } : {}),
    rawAvailable: false,
    rawCachedTokensPresent: false,
    rawUsageValid: false,
    clientAvailable: observed.clientAvailable,
    clientInputTokens,
    clientCachedTokens,
  };
}

function createHeaders(config: Config, requestId: string): Record<string, string> {
  return {
    "x-request-id": requestId,
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(config.format === "messages" ? { "x-claude-code-session-id": config.sessionId } : {}),
    ...(config.rawUsageToken ? { "x-codex-raw-usage-token": config.rawUsageToken, "x-codex-raw-usage-run-id": config.runId } : {}),
  };
}

async function runCase(config: Config, experimentCase: ExperimentCase): Promise<RequestRecord> {
  const started = performance.now();
  const url = `${config.baseUrl.replace(/\/$/, "")}${config.format === "responses" ? "/v1/responses" : "/v1/messages"}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: createHeaders(config, experimentCase.requestId),
      body: JSON.stringify(buildRequest(config, experimentCase)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    return {
      type: "request",
      index: experimentCase.index,
      requestId: experimentCase.requestId,
      runId: config.runId,
      scenario: experimentCase.scenario,
      variant: experimentCase.variant,
      prefixHash: hashText(experimentCase.prefix),
      prefixChars: experimentCase.prefix.length,
      routingKeyHash: hashText(config.routingKey),
      sessionIdHash: hashText(config.sessionId),
      tailHash: hashText(experimentCase.tail),
      tailChars: experimentCase.tail.length,
      inputTokenLowerBound: experimentCase.inputTokenLowerBound,
      status: response.status,
      ok: response.ok,
      elapsedMs,
      usage: extractUsage(config.format, text, response.headers.get("content-type") ?? ""),
      ...(!response.ok ? { error: { status: response.status, statusText: response.statusText } } : {}),
    };
  } catch (error) {
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const statusText = error instanceof Error ? error.name : "request_failed";
    return {
      type: "request",
      index: experimentCase.index,
      requestId: experimentCase.requestId,
      runId: config.runId,
      scenario: experimentCase.scenario,
      variant: experimentCase.variant,
      prefixHash: hashText(experimentCase.prefix),
      prefixChars: experimentCase.prefix.length,
      routingKeyHash: hashText(config.routingKey),
      sessionIdHash: hashText(config.sessionId),
      tailHash: hashText(experimentCase.tail),
      tailChars: experimentCase.tail.length,
      inputTokenLowerBound: experimentCase.inputTokenLowerBound,
      status: 0,
      ok: false,
      elapsedMs,
      usage: { evidenceSource: "downstream", rawAvailable: false, rawCachedTokensPresent: false, rawUsageValid: false, clientAvailable: false },
      error: { status: 0, statusText },
    };
  }
}

function publicRequestRecord(record: RequestRecord): Record<string, unknown> {
  const { requestId, ...safe } = record;
  return { ...safe, requestIdHash: hashRequestId(requestId) };
}

export async function mergeUpstreamEvidence(records: RequestRecord[], path: string | undefined, format: Format): Promise<void> {
  if (!path) return;
  const lines = (await readFile(path, "utf8")).split("\n");
  const grouped = new Map<string, UpstreamEvidenceLine[]>();
  const invalidRequestIds = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const possibleRequestId = typeof parsed.request_id_hash === "string" ? parsed.request_id_hash : null;
      const markInvalid = (): void => {
        if (possibleRequestId) invalidRequestIds.add(possibleRequestId);
      };
      const requiredKeys = [
        "schema_version", "run_id", "ts", "request_id_hash", "attempt", "transport", "response_id",
        "terminal_event", "usage_present", "input_tokens_present", "input_tokens",
        "output_tokens_present", "output_tokens", "cached_tokens_present", "cached_tokens",
        "reasoning_tokens_present", "reasoning_tokens",
      ];
      if (Object.keys(parsed).some((key) => !requiredKeys.includes(key))) { markInvalid(); continue; }
      if (
        parsed.schema_version !== 1
        || typeof parsed.run_id !== "string"
        || typeof parsed.ts !== "string"
        || typeof parsed.request_id_hash !== "string"
        || !Number.isInteger(parsed.attempt)
        || (parsed.transport !== "http" && parsed.transport !== "websocket")
        || typeof parsed.response_id !== "string"
        || !parsed.response_id
        || (parsed.terminal_event !== "response.completed" && parsed.terminal_event !== "response.incomplete" && parsed.terminal_event !== "response.failed")
        || typeof parsed.usage_present !== "boolean"
        || typeof parsed.input_tokens_present !== "boolean"
        || typeof parsed.output_tokens_present !== "boolean"
        || typeof parsed.cached_tokens_present !== "boolean"
        || typeof parsed.reasoning_tokens_present !== "boolean"
      ) { markInvalid(); continue; }
      if (
        (parsed.input_tokens_present && typeof parsed.input_tokens !== "number")
        || (!parsed.input_tokens_present && parsed.input_tokens !== null)
        || (parsed.output_tokens_present && typeof parsed.output_tokens !== "number")
        || (!parsed.output_tokens_present && parsed.output_tokens !== null)
        || (parsed.cached_tokens_present && typeof parsed.cached_tokens !== "number")
        || (!parsed.cached_tokens_present && parsed.cached_tokens !== null)
        || (parsed.reasoning_tokens_present && typeof parsed.reasoning_tokens !== "number")
        || (!parsed.reasoning_tokens_present && parsed.reasoning_tokens !== null)
        || (!parsed.usage_present && (parsed.input_tokens_present || parsed.output_tokens_present || parsed.cached_tokens_present || parsed.reasoning_tokens_present))
        || (!parsed.usage_present && (parsed.input_tokens !== null || parsed.output_tokens !== null || parsed.cached_tokens !== null || parsed.reasoning_tokens !== null))
      ) { markInvalid(); continue; }
      const evidence: UpstreamEvidenceLine = {
        schema_version: 1,
        run_id: parsed.run_id as string,
        ts: parsed.ts as string,
        request_id_hash: parsed.request_id_hash as string,
        attempt: parsed.attempt as number,
        transport: parsed.transport as "http" | "websocket",
        response_id: parsed.response_id as string,
        terminal_event: parsed.terminal_event as UpstreamEvidenceLine["terminal_event"],
        usage_present: parsed.usage_present as boolean,
        input_tokens_present: parsed.input_tokens_present as boolean,
        input_tokens: parsed.input_tokens as number | null,
        output_tokens_present: parsed.output_tokens_present as boolean,
        output_tokens: parsed.output_tokens as number | null,
        cached_tokens_present: parsed.cached_tokens_present as boolean,
        cached_tokens: parsed.cached_tokens as number | null,
        reasoning_tokens_present: parsed.reasoning_tokens_present as boolean,
        reasoning_tokens: parsed.reasoning_tokens as number | null,
      };
      const existing = grouped.get(evidence.request_id_hash) ?? [];
      existing.push(evidence);
      grouped.set(evidence.request_id_hash, existing);
    } catch {
      // 忽略损坏的 observer 行，但不把它伪装成有效 raw evidence。
    }
  }
  for (const record of records) {
    const candidates = grouped.get(hashRequestId(record.requestId)) ?? [];
    if (candidates.length === 0 && invalidRequestIds.has(hashRequestId(record.requestId))) {
      record.upstreamEvidenceRejectReason = "schema_invalid";
      continue;
    }
    // 一次请求存在多个 attempt 时，当前逐请求格式无法安全汇总每次消耗；拒收而不是猜末次。
    if (candidates.length !== 1) {
      if (candidates.length > 1) record.upstreamEvidenceConflict = true;
      continue;
    }
    const [evidence] = candidates;
    const reasons: string[] = [];
    if (evidence.run_id !== record.runId) reasons.push("run_id_mismatch");
    if (evidence.request_id_hash !== hashRequestId(record.requestId)) reasons.push("request_id_mismatch");
    if (!Number.isInteger(evidence.attempt) || evidence.attempt < 1) reasons.push("attempt_invalid");
    if (!evidence.response_id) reasons.push("response_id_missing");
    if (evidence.terminal_event !== "response.completed" && evidence.terminal_event !== "response.incomplete" && evidence.terminal_event !== "response.failed") {
      reasons.push("terminal_invalid");
    }
    if (format === "responses") {
      if (!record.usage.responseId) reasons.push("downstream_response_id_missing");
      else if (evidence.response_id !== record.usage.responseId) reasons.push("response_id_mismatch");
    }
    if (evidence.attempt !== 1) reasons.push("attempt_not_current");
    if (reasons.length > 0) {
      record.upstreamEvidenceRejectReason = reasons.join(",");
      continue;
    }
    const usageValue: Record<string, unknown> = {};
    if (evidence.input_tokens_present) usageValue.input_tokens = evidence.input_tokens;
    if (evidence.output_tokens_present) usageValue.output_tokens = evidence.output_tokens;
    if (evidence.cached_tokens_present) usageValue.input_tokens_details = { cached_tokens: evidence.cached_tokens };
    if (evidence.reasoning_tokens_present) usageValue.output_tokens_details = { reasoning_tokens: evidence.reasoning_tokens };
    record.usage = {
      ...extractUsageRecord(usageValue, "upstream"),
      responseId: evidence.response_id,
      upstreamTerminalEvent: evidence.terminal_event,
    };
    record.upstreamAttempt = evidence.attempt;
  }
}

export function summarize(
  config: Config,
  records: RequestRecord[],
  plannedInputTokenLowerBound: number,
  budgetStoppedBeforeDispatch: boolean,
  observedInFlightOverrun: boolean,
  controlledStopReason?: string,
): Summary {
  const measured = records.filter((record) => record.scenario !== "warmup");
  const upstreamMeasured = measured.filter((record) => record.usage.evidenceSource === "upstream");
  const downstreamUsage = measured.filter((record) => record.usage.evidenceSource === "downstream" && record.usage.clientAvailable);
  const rawRecords = upstreamMeasured.filter((record) => record.usage.rawAvailable);
  const rawInputRecords = upstreamMeasured.filter((record) => record.usage.rawInputTokens !== undefined);
  const rawCachedRecords = upstreamMeasured.filter((record) => record.usage.rawCachedTokensPresent);
  const knownOnlyRecords = upstreamMeasured.filter(
    (record) => record.ok
      && record.usage.upstreamTerminalEvent === "response.completed"
      && record.usage.rawUsageValid
      && record.usage.rawInputTokens !== undefined
      && record.usage.rawCachedTokensPresent,
  );
  const invalidRawUsageCount = upstreamMeasured.filter((record) => record.usage.rawUsageInvalidReason !== undefined).length;
  const unknownRawUsageCount = upstreamMeasured.filter(
    (record) => !record.usage.rawAvailable
      || record.usage.rawInputTokens === undefined
      || !record.usage.rawCachedTokensPresent,
  ).length;
  const measuredRawInputTokens = rawInputRecords.reduce((sum, record) => sum + (record.usage.rawInputTokens ?? 0), 0);
  const measuredRawCachedTokens = rawCachedRecords.reduce((sum, record) => sum + (record.usage.rawCachedTokens ?? 0), 0);
  const knownOnlyInputTokens = knownOnlyRecords.reduce((sum, record) => sum + (record.usage.rawInputTokens ?? 0), 0);
  const knownOnlyCachedTokens = knownOnlyRecords.reduce((sum, record) => sum + (record.usage.rawCachedTokens ?? 0), 0);
  const evidenceSufficient = measured.length > 0
    && upstreamMeasured.length === measured.length
    && unknownRawUsageCount === 0
    && invalidRawUsageCount === 0
    && measured.every((record) => record.ok && record.usage.upstreamTerminalEvent === "response.completed");
  return {
    type: "summary",
    format: config.format,
    model: config.model,
    prefixHash: config.prefixHash,
    prefixChars: config.prefix.length,
    prefixTokens: config.prefixTokens,
    requestCount: records.length,
    failedCount: records.filter((record) => !record.ok).length,
    evidenceSufficient,
    upstreamEvidenceCount: upstreamMeasured.length,
    downstreamUsageCount: downstreamUsage.length,
    unlinkedSampleCount: measured.length - upstreamMeasured.length,
    unknownRawUsageCount,
    invalidRawUsageCount,
    rawUsagePresentCount: rawRecords.length,
    rawCachedTokensPresentCount: rawCachedRecords.length,
    measuredRawInputTokens,
    measuredRawCachedTokens,
    knownOnlySampleCount: knownOnlyRecords.length,
    knownOnlyInputTokens,
    knownOnlyCachedTokens,
    knownOnlyCacheHitRate: knownOnlyInputTokens > 0 ? knownOnlyCachedTokens / knownOnlyInputTokens : null,
    // 未提供与同次 request/attempt 关联的原始上游证据时，headline 不可验收。
    rawCacheHitRate: evidenceSufficient && measuredRawInputTokens > 0
      ? measuredRawCachedTokens / measuredRawInputTokens
      : null,
    plannedInputTokenLowerBound,
    maxInputTokens: config.maxInputTokens,
    maxObservedInputTokens: records.reduce((sum, record) => sum + (record.usage.rawInputTokens ?? 0), 0),
    budgetStoppedBeforeDispatch,
    observedInFlightOverrun,
    controlledRun: config.controlledRun,
    ...(controlledStopReason ? { controlledStopReason } : {}),
  };
}

function printUsage(): void {
  process.stdout.write([
    "用法：",
    "  npx tsx scripts/experiments/prompt-cache-driver.ts [选项]",
    "",
    "默认 dry-run；真实请求必须显式传 --run。",
    "  --run                         执行请求",
    "  --controlled-run              受控 9-call 模式，需 --run/raw token/max-input-tokens=22500/max-observed-input-tokens≤22500",
    "  CODEX_RAW_USAGE_OBSERVATION_TOKEN 环境变量：admin POST 返回的一次性 run token",
    "  --base-url URL                代理地址，默认 PROMPT_CACHE_BASE_URL/PROXY_URL/localhost",
    "  --format responses|messages   默认 responses；messages 只记录转换后的 client usage",
    "  --model MODEL                默认 PROMPT_CACHE_MODEL/gpt-5.4",
    "  --prompt-cache-key KEY       各实验组固定 routing key（只输出哈希）",
    "  --session-id ID              Messages 使用的稳定 Claude session header（只输出哈希）",
    "  --prefix-file PATH            读取固定前缀（不输出内容）",
    "  --prefix-text TEXT            使用固定前缀文本",
    "  --prefix-tokens N             用 o200k_base 真实生成目标 token 数，默认 8192",
    "  --prefix-bytes N              生成指定字节数后仍用 tokenizer 实测 token 数",
    "  --tail-variants A,B,C         尾部变体，默认 tail-a,tail-b,tail-c",
    "  --warmups N                   预热次数，默认 1",
    "  --measurements N              每类测量次数，默认 5",
    "  --no-negative-control         不执行改变前缀的负对照",
    "  --stream                     使用 SSE；默认非流式",
    "  --max-requests N              请求数量硬上限，默认 64",
    "  --max-input-tokens N          dispatch 前累计输入下界硬上限，默认 2000000",
    "  --max-observed-input-tokens N 观测到原始 input 超限后停止并标记在途超支",
    "  --timeout-ms N                单请求超时，默认 60000",
    "  --delay-ms N                  请求间隔，默认 250",
    "  --upstream-evidence-file PATH  合并 observer JSONL；无关联时仍为 downstream",
    "  --output PATH                 同时将 JSONL 明细写入文件",
    "responses/messages fetch usage 的 evidenceSource=downstream；无 raw observer 时不可用于模型命中验收。",
    "凭据从 PROMPT_CACHE_API_KEY 或 PROXY_API_KEY 读取，永不打印。",
    "",
  ].join("\n"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help")) {
    printUsage();
    return;
  }

  const maxPrefixBytes = numberOption(args, "--max-prefix-bytes", DEFAULT_MAX_PREFIX_BYTES, 1);
  const tokenizer = await loadTokenizer();
  const prefixData = await loadPrefix(args, maxPrefixBytes, tokenizer);
  const baseUrl = optionValue(args, "--base-url") ?? process.env.PROMPT_CACHE_BASE_URL ?? process.env.PROXY_URL ?? DEFAULT_BASE_URL;
  const format = parseFormat(optionValue(args, "--format"));
  const model = optionValue(args, "--model") ?? process.env.PROMPT_CACHE_MODEL ?? DEFAULT_MODEL;
  const runIdOption = optionValue(args, "--run-id");
  const tailVariants = parseList(optionValue(args, "--tail-variants"));
  const warmups = numberOption(args, "--warmups", DEFAULT_WARMUPS, 0);
  const measurements = numberOption(args, "--measurements", DEFAULT_MEASUREMENTS, 1);
  const includeNegativeControl = !hasFlag(args, "--no-negative-control");
  const config: Config = {
    baseUrl,
    format,
    model,
    prefix: prefixData.text,
    prefixTokens: prefixData.tokens,
    prefixHash: hashText(prefixData.text),
    routingKey: optionValue(args, "--prompt-cache-key") ?? `prompt-cache-${hashText(prefixData.text)}`,
    sessionId: optionValue(args, "--session-id") ?? process.env.PROMPT_CACHE_SESSION_ID ?? `prompt-cache-session-${hashText(prefixData.text)}`,
    runId: runIdOption ?? randomUUID(),
    tailVariants,
    warmups,
    measurements,
    includeNegativeControl,
    stream: hasFlag(args, "--stream"),
    run: hasFlag(args, "--run"),
    maxRequests: numberOption(args, "--max-requests", DEFAULT_MAX_REQUESTS, 1),
    maxObservedInputTokens: numberOption(args, "--max-observed-input-tokens", DEFAULT_MAX_OBSERVED_INPUT_TOKENS, 1),
    timeoutMs: numberOption(args, "--timeout-ms", DEFAULT_TIMEOUT_MS, 1),
    delayMs: numberOption(args, "--delay-ms", DEFAULT_DELAY_MS, 0),
    apiKey: process.env.PROMPT_CACHE_API_KEY ?? process.env.PROXY_API_KEY,
    outputPath: optionValue(args, "--output"),
    tokenizer,
    maxInputTokens: numberOption(args, "--max-input-tokens", DEFAULT_MAX_OBSERVED_INPUT_TOKENS, 1),
    upstreamEvidencePath: optionValue(args, "--upstream-evidence-file"),
    controlledRun: hasFlag(args, "--controlled-run"),
    rawUsageToken: process.env.CODEX_RAW_USAGE_OBSERVATION_TOKEN,
  };
  if (config.controlledRun) {
    if (!config.run) throw new Error("--controlled-run 必须同时传 --run");
    if (!runIdOption) throw new Error("controlled run requires explicit --run-id matching admin POST");
    if (config.format !== "messages") throw new Error("controlled run currently supports only --format messages");
    if (!config.rawUsageToken) throw new Error("controlled run requires CODEX_RAW_USAGE_OBSERVATION_TOKEN");
    if (!config.upstreamEvidencePath) throw new Error("--controlled-run 必须传 --upstream-evidence-file");
    if (config.maxInputTokens !== 22_500) throw new Error("controlled run requires --max-input-tokens=22500");
    if (config.maxRequests !== 9) throw new Error("controlled run requires --max-requests=9");
    if (config.maxObservedInputTokens > 22_500) throw new Error("controlled run max observed input must be <=22500");
    if (config.tailVariants.length < 2) throw new Error("controlled run requires at least two tail variants");
  }
  const cases = buildCases(config);
  if (config.controlledRun && cases.length !== 9) {
    throw new Error(`controlled run requires exactly 9 cases, got ${cases.length}`);
  }
  if (config.controlledRun && cases.some((item) => item.inputTokenLowerBound > 2_500)) {
    throw new Error("controlled run preflight exceeded per-attempt lower bound 2500 tokens");
  }
  if (cases.length > config.maxRequests) {
    throw new Error(`实验计划需要 ${cases.length} 个请求，超过 --max-requests=${config.maxRequests}`);
  }

  const plan = {
    type: "plan",
    run: config.run,
    format: config.format,
    stream: config.stream,
    model: config.model,
    runId: config.runId,
    baseUrl: config.baseUrl,
    prefixHash: config.prefixHash,
    prefixChars: config.prefix.length,
    prefixTokens: config.prefixTokens,
    routingKeyHash: hashText(config.routingKey),
    sessionIdHash: hashText(config.sessionId),
    tailVariantCount: config.tailVariants.length,
    warmups: config.warmups,
    measurements: config.measurements,
    includeNegativeControl: config.includeNegativeControl,
    plannedRequests: cases.length,
  };
  process.stdout.write(`${JSON.stringify(plan)}\n`);

  if (!config.run) return;

  const lines: string[] = [JSON.stringify(plan)];
  const records: RequestRecord[] = [];
  let plannedInputTokenLowerBound = 0;
  let observedInFlightOverrun = false;
  let budgetStoppedBeforeDispatch = false;
  let controlledStopReason: string | undefined;
  for (const experimentCase of cases) {
    if (plannedInputTokenLowerBound + experimentCase.inputTokenLowerBound > config.maxInputTokens) {
      budgetStoppedBeforeDispatch = true;
      break;
    }
    plannedInputTokenLowerBound += experimentCase.inputTokenLowerBound;
    const record = await runCase(config, experimentCase);
    records.push(record);
    if (config.controlledRun) {
      await mergeUpstreamEvidence(records, config.upstreamEvidencePath, config.format);
      const latest = records[records.length - 1];
      if (!latest.ok) controlledStopReason = "downstream_non_2xx";
      else if (latest.usage.evidenceSource !== "upstream") controlledStopReason = "missing_upstream_observation";
      else if (!latest.usage.rawUsageValid) controlledStopReason = "invalid_upstream_usage";
      else if (latest.usage.upstreamTerminalEvent !== "response.completed") controlledStopReason = "terminal_not_completed";
      else if (latest.upstreamEvidenceConflict || latest.upstreamEvidenceRejectReason) controlledStopReason = latest.upstreamEvidenceRejectReason ?? "evidence_conflict";
      if (controlledStopReason) break;
    }
    const observedInputTokens = records.reduce((sum, item) => sum + (item.usage.rawInputTokens ?? 0), 0);
    if (observedInputTokens > config.maxInputTokens || observedInputTokens > config.maxObservedInputTokens) {
      observedInFlightOverrun = true;
      break;
    }
    if (config.delayMs > 0 && experimentCase.index < cases.length) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }
  }

  await mergeUpstreamEvidence(records, config.upstreamEvidencePath, config.format);
  for (const record of records) {
    const safeRecord = publicRequestRecord(record);
    lines.push(JSON.stringify(safeRecord));
    process.stdout.write(`${JSON.stringify(safeRecord)}\n`);
  }
  const summary = summarize(config, records, plannedInputTokenLowerBound, budgetStoppedBeforeDispatch, observedInFlightOverrun, controlledStopReason);
  lines.push(JSON.stringify(summary));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (config.outputPath) {
    await writeFile(config.outputPath, `${lines.join("\n")}\n`, "utf8");
    process.stdout.write(`output_path=${config.outputPath}\n`);
  }
  if (controlledStopReason) {
    throw new Error(`controlled run stopped: ${controlledStopReason}`);
  }
  if (budgetStoppedBeforeDispatch) {
    throw new Error(`dispatch 前累计输入下界将超过 --max-input-tokens=${config.maxInputTokens}`);
  }
  if (observedInFlightOverrun) {
    throw new Error(`请求已在途，观测到的原始 input_tokens 超过预算上限=${config.maxInputTokens}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "实验驱动失败";
    process.stderr.write(`prompt-cache-driver: ${message}\n`);
    process.exitCode = 1;
  });
}
