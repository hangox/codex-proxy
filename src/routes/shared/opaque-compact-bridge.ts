import type { Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { CodexInputItem, CodexResponsesRequest } from "../../proxy/codex-types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import {
  buildClaudeCodeOpaqueCompactRequest,
  executeCompactOnly,
  opaqueCompactSemanticDigest,
} from "./codex-compact-service.js";
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
  // digest 必须算在**最终真正送上游的** compactRequest 上：preservedTail 合并与
  // predecessor 历史还原都会改写 input，早算等于给同一份内容算出不同 edge。
  const compactInputDigest = opaqueCompactSemanticDigest(compactRequest);
  const variantHash = opaqueCompactVariantHash(translated);

  // 账号候选集合：非 root 时 marker 已经把记录钉死在 requiredEntryId 上，
  // 只用它即可；root 还没有任何账号线索，必须拿本实例全部账号去试，否则
  // root edge 永远解不开、幂等回放形同虚设。
  const accountCandidates = previousMarker && requiredEntryId
    ? [requiredEntryId]
    : accountPool.getAllEntries().map((entry) => entry.id);

  // 崩溃恢复的幂等路径：上一次 compact 可能已经 COMMIT 成功，只是 marker 没送到
  // 客户端。此时客户端会拿着同样的输入重试——直接回放已经生成的 marker，
  // 不要再打一次上游。
  // 回放查询因此必须排在 digest 计算之后：edge 是内容寻址的
  // (session/model, predecessor-或-root, digest, account binding, authorization binding)，
  // 没有 digest 与当前 variant binding 就无法判定
  // "是同一次 compact 的重试"还是"同一 predecessor 上的另一条分叉"。
  // root（无 previousMarker）同样要查：首次 compact 的 post-commit 崩溃窗口
  // 与后续 compact 完全一样，跳过等于让首次 compact 裸奔。
  {
    // 这里**不吞**异常：已命中精确 edge 后的损坏或密钥不符必须冒泡成结构化
    // 409；其他账号/variant 因为 lookup 不同只会正常未命中，绝不会接触该行。
    const replayed = getOpaqueCompactStateStore().findSuccessorMarker({
      predecessorMarker: previousMarker ?? null,
      sessionId: clientConversationId,
      model: translated.model,
      compactInputDigest,
      variantHash,
      accountCandidates,
    });
    if (replayed !== null) {
      console.log(
        `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=successor_replay` +
          ` root=${previousMarker ? "0" : "1"}` +
          (requiredEntryId ? ` acct=${auditAccountTag(requiredEntryId)}` : ""),
      );
      return makeMarkerResponse(replayed, model);
    }
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
  // save 内部在一个事务里先查 edge 再 CAS：并发的 loser 会拿到 winner 的
  // marker（replayed=true），此时本次上游结果直接丢弃，响应 winner marker。
  // 这正是"相同 edge 单 COMMIT + loser 回放"的落点。
  const stored = getOpaqueCompactStateStore().save({
    output: compact.output,
    preservedTail,
    sessionId: clientConversationId,
    model: translated.model,
    accountEntryId: compact.entryId,
    variantHash,
    expectedGeneration: expectedGeneration ?? 0,
    predecessorStateId: previousStateId ?? null,
    compactInputDigest,
    // save 的 edge 精确绑定本次真正执行 compact 的账号；其他账号的同内容
    // root 请求必须各自提交 generation=1，不能复用本次 output。
    accountCandidates: Array.from(new Set([...accountCandidates, compact.entryId])),
  });
  // 审计日志用不可逆短标签，不落明文 entryId。
  console.log(
    `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=${stored.replayed ? "state_replayed" : "state_saved"}` +
      ` acct=${auditAccountTag(compact.entryId)}` +
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
