/**
 * Shared Codex SSE event data extraction layer.
 *
 * The three translation files (OpenAI, Anthropic, Gemini) all extract
 * the same data from Codex events — this module centralizes that logic.
 */

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
  if (evt.textDelta && evt.textDelta.length > 0) return true;
  if (evt.functionCallStart) return true;
  if (evt.functionCallDelta) return true;
  if (evt.functionCallDone) return true;
  if (options.includeReasoning && evt.reasoningDelta && evt.reasoningDelta.length > 0) return true;
  return false;
}

function isTerminalEvent(evt: ExtractedEvent): boolean {
  return evt.typed.type === "response.completed"
    || evt.typed.type === "response.failed"
    || evt.typed.type === "response.incomplete";
}

export async function preflightContentfulStream(
  source: CodexEventSource,
  options: ContentDetectionOptions = {},
): Promise<PreflightResult> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: ExtractedEvent[] = [];
  let terminalResponseId: string | null = null;
  let terminalUsage: UsageInfo | undefined;

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      throw new EmptyResponseError(terminalResponseId, terminalUsage);
    }

    const evt = next.value;
    buffered.push(evt);
    if (evt.responseId) terminalResponseId = evt.responseId;
    if (evt.usage) terminalUsage = evt.usage;

    if (isContentfulEvent(evt, options)) {
      async function* replay(): AsyncGenerator<ExtractedEvent> {
        yield* buffered;
        while (true) {
          const tail = await iterator.next();
          if (tail.done) return;
          yield tail.value;
        }
      }
      return { buffered, stream: replay() };
    }

    if (isTerminalEvent(evt)) {
      throw new EmptyResponseError(terminalResponseId, terminalUsage);
    }
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

      case "response.output_item.done":
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
