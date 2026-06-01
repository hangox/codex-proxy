/**
 * Shared Codex SSE event data extraction layer.
 *
 * The three translation files (OpenAI, Anthropic, Gemini) all extract
 * the same data from Codex events — this module centralizes that logic.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDataDir } from "../paths.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type { CodexSSEEvent } from "../proxy/codex-api.js";
import {
  parseCodexEvent,
  type TypedCodexEvent,
} from "../types/codex-events.js";

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  /** Tokens billed by the image_generation tool (gpt-image-2). Separate from host-model usage. */
  image_input_tokens?: number;
  image_output_tokens?: number;
  /** Set by the route handler when the request declared the image_generation tool.
   *  Drives the success/failure split in `recordUsage`. */
  image_request_attempted?: boolean;
  image_request_succeeded?: boolean;
}

export interface FunctionCallStart {
  callId: string;
  name: string;
  outputIndex: number;
}

export interface FunctionCallDelta {
  callId: string;
  delta: string;
}

export interface FunctionCallDone {
  callId: string;
  name: string;
  arguments: string;
}

export class EmptyResponseError extends Error {
  constructor(
    public readonly responseId: string | null,
    public readonly usage: UsageInfo | undefined,
  ) {
    super("Codex returned an empty response");
    this.name = "EmptyResponseError";
  }
}

/**
 * Upstream closed the SSE stream without sending `response.completed`,
 * `response.failed`, or an `error` event. Observed when gpt-5.5 with
 * `effort=xhigh` spends > 120 s in reasoning_summary before producing any
 * output_text — the Codex backend caps total response duration and silently
 * FINs the connection.
 *
 * Treated separately from EmptyResponseError because cross-account retry is
 * useless (same workload re-hits the same cap on the next account) and just
 * burns the pool. The proxy surfaces 504 to the client instead.
 */
export class UpstreamPrematureCloseError extends Error {
  constructor(
    public readonly responseId: string | null,
    public readonly hadReasoning: boolean,
    public readonly eventCount: number,
  ) {
    super(
      hadReasoning
        ? "Upstream closed stream after reasoning without producing output (likely hit response-duration cap)"
        : "Upstream closed stream without a terminal event",
    );
    this.name = "UpstreamPrematureCloseError";
  }
}

export interface ExtractedEvent {
  /** Original SSE event name + payload — required for passthrough routes (/v1/responses)
   *  that re-emit raw events to clients. Translation routes can ignore this. */
  raw: CodexSSEEvent;
  typed: TypedCodexEvent;
  responseId?: string;
  textDelta?: string;
  reasoningDelta?: string;
  usage?: UsageInfo;
  error?: { code: string; message: string };
  functionCallStart?: FunctionCallStart;
  functionCallDelta?: FunctionCallDelta;
  functionCallDone?: FunctionCallDone;
}

export type CodexEventSource = AsyncIterable<ExtractedEvent>;

export interface PreflightResult {
  buffered: ExtractedEvent[];
  stream: AsyncGenerator<ExtractedEvent>;
}

export interface ContentDetectionOptions {
  includeReasoning?: boolean;
}

export function isContentfulEvent(
  evt: ExtractedEvent,
  options: ContentDetectionOptions = {},
): boolean {
  if (evt.error) return true;
  if (evt.textDelta && evt.textDelta.length > 0) return true;
  if (evt.functionCallStart) return true;
  if (evt.functionCallDelta) return true;
  if (evt.functionCallDone) return true;
  if (options.includeReasoning && evt.reasoningDelta && evt.reasoningDelta.length > 0) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextFromContentParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type !== "output_text" && part.type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function extractTextFromOutputItem(item: unknown): string {
  if (!isRecord(item)) return "";
  if (item.type !== "message") return "";
  return extractTextFromContentParts(item.content);
}

function extractTextFromCompletedResponse(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.response)) return "";
  if (typeof data.response.output_text === "string" && data.response.output_text.length > 0) {
    return data.response.output_text;
  }
  if (!Array.isArray(data.response.output)) return "";
  return data.response.output.map(extractTextFromOutputItem).join("");
}

function isTerminalEvent(evt: ExtractedEvent): boolean {
  return evt.typed.type === "response.completed"
    || evt.typed.type === "response.failed"
    || evt.typed.type === "response.incomplete";
}

