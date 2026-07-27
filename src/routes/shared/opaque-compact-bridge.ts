import type { Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { CodexInputItem, CodexResponsesRequest } from "../../proxy/codex-types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import { buildClaudeCodeOpaqueCompactRequest, executeCompactOnly } from "./codex-compact-service.js";
import {
  OpaqueCompactStateError,
  extractOpaqueCompactStateMarker,
  getOpaqueCompactStateStore,
  mergeOpaquePreservedTails,
  removeOpaquePreservedTailReplay,
  restoreOpaqueCompactInput,
} from "./opaque-compact-state.js";
import { computeVariantHash } from "./variant-hash.js";

/**
 * 计算 opaque state 的 variant 绑定。
 *
 * 必须与实际发往上游的请求形状一致，否则同一会话里主线程和子代理会共享同一
 * 条 state。之前生产链路没有传这个值（恒为 ""），variant 隔离只存在于单测中。
 */
export function opaqueCompactVariantHash(translated: CodexResponsesRequest): string {
  return computeVariantHash(translated.instructions, translated.tools);
}

function formatAnthropicSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeMarkerResponse(marker: string, model: string): Response {
  const messageId = "msg_opaque_compact_state";
  const body =
    formatAnthropicSse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }) +
    formatAnthropicSse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    formatAnthropicSse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: marker },
    }) +
    formatAnthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    formatAnthropicSse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 1 },
    }) +
    formatAnthropicSse("message_stop", { type: "message_stop" });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function respondWithOpaqueCompactMarker(options: {
  c: Context;
  accountPool: AccountPool;
  cookieJar?: CookieJar;
  proxyPool?: ProxyPool;
  req: AnthropicMessagesRequest;
  translated: CodexResponsesRequest;
  compactPrompt: string;
  clientConversationId: string;
  model: string;
  requestId: string;
  previousMarker?: string;
  previousOutput?: unknown[];
  previousPreservedTail?: CodexInputItem[];
  requiredEntryId?: string;
  /** 重复 compact 时 resolve 得到的 generation，用于 CAS；首次为 0。 */
  expectedGeneration?: number;
}): Promise<Response> {
  const {
    c,
    accountPool,
    cookieJar,
    proxyPool,
    req,
    translated,
    clientConversationId,
    model,
    requestId,
    previousMarker,
    previousOutput,
    previousPreservedTail,
    requiredEntryId,
    expectedGeneration,
  } = options;
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const started = Date.now();
  const opaqueRequest = buildClaudeCodeOpaqueCompactRequest(req, translated);
  const { compactRequest } = opaqueRequest;
  const preservedTail = mergeOpaquePreservedTails(
    previousPreservedTail ?? [],
    opaqueRequest.preservedTail,
  );
  if (previousMarker && previousOutput) {
    compactRequest.input = removeOpaquePreservedTailReplay(
      compactRequest.input,
      previousMarker,
      previousPreservedTail ?? [],
    );
    compactRequest.input = restoreOpaqueCompactInput(compactRequest.input, previousMarker, previousOutput);
  }
  const compact = await executeCompactOnly({
    accountPool,
    cookieJar,
    proxyPool,
    compactRequest,
    signal: abortController.signal,
    requestId,
    requiredEntryId,
  });
  if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
  // save() 内部在一个事务里完成 CAS + 落盘；只有它正常返回（COMMIT 成功）
  // 之后 marker 才会发给客户端，避免客户端拿到一个数据库里不存在的 marker。
  const stored = getOpaqueCompactStateStore().save({
    output: compact.output,
    preservedTail,
    sessionId: clientConversationId,
    model: translated.model,
    accountEntryId: compact.entryId,
    variantHash: opaqueCompactVariantHash(translated),
    expectedGeneration: expectedGeneration ?? 0,
  });
  console.log(
    `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=state_saved entry=${compact.entryId}` +
      ` output_items=${compact.output.length} preserved_items=${preservedTail.length}` +
      ` generation=${stored.generation} compact_ms=${compact.compactLatencyMs}` +
      ` total_ms=${Date.now() - started} marker_chars=${stored.marker.length}`,
  );
  return makeMarkerResponse(stored.marker, model);
}

export function restoreOpaqueCompactRequest(options: {
  req: AnthropicMessagesRequest;
  translated: CodexResponsesRequest;
  clientConversationId: string;
  requestId: string;
}): {
  restored: boolean;
  requiredEntryId?: string;
  marker?: string;
  output?: unknown[];
  preservedTail?: CodexInputItem[];
  generation?: number;
  error?: OpaqueCompactStateError;
} {
  const marker = extractOpaqueCompactStateMarker(options.req);
  if (!marker) return { restored: false };
  try {
    const state = getOpaqueCompactStateStore().resolve({
      marker,
      sessionId: options.clientConversationId,
      model: options.translated.model,
      variantHash: opaqueCompactVariantHash(options.translated),
    });
    options.translated.input = restoreOpaqueCompactInput(
      options.translated.input,
      marker,
      state.output,
      state.preservedTail,
    );
    console.log(
      `[ClaudeOpaqueCompact] rid=${options.requestId.slice(0, 8)} phase=state_restored` +
        ` entry=${state.accountEntryId} output_items=${state.output.length}` +
        ` preserved_items=${state.preservedTail.length} generation=${state.generation}`,
    );
    return {
      restored: true,
      requiredEntryId: state.accountEntryId,
      marker,
      output: state.output,
      preservedTail: state.preservedTail,
      generation: state.generation,
    };
  } catch (error) {
    const stateError = error instanceof OpaqueCompactStateError
      ? error
      : new OpaqueCompactStateError("invalid_marker");
    console.warn(
      `[ClaudeOpaqueCompact] rid=${options.requestId.slice(0, 8)} phase=state_rejected reason=${stateError.reason}`,
    );
    return { restored: false, marker, error: stateError };
  }
}
