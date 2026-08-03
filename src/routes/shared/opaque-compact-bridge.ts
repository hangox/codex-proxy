import type { Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { CodexInputItem, CodexResponsesRequest } from "../../proxy/codex-types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import {
  buildClaudeCodeOpaqueCompactRequest,
  CompactServiceError,
  executeCompactOnly,
  opaqueCompactSemanticDigest,
  planCompactRequestForBudget,
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
import { recordCompactOutcome } from "./compact-outcome-log.js";

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
 * 隔离的并行维度。
 *
 * ★★ `instructions` 不再参与这个 hash（团队裁决，三条证据链） ★★
 *
 * 1. **Codex 原生对照**：Codex 自己的 compact 端点是纯无状态转换——不返回
 *    token，压缩结果由本地进程直接持有；唯一跨请求的世代标识是
 *    `format!("{thread_id}:{window_number}")`，只有 thread_id + 单调计数器，
 *    不含任何运行时内容的哈希。这不是巧合，是设计哲学：绑定标识必须挑
 *    "跨越 compact 边界仍然稳定"的量，不能挑"compact 会改变"的量。
 * 2. **subagent 与 main 共享 session id，不能靠 session 层区分**：
 *    `variant-hash.ts` 的设计文档、`d88fa23` 的 PR 问题陈述、
 *    `session-affinity.ts` 的接口文档三处独立原始证据，加上 qa 本轮实测
 *    （7 条请求 session id 哈希全程一致）——三条证据链都指向同一个结论，
 *    所以 variant 层不能整层拿掉，必须留一个能分辨 main/subagent 的维度。
 * 3. **`instructions` 是唯一的真实故障源**：qa 实测 compact 前连续 5 次
 *    请求 instructions 逐字节相同（22344 字符），compact 成功后的下一次
 *    请求立刻掉到 16472——而 tools 在整个过程里保持不变（39 个）。也就是说
 *    "compact 会改变 instructions"这件事本身就注定了 instructions 不能待
 *    在跨 compact 边界的绑定里，任何一次真实的 compact 后续对话都会踩上
 *    这条分支，不是边角场景。
 *
 * 因此：只留 `tools`（+ `codexWindowId`）参与，`instructions` 从这个包装
 * 函数的调用参数里去掉。★ 红线：`computeVariantHash` 本身（`variant-hash.ts`）
 * 一个字不动——它是 `session-affinity.ts` 用于 WS 连接池 slot 与
 * `prev_response_id` 链隔离的共用函数，有生产数据支撑
 * （`previous_response_not_found` 35/天→0），这里只改这个 opaque 专用包装
 * 函数传给它的参数，不碰函数本身。
 *
 * ★ 过渡期影响（发布说明必须写）：改公式后，库里已存的 state 是按旧公式
 * （含 instructions）算出的指纹，新公式（不含 instructions）对不上，会让
 * 存量记录集中触发一轮 `variant_mismatch`，直到它们自然过期（最长一个
 * TTL 窗口，当前默认 720 分钟）。这不影响解密——AEAD 用的是落盘时已经
 * 算好的 `row.binding`，不会重算，所以旧记录不会解密失败，只是这一轮内
 * variant 比对不上，按族 B（`isOpaqueCompactMarkerBindingMismatch`）处理，
 * 忽略 marker、继续正常对话，不是 409。
 *
 * ★ 已知但不影响本次判断的待定项，且这是"pending main/subagent 隔离能否
 * 真正生效"的整层疑点，不只是 tools 一个字段的疑点：
 *
 * qa 当天累计做了三轮独立实验、34 条请求、跨两个独立真实会话、三种触发
 * 方式（普通子代理任务、要求 subagent 做真实文件读写而非纯算术、尝试
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0` 逼出裸 Task 子代理路径——该
 * 环境变量实测没有生效，所以这条路径未能触达），session id / instructions
 * / tools 三个维度**从未观测到 main 与 subagent 之间的任何指纹分裂**：
 * session id 哈希全程一致（这条是三条证据链里"variant 层不能整层拿掉"的
 * 依据，仍然成立），但 instructions 和 tools 这两个此前预期能分开
 * main/subagent 的维度，这次也全程一致（tools 均为 39 个）。qa 原话：
 * "variant 层能提供的隔离价值可能非常有限"。★ 限定条件（不要只挑支持
 * 结论的部分）：qa 未能确认这次触达的 Teammate 机制是否与更早那份证据
 * （"主线程 27 工具 vs 子代理 19 工具"）里的裸 Task 子代理是同一条代码
 * 路径——如果是两条不同路径，裸 Task 子代理是否仍然分裂，仍然未知。
 *
 * ★ 这不改变这次改动的正确性判断，但下面这条推理需要修正一处归因：
 * "保留 tools 不比现状更差"这个理由，如果说成"现状下 variant 本来就每次
 * 都失配"，那只在**紧邻 compact 边界的那一刻**成立——不是普遍事实。更准确
 * 的因果链是：如果 main 与 subagent 的 instructions/tools 真的像 qa 数据
 * 显示的那样全程相同，那么在 compact 边界之外的其余所有时刻，旧公式
 * （含 instructions）**同样会**把 main/subagent 的 hash 算成同一个值——
 * 也就是说"variant 层从未真正区分开 main 和 subagent"很可能不是这次改动
 * 造成的新状态，而是这次事故之前就一直存在、只是从未被专门验证过的旧
 * 状态。结论不变（去掉 instructions 一定能修好"compact 后第一句话必然
 * variant_mismatch"这个真实故障，这次改动是净改善，不是这次引入的新
 * 风险），但"不比现状更差"不能归因成"反正本来就一直在失配"——那只是
 * compact 那一刻的巧合，不是全程的因果。tools 是否还有隔离价值，是"整层
 * 是否还有存在意义"的后续议题，不是现在。
 */
export function opaqueCompactVariantHash(translated: CodexResponsesRequest): string {
  const windowId = translated.codexWindowId?.trim();
  const variantIdentity = windowId ? `window:${windowId}` : null;
  return computeVariantHash(null, translated.tools, variantIdentity);
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

  // ★ 8.7 · 发上游前的预算校验（task #25），必须排在这里——digest 计算之前、
  // 且在上面 preservedTail/predecessor 历史还原之后。生产实测 472 次 compact
  // 尝试 440 次失败，100% 是上游 400 "Prompt is too long"：这条调用注定失败
  // 时，与其真的打一次上游拿 400 再降级，不如先估算体积、判定"裁不动"就
  // 直接跳过上游调用，省一次真实网络往返和一次账号租约（`executeCompactOnly`
  // 从未被调用，不占账号池）。
  //
  // 排序原因（不能挪到 digest 计算之后）：裁剪会原地改写 `compactRequest.input`，
  // 而下面紧跟着的 digest 计算、回放查询、`executeCompactOnly` 三处全部依赖
  // "compactRequest.input 就是最终真正送上游的那份内容"这个不变量（见下面
  // digest 注释）。如果先算 digest 再裁剪，digest 描述的内容和真正送上游的
  // 内容就对不上——同一个 edge 会同时代表两份不同的密文语义，content-addressed
  // 幂等回放的前提被破坏。裁剪必须在任何"这次到底发了什么"被记录下来之前
  // 完成。
  //
  // 这里不是唯一防线——如果这次估算本身有误差（比如型号预算表还没校准过
  // 这个型号，或者字节→token 换算在某种内容形态上失真），真正打上游后仍然
  // 可能收到 400；那种情况由 `messages.ts` 里对 `isPromptTooLongLike` 的
  // 判断兜底，走同一条降级路径，不会 409。这里的预判是"提前拦"，不是
  // "唯一拦"。
  // ★ 8.11：planCompactRequestForBudget 现在可能懒加载分词器（粗筛怀疑
  // 超限时），异步——见该函数文档"两级估算"部分。
  const budgetPlan = await planCompactRequestForBudget(compactRequest);
  if (budgetPlan.trimmedCount > 0) {
    compactRequest.input = budgetPlan.compactRequest.input;
    console.warn(
      `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=compact_trim` +
        ` trimmed=${budgetPlan.trimmedCount} estimated_tokens=${budgetPlan.estimatedTokens}` +
        ` budget_tokens=${budgetPlan.budgetTokens} within_budget=${budgetPlan.withinBudget}` +
        ` estimate_source=${budgetPlan.estimateSource} cheap_estimate_tokens=${budgetPlan.cheapEstimateTokens}`,
    );
  }
  if (!budgetPlan.withinBudget) {
    console.warn(
      `[ClaudeOpaqueCompact] rid=${requestId.slice(0, 8)} phase=compact_budget_exceeded` +
        ` model=${translated.model} estimated_tokens=${budgetPlan.estimatedTokens}` +
        ` budget_tokens=${budgetPlan.budgetTokens} trimmed=${budgetPlan.trimmedCount}` +
        ` estimate_source=${budgetPlan.estimateSource} cheap_estimate_tokens=${budgetPlan.cheapEstimateTokens}` +
        (budgetPlan.processedFraction !== undefined ? ` processed_fraction=${budgetPlan.processedFraction.toFixed(3)}` : ""),
    );
    // 消息里仍然保留 "exceeds the context window"——旧调用方/日志里靠这句
    // 文本识别的路径继续有效，不做破坏性变更。★ 8.10：`messages.ts` 判断
    // 要不要跳过 409 不再需要解析这句话——`skippedUpstream`/`promptTooLong`
    // 是结构化字段，直接读，见 CompactServiceError 类定义处的说明。
    // status 400、retryCount 0：从未联系上游、从未占用账号，如实反映。
    throw new CompactServiceError(
      `Estimated compact input (~${budgetPlan.estimatedTokens} tokens) exceeds the context window ` +
        `budget (~${budgetPlan.budgetTokens} tokens) for model ${translated.model}; skipping upstream ` +
        "compact call.",
      400,
      false,
      0,
      {
        skippedUpstream: true,
        promptTooLong: true,
        estimatedTokens: budgetPlan.estimatedTokens,
        budgetTokens: budgetPlan.budgetTokens,
        // ★ #97：见 CompactServiceErrorClassification 里这三个字段各自的
        // 文档——半截版本（只传 estimateSource 不传 processedFraction，
        // 或者不传 cheapEstimateTokens）会让这条记录失去"判断可信度"的
        // 能力，team-lead 明确要求整条链路一起接，不留半截。
        estimateSource: budgetPlan.estimateSource,
        processedFraction: budgetPlan.processedFraction,
        cheapEstimateTokens: budgetPlan.cheapEstimateTokens,
        // ★ #88：从未联系上游，这个耗时纯粹是 restore/preservedTail 合并/
        // 预算预判本身的开销——理应是毫秒级，如果这里也慢了说明瓶颈根本
        // 不在上游。
        durationMs: Date.now() - started,
      },
    );
  }

  // digest 必须算在**最终真正送上游的** compactRequest 上：preservedTail 合并、
  // predecessor 历史还原、以及上面的预算裁剪都会改写 input，早算等于给同一份
  // 内容算出不同 edge。
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
      // ★ 8.10：用户视角这是"压缩成功了"——幂等短路是内部实现细节，不该
      // 体现在成功率上，但 replayed:true 保留区分，供以后单独统计幂等命中率。
      recordCompactOutcome({
        requestId,
        clientConversationId,
        model: translated.model,
        outcome: "success",
        replayed: true,
        // ★ #88：这条路径没有真正联系上游（edge 命中直接回放），只有总耗时，
        // 没有 upstreamMs——理应是毫秒级的 DB 查找，耗时异常本身就是线索
        // （比如锁竞争）。
        durationMs: Date.now() - started,
      });
      return makeMarkerResponse(replayed, model);
    }
  }

  let compact: Awaited<ReturnType<typeof executeCompactOnly>>;
  try {
    compact = await executeCompactOnly({
      accountPool,
      cookieJar,
      proxyPool,
      compactRequest,
      signal: abortController.signal,
      requestId,
      requiredEntryId,
    });
  } catch (error) {
    // ★ #88：补 durationMs，用这个函数自己的 `started`（bridge 入口），
    // 不是 executeCompactOnly 内部各 throw site 现场算的——起点必须跟
    // success outcome 的 duration_ms 一致（同样是 bridge 入口），两种
    // outcome 的耗时数字才能直接比较。只补这一个字段，其余分类原样保留，
    // 不吞异常、不改变错误类型——非 CompactServiceError（比如 AbortError）
    // 原样穿透。
    if (error instanceof CompactServiceError) {
      throw new CompactServiceError(error.message, error.status, error.useFormat429, error.retryCount, {
        skippedUpstream: error.skippedUpstream,
        promptTooLong: error.promptTooLong,
        estimatedTokens: error.estimatedTokens,
        budgetTokens: error.budgetTokens,
        cause: error.cause,
        durationMs: Date.now() - started,
        // upstreamMs（如果 executeCompactOnly 内部已经设置过）原样保留——
        // 这里只补总耗时，不动这个子集字段。
        upstreamMs: error.upstreamMs,
      });
    }
    throw error;
  }
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
  // ★ 8.10：这是唯一一处此前只打 console.log、重启就丢的"成功"事件——
  // Dashboard 快速压缩成功率需要它落盘，见 compact-outcome-log.ts 头部注释。
  // ★ #88：total_ms/compact_ms 此前只打进 console.log，重启就丢，跟 8.10
  // 之前"成功"事件本身的命运一样——一并落进 compact-outcomes.jsonl。
  // `compact.compactLatencyMs` 是 executeCompactOnly 已经算好的上游调用
  // 耗时（哪怕重试了几次账号，也是最终成功那一次的耗时，不含前面失败尝试
  // 的时间——这是"这次真正拿到 output 花了多久"，不是"整个函数调用花了
  // 多久"，两者刻意不同）；`Date.now() - started` 才是总耗时，两者的差值
  // 就是 restore/preservedTail 合并/预算裁剪/save 这些"我们自己的开销"。
  recordCompactOutcome({
    requestId,
    clientConversationId,
    model: translated.model,
    outcome: "success",
    replayed: stored.replayed,
    durationMs: Date.now() - started,
    upstreamMs: compact.compactLatencyMs,
  });
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