type EmptyResponseDumpKind = "event" | "iterator_done" | "terminal_no_content";
type EmptyResponseDumpRow = {
  ts: string;
  event: string | null;
  data: unknown;
  kind: EmptyResponseDumpKind;
};

const EMPTY_RESPONSE_DUMP_MAX_ROWS = 200;
const EMPTY_RESPONSE_DUMP_MAX_FILES_PER_DAY = 1000;

function isEmptyResponseDumpEnabled(): boolean {
  return process.env.DEBUG_DUMP_EMPTY_RESPONSE === "1";
}

function emptyResponseDumpRoot(): string {
  return process.env.DEBUG_DUMP_EMPTY_RESPONSE_DIR || resolve(getDataDir(), "empty-response-dumps");
}

function todayDumpDir(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function safeDumpResponseId(responseId: string | null): string {
  return (responseId || "unknown-rid").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown-rid";
}

async function pruneOldEmptyResponseDumps(dayDir: string): Promise<void> {
  const entries = await readdir(dayDir, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => {
      const path = join(dayDir, entry.name);
      const stats = await stat(path);
      return { path, mtimeMs: stats.mtimeMs };
    }));

  const overflow = files.length - (EMPTY_RESPONSE_DUMP_MAX_FILES_PER_DAY - 1);
  if (overflow <= 0) return;

  const victims = files
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, overflow);
  await Promise.all(victims.map((file) => unlink(file.path).catch(() => undefined)));
}

async function dumpEmptyResponseStream(
  buffered: ExtractedEvent[],
  terminalKind: Exclude<EmptyResponseDumpKind, "event">,
  responseId: string | null,
): Promise<void> {
  if (!isEmptyResponseDumpEnabled()) return;

  try {
    const now = new Date();
    const dayDir = join(emptyResponseDumpRoot(), todayDumpDir(now));
    await mkdir(dayDir, { recursive: true });
    await pruneOldEmptyResponseDumps(dayDir);

    const eventRows: EmptyResponseDumpRow[] = buffered.map((evt, index) => ({
      ts: new Date(now.getTime() + index).toISOString(),
      event: evt.raw.event,
      data: evt.raw.data,
      kind: "event",
    }));
    const rows: EmptyResponseDumpRow[] = [
      ...eventRows,
      {
        ts: new Date(now.getTime() + eventRows.length).toISOString(),
        event: null,
        data: null,
        kind: terminalKind,
      },
    ].slice(-EMPTY_RESPONSE_DUMP_MAX_ROWS);

    if (terminalKind === "terminal_no_content" && rows.length > 1) {
      rows[rows.length - 2] = { ...rows[rows.length - 2], kind: terminalKind };
      rows.pop();
    }

    const fileName = `${safeDumpResponseId(responseId)}-${Math.floor(now.getTime() / 1000)}.jsonl`;
    await writeFile(join(dayDir, fileName), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  } catch (err) {
    console.warn("[CodexEvents] Failed to dump empty upstream response", err);
  }
}

export async function preflightContentfulStream(
  source: CodexEventSource,
  options: ContentDetectionOptions = {},
): Promise<PreflightResult> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: ExtractedEvent[] = [];
  let terminalResponseId: string | null = null;
  let terminalUsage: UsageInfo | undefined;

  // Best-effort iterator close. Backed by the SSE reader's lock, so leaking
  // it pins the upstream Response body — call this on every exit path that
  // doesn't hand the iterator off to `replay`.
  async function closeIterator(): Promise<void> {
    try { await iterator.return?.(); } catch { /* swallow */ }
  }

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        await closeIterator();
        await dumpEmptyResponseStream(buffered, "iterator_done", terminalResponseId);
        throw new EmptyResponseError(terminalResponseId, terminalUsage);
      }

      const evt = next.value;
      buffered.push(evt);
      if (evt.responseId) terminalResponseId = evt.responseId;
      if (evt.usage) terminalUsage = evt.usage;

      if (isContentfulEvent(evt, options)) {
        // Hand the iterator off to replay; it's responsible for closing.
        async function* replay(): AsyncGenerator<ExtractedEvent> {
          try {
            yield* buffered;
            while (true) {
              const tail = await iterator.next();
              if (tail.done) return;
              yield tail.value;
            }
          } finally {
            await closeIterator();
          }
        }
        return { buffered, stream: replay() };
      }

      if (isTerminalEvent(evt)) {
        await closeIterator();
        await dumpEmptyResponseStream(buffered, "terminal_no_content", terminalResponseId);
        throw new EmptyResponseError(terminalResponseId, terminalUsage);
      }
    }
  } catch (err) {
    if (!(err instanceof EmptyResponseError)) {
      // Unexpected error before we hand the iterator to replay — make sure
      // the upstream reader is released regardless of how we exit.
      await closeIterator();
    }
    throw err;
  }
}

