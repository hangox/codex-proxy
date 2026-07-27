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
import { auditAccountTag } from "./opaque-compact-audit.js";

/**
 * 计算 opaque state 的 variant 绑定。
 *
 * 目标：区分同一 session 下并行的真实 variant（主线程 vs 子代理 vs 不同
 * Codex 窗口），避免它们在 store 里碰撞、互相覆盖或引发 CAS 冲突。
 *
 * 与代理链路 `buildVariantIdentity` 的差别 —— 这里**刻意**不包含 derived
 * conversation anchor：
 *
 *   anchor = hash(model, instructions, 第一条用户消息)
 *
 * 而 opaque compact 的全部意义就是把历史换成一个 marker，第一条用户消息
 * 因此必然改变。把 anchor 纳入绑定，等于让 save 与 restore 永远算出不同的
 * hash，restore 一律 variant_mismatch —— 即"绑定跨越了它本该跨越的边界"。
 * 已用探针验证：同一会话 compact 前后 anchor 必然不同。
 *
 * 保留的是 `codexWindowId`：它由客户端窗口决定，跨 compact 稳定，正是需要
 * 隔离的并行维度。instructions/tools 仍参与，子代理因此与主线程分离。
 */
export function opaqueCompactVariantHash(translated: CodexResponsesRequest): string {
  const windowId = translated.codexWindowId?.trim();
  const variantIdentity = windowId ? `window:${windowId}` : null;
  return computeVariantHash(translated.instructions, translated.tools, variantIdentity);
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
  /** predecessor 的 stateId，用于建立 successor 映射支撑幂等重试。 */
  previousStateId?: string;
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
    previousStateId,
  } = options;
  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const started = Date.now();

  // 崩溃恢复的幂等路径：上一次 compact 可能已经 COMMIT 成功，只是 marker 没送到
  // 客户端。此时客户端会拿着 predecessor marker 重试——直接回放已经生成的
  // successor marker，不要再打一次上游。
  if (previousMarker && requiredEntryId) {
    // 这里**不吞**异常：损坏/密钥不符/账号不符都必须冒泡成结构化 409，
    // 否则会退化成"重打一次上游"，随后撞上 stale_generation 并掩盖真实原因。
    const replayed = getOpaqueCompactStateStore().findSuccessorMarker(previousMarker, requiredEntryId);
    if (replayed !== null) {
      console.log(
        `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=successor_replay` +
          ` acct=${auditAccountTag(requiredEntryId)}`,
      );
      return makeMarkerResponse(replayed, model);
    }
  }

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
    predecessorStateId: previousStateId ?? null,
  });
  // 审计日志用不可逆短标签，不落明文 entryId。
  console.log(
    `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=state_saved acct=${auditAccountTag(compact.entryId)}` +
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
  /** 本实例已知的账号 entryId 集合；数据密钥按账号派生，解封必需。 */
  accountCandidates: readonly string[];
}): {
  restored: boolean;
  requiredEntryId?: string;
  marker?: string;
  stateId?: string;
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
      accountCandidates: options.accountCandidates,
    });
    options.translated.input = restoreOpaqueCompactInput(
      options.translated.input,
      marker,
      state.output,
      state.preservedTail,
    );
    console.log(
      `[ClaudeOpaqueCompact] rid=${options.requestId.slice(0, 8)} phase=state_restored` +
        ` acct=${auditAccountTag(state.accountEntryId)} output_items=${state.output.length}` +
        ` preserved_items=${state.preservedTail.length} generation=${state.generation}`,
    );
    return {
      restored: true,
      requiredEntryId: state.accountEntryId,
      marker,
      stateId: state.stateId,
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
