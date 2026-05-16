/**
 * Translate Codex Responses API SSE stream → Google Gemini API format.
 *
 * Codex SSE events:
 *   response.created → extract response ID
 *   response.output_text.delta → streaming candidate with text part
 *   response.completed → final candidate with finishReason + usageMetadata
 *
 * Non-streaming: collect all text, return Gemini generateContent response.
 */

import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type {
  GeminiGenerateContentResponse,
  GeminiUsageMetadata,
  GeminiPart,
} from "../types/gemini.js";
import {
  iterateCodexEvents,
  EmptyResponseError,
  type UsageInfo,
  type ExtractedEvent,
} from "./codex-event-extractor.js";
import { reconvertTupleValues } from "./tuple-schema.js";
import { codexApiErrorFromEvent } from "./codex-api-error-from-event.js";

/**
 * Stream Codex Responses API events as Gemini SSE.
 * Yields string chunks ready to write to the HTTP response.
 */
export async function* streamCodexToGemini(
  codexApi: UpstreamAdapter,
  rawResponse: Response | AsyncIterable<ExtractedEvent>,
  model: string,
  onUsage?: (usage: UsageInfo) => void,
  onResponseId?: (id: string) => void,
  tupleSchema?: Record<string, unknown> | null,
  onResponseCompleted?: (id?: string) => void,
): AsyncGenerator<string> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let hasContent = false;
  let sawTerminalFailure = false;
  let lastResponseId: string | null = null;
  let lastUsage: UsageInfo | undefined;
  let tupleTextBuffer = tupleSchema ? "" : null;

  const eventSource = rawResponse instanceof Response
    ? iterateCodexEvents(codexApi, rawResponse)
    : rawResponse;

  for await (const evt of eventSource) {
    if (evt.responseId) {
      lastResponseId = evt.responseId;
      onResponseId?.(evt.responseId);
    }
    if (evt.usage) lastUsage = evt.usage;

    // Handle upstream error events
    if (evt.error) {
      throw codexApiErrorFromEvent(evt.error);
    }

    // Function call done → emit as a candidate with functionCall part
    if (evt.functionCallDone) {
      hasContent = true;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty args */ }
      const fcChunk: GeminiGenerateContentResponse = {
        candidates: [
          {
            content: {
              parts: [{
                functionCall: {
                  name: evt.functionCallDone.name,
                  args,
                },
              }],
              role: "model",
            },
            index: 0,
          },
        ],
        modelVersion: model,
      };
      yield `data: ${JSON.stringify(fcChunk)}\n\n`;
      continue;
    }

    switch (evt.typed.type) {
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.output_item.done": {
        if (evt.textDelta) {
          hasContent = true;
          if (tupleTextBuffer !== null) {
            tupleTextBuffer += evt.textDelta;
          } else {
            const chunk: GeminiGenerateContentResponse = {
              candidates: [
                {
                  content: {
                    parts: [{ text: evt.textDelta }],
                    role: "model",
                  },
                  index: 0,
                },
              ],
              modelVersion: model,
            };
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          }
        }
        break;
      }

      case "response.completed": {
        if (evt.textDelta) {
          hasContent = true;
          if (tupleTextBuffer !== null) {
            tupleTextBuffer += evt.textDelta;
          } else {
            const chunk: GeminiGenerateContentResponse = {
              candidates: [
                {
                  content: {
                    parts: [{ text: evt.textDelta }],
                    role: "model",
                  },
                  index: 0,
                },
              ],
              modelVersion: model,
            };
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          }
        }
        // Flush buffered tuple text as reconverted JSON
        if (tupleTextBuffer !== null && tupleSchema && tupleTextBuffer) {
          let text = tupleTextBuffer;
          try {
            const parsed = JSON.parse(tupleTextBuffer) as unknown;
            text = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
          } catch (e) { console.warn("[tuple-reconvert] streaming JSON parse failed, emitting raw text:", e); }
          const tupleChunk: GeminiGenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [{ text }],
                  role: "model",
                },
                index: 0,
              },
            ],
            modelVersion: model,
          };
          yield `data: ${JSON.stringify(tupleChunk)}\n\n`;
        }
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens;
          outputTokens = evt.usage.output_tokens;
          cachedTokens = evt.usage.cached_tokens;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, reasoning_tokens: evt.usage.reasoning_tokens });
        }
        onResponseCompleted?.(evt.responseId);

        // Final chunk with finishReason and usage
        const finalChunk: GeminiGenerateContentResponse = {
          candidates: [
            {
              content: {
                parts: [{ text: "" }],
                role: "model",
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: inputTokens,
            candidatesTokenCount: outputTokens,
            totalTokenCount: inputTokens + outputTokens,
            ...(cachedTokens != null ? { cachedContentTokenCount: cachedTokens } : {}),
          },
          modelVersion: model,
        };
        yield `data: ${JSON.stringify(finalChunk)}\n\n`;
        break;
      }

      case "response.failed":
      case "response.incomplete": {
        sawTerminalFailure = true;
        if (hasContent) {
          console.warn(`[codex-to-gemini] partial stream terminated responseId=${lastResponseId ?? "?"} usage=${JSON.stringify(lastUsage ?? null)} terminal=${evt.typed.type}`);
          const incompleteChunk: GeminiGenerateContentResponse = {
            candidates: [
              {
                content: {
                  parts: [{ text: "[Error] Codex returned an incomplete response. Please retry." }],
                  role: "model",
                },
                finishReason: "OTHER",
                index: 0,
              },
            ],
            modelVersion: model,
          };
          yield `data: ${JSON.stringify(incompleteChunk)}\n\n`;
        }
        break;
      }
    }
  }
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * Gemini generateContent response.
 */
export async function collectCodexToGeminiResponse(
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  tupleSchema?: Record<string, unknown> | null,
): Promise<{
  response: GeminiGenerateContentResponse;
  usage: UsageInfo;
  responseId: string | null;
}> {
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let responseId: string | null = null;
  const functionCallParts: GeminiPart[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.error) {
      throw codexApiErrorFromEvent(evt.error);
    }
    if (evt.textDelta) fullText += evt.textDelta;
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
      cachedTokens = evt.usage.cached_tokens;
    }
    if (evt.functionCallDone) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty args */ }
      functionCallParts.push({
        functionCall: { name: evt.functionCallDone.name, args },
      });
    }
  }

  const usage: UsageInfo = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedTokens != null ? { cached_tokens: cachedTokens } : {}),
  };

  const usageMetadata: GeminiUsageMetadata = {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
    ...(cachedTokens != null ? { cachedContentTokenCount: cachedTokens } : {}),
  };

  // Detect empty response (HTTP 200 but no content)
  if (!fullText && functionCallParts.length === 0 && outputTokens === 0) {
    throw new EmptyResponseError(responseId, { input_tokens: inputTokens, output_tokens: outputTokens });
  }

  // Reconvert tuple objects back to arrays
  if (tupleSchema && fullText) {
    try {
      const parsed = JSON.parse(fullText) as unknown;
      fullText = JSON.stringify(reconvertTupleValues(parsed, tupleSchema));
    } catch (e) { console.warn("[tuple-reconvert] collect JSON parse failed, passing through:", e); }
  }

  // Build response parts: text + function calls
  const parts: GeminiPart[] = [];
  if (fullText) {
    parts.push({ text: fullText });
  }
  parts.push(...functionCallParts);
  if (parts.length === 0) {
    parts.push({ text: "" });
  }

  return {
    response: {
      candidates: [
        {
          content: {
            parts,
            role: "model",
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata,
      modelVersion: model,
    },
    usage,
    responseId,
  };
}