/**
 * Iterate over a Codex SSE stream, parsing + extracting common fields.
 * Yields ExtractedEvent with pre-extracted responseId, textDelta, and usage.
 */
export async function* iterateCodexEvents(
  api: UpstreamAdapter,
  rawResponse: Response,
): AsyncGenerator<ExtractedEvent> {
  // Map item_id → { call_id, name } for resolving delta/done events
  const itemIdToCallInfo = new Map<string, { callId: string; name: string }>();
  let emittedText = false;

  for await (const raw of api.parseStream(rawResponse)) {
    const typed = parseCodexEvent(raw);
    const extracted: ExtractedEvent = { raw, typed };

    // Log unrecognized events to discover new Codex event types
    if (typed.type === "unknown") {
      console.debug(`[CodexEvents] Unknown event: ${raw.event}`, JSON.stringify(raw.data).slice(0, 300));
    }

    switch (typed.type) {
      case "response.created":
      case "response.in_progress":
        if (typed.response.id) extracted.responseId = typed.response.id;
        break;

      case "response.output_text.delta":
        extracted.textDelta = typed.delta;
        if (typed.delta.length > 0) emittedText = true;
        break;

      case "response.output_text.done":
        if (!emittedText && typed.text.length > 0) {
          extracted.textDelta = typed.text;
          emittedText = true;
        }
        break;

      case "response.reasoning_summary_text.delta":
        extracted.reasoningDelta = typed.delta;
        break;

      case "response.output_item.added":
        if (typed.item.type === "function_call" && typed.item.call_id && typed.item.name) {
          // Register item_id → call_id mapping
          itemIdToCallInfo.set(typed.item.id, {
            callId: typed.item.call_id,
            name: typed.item.name,
          });
          extracted.functionCallStart = {
            callId: typed.item.call_id,
            name: typed.item.name,
            outputIndex: typed.outputIndex,
          };
        }
        break;

      case "response.function_call_arguments.delta": {
        // Resolve item_id to call_id if needed
        const deltaInfo = itemIdToCallInfo.get(typed.call_id);
        extracted.functionCallDelta = {
          callId: deltaInfo?.callId ?? typed.call_id,
          delta: typed.delta,
        };
        break;
      }

      case "response.function_call_arguments.done": {
        // Resolve item_id to call_id + name if needed
        const doneInfo = itemIdToCallInfo.get(typed.call_id);
        extracted.functionCallDone = {
          callId: doneInfo?.callId ?? typed.call_id,
          name: typed.name || doneInfo?.name || "",
          arguments: typed.arguments,
        };
        break;
      }

      case "response.output_item.done": {
        if (!emittedText) {
          const text = extractTextFromOutputItem(typed.item);
          if (text.length > 0) {
            extracted.textDelta = text;
            emittedText = true;
          }
        }
        break;
      }
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.annotation.added":
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed":
        // Lifecycle markers — no data extraction needed
        break;

      case "response.incomplete":
        // Response was truncated/incomplete
        if (typed.response.id) extracted.responseId = typed.response.id;
        if (typed.response.usage) extracted.usage = typed.response.usage;
        break;

      case "response.queued":
        // Response is queued for processing
        if (typed.response.id) extracted.responseId = typed.response.id;
        break;

      case "response.completed":
        if (typed.response.id) extracted.responseId = typed.response.id;
        if (typed.response.usage) extracted.usage = typed.response.usage;
        if (!emittedText) {
          const text = extractTextFromCompletedResponse(raw.data);
          if (text.length > 0) {
            extracted.textDelta = text;
            emittedText = true;
          }
        }
        break;

      case "error":
        extracted.error = { code: typed.error.code, message: typed.error.message };
        break;

      case "response.failed":
        extracted.error = { code: typed.error.code, message: typed.error.message };
        if (typed.response.id) extracted.responseId = typed.response.id;
        break;
    }

    yield extracted;
  }
}
