/**
 * 8.10：opaque compact"快速压缩成功率"的结构化事件落盘 + 统计聚合。
 *
 * 起因（用户原话）："我想加一下，就是成功率有多少，这样的话我方便我看"。
 * 前提问题：此前**成功**事件只打 `console.log`（`opaque-compact-bridge.ts`
 * 的 `state_saved`/`state_replayed`），容器一重启就没了——今天一天重启了
 * 三次，历史全丢。要算成功率，必须先让成功事件落盘。
 *
 * 为什么不写进 `error-log.jsonl`（team-lead 明确约束）：那个文件语义是
 * "错误"，`success` 不是错误，混进去会让所有基于 `error-log.jsonl` 的查询
 * 和 Dashboard 错误页失真。这里开一个独立文件 `compact-outcomes.jsonl`，
 * 复用同一套已经在生产验证过的"按字节数轮转、单份备份"机制
 * （{@link rotateJsonlIfNeeded}，从 `error-log.ts` 抽出来的公共工具），但
 * 是独立的文件、独立的字节上限（`observability.compact_outcomes_max_bytes`）
 * ——这个文件"每次尝试都记一条"，量级比"只记错误"大得多，共享额度会
 * 挤占错误日志的留存时间。
 *
 * 四种结果，语义互不相同，team-lead 明确要求分开而不是合并成一个"失败"：
 * - `success`：真正走了快速压缩路径，marker 存盘成功（含幂等重放命中，
 *   见 `replayed` 字段——用户视角"压缩成功了"，走没走幂等短路是内部实现
 *   细节，不该体现在成功率上，但保留 `replayed` 字段以备将来单独统计
 *   幂等命中率）。
 * - `budget_exceeded`：预算预判阶段主动判定超限、跳过上游调用直接降级
 *   （task #25/#28/#29 那条链路）——是"我们自己的估算判断"，可能像 terra
 *   那次一样判错，所以带上 `estimated_tokens`/`budget_tokens` 两个数，
 *   方便在 Dashboard 上直接看出"这次降级是不是因为估算值明显偏高"。
 * - `upstream_failed`：真的打了上游 compact 端点，被上游拒绝（多数是
 *   `Prompt is too long`，也可能是其它 4xx/5xx）——不是我们的判断，是
 *   上游的判断。
 * - `denied`：客户端拿到的是硬错误（fail-closed），会话可能直接死——语义
 *   和"悄悄降级但仍然成功"完全不同，刻意不并入 `upstream_failed`，且必须
 *   在 Dashboard 上可见（team-lead 原话："恰恰是最该被看见的一类"）。
 *   ★ #96：这里**不再固定说"409"**——`#91` 之后族 A（自愈候选撞在非
 *   compact 请求上）改成了 400，`denied` 集合里现在混着 400 和 409，
 *   具体是哪个见每条记录自己的 `http_status` 字段（下方 `CompactOutcomeEvent`
 *   文档）。
 *
 * `budget_exceeded` 与 `upstream_failed` 曾经只能靠对 `error.message` 做
 * 字符串匹配区分（"skipping upstream compact call" 这句文本）——8.10 起
 * `CompactServiceError` 新增了 `skippedUpstream` 结构化字段（见
 * `codex-compact-service.ts`），调用方直接读字段，不用再解析文本，字段名
 * 改一下文案就静默失效的脆弱性没有了。
 *
 * 按会话去重的已知限制（team-lead 拍板 A 方案，必须在 Dashboard 上可见，
 * 不能只写在文档里）：`conv_hash` 用 {@link auditSessionTag}，其内部盐是
 * 进程级随机盐，**跨进程重启不稳定**（这是刻意设计的隐私边界，不是缺陷——
 * 见 `opaque-compact-audit.ts`）。如果一个真实会话的 retry storm 跨越了
 * 容器重启的那一刻，会被计成两个不同的"会话"。这是接受的代价（B 方案要
 * 削弱一条已经写进代码注释的隐私承诺，换来的只是统计在重启边界更准一点，
 * 不划算），但代价必须让看数字的人知道。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { getConfig } from "../../config.js";
import { getDataDir } from "../../paths.js";
import { rotateJsonlIfNeeded } from "../../logs/jsonl-rotation.js";
import { auditSessionTag } from "./opaque-compact-audit.js";
import type { RecompactFailureCause } from "./codex-compact-service.js";
import type { OpaqueCompactStateFailure } from "./opaque-compact-state.js";

export type CompactOutcome = "success" | "budget_exceeded" | "upstream_failed" | "denied" | "render_completed";

/**
 * ★ #108（用户原话："我想把压缩都统计到这里来，就是降级后的压缩也在这里
 * 统一展示，这样才能方便对比"）：这次尝试到底走的是哪条执行路径。
 *
 * 起因：opaque compact 失败后，`messages.ts` 会把**同一个、未经修改**的
 * compact 请求（Claude Code 客户端发来的，带着固定模板的"请压缩并按 7 段
 * 格式回复"指令，见 `codex-compact-service.ts` 的 `extractClaudeCodeCompactPrompt`）
 * 送进普通生成端点重新尝试一次——不是放弃压缩，是换了执行通道（专用
 * compact-only 端点换成通用生成端点，因为后者的 prompt 容量上限更大）。
 * 这次改动之前，"opaque 为什么失败"有记录（`opaque-compact-fallback-log.ts`），
 * 但"换端点之后那次压缩自己成不成功"完全没有记录——这是本次要补的缺口。
 *
 * 三个值分别对应三种**互不相同**的问题，刻意不合并成两个：
 * - `"opaque"`：真走了 opaque marker 路径的结果（`success`/`denied`）。
 * - `"fallback_decision"`：opaque 尝试为什么失败、因此触发了降级
 *   （`budget_exceeded`/`upstream_failed`，来自 `opaque-compact-fallback-log.ts`，
 *   这条走的是非流式的 compact-only 端点调用，失败是同步、真实抛出的
 *   `CodexApiError`，状态码可信）。
 * - `"fallback_render"`：降级之后，换通用端点重试的那次压缩**自己**的
 *   结果——`render_completed`（真正等到上游发出完成事件）或
 *   `upstream_failed`（同步被拒 / 中途断流 / 客户端中止，见
 *   `recordCompactFallbackRenderOutcome` 文档）。
 *
 *   ★★ 这条结论推翻过一次，记录一下教训：本函数最初的设计（写单测时
 *   跑出来的真实结果）是"这次请求恒为流式，代理对流式请求的所有同步
 *   失败分支统一返回 HTTP 200，`messages.ts` 那一层拿不到可信状态码，
 *   只能记一个语义残缺的 `render_started`"——这个结论**只对了一半**：
 *   它准确描述了"在 `messages.ts` 那一层看" 的情况，但真正可信的完成
 *   信号不需要在那一层拿，`streaming-handler.ts` 的 `finally` 块
 *   （:203-217）里的 `responseCompleted`（只在上游真正发出完成事件时
 *   置 true，中途断流/空响应/客户端中止都不会）和 `proxy-handler.ts`
 *   里几处"从未进入流式阶段就被拒绝"的终止点（那里的状态码是同步、
 *   真实抛出的 `CodexApiError`，跟 `res.status` 的不可靠无关）合起来，
 *   已经能覆盖这次 render 尝试的全部终止路径——不需要 #111 那种"接一套
 *   新回调机制"的大改动，只是"把已存在的完成信号带上一个标记传下去"。
 *   见 `recordCompactFallbackRenderOutcome` 完整文档。
 *
 * ★ 为什么不能把 `fallback_render` 并进 `fallback_decision`：两者都可能
 * 产生 `upstream_failed`，但含义完全不同——一个是 opaque 端点被拒，一个
 * 是通用端点被拒。合并成同一个 path 标签，会重新制造"看着分类了、其实
 * 分不清具体是哪一种"的模糊态，是这次改动本身要消灭的那类问题。
 *
 * 历史行没有这个字段——它在这次改动之前根本不存在，`resolveCompactPath`
 * 负责在读侧把老数据**确定性**地补全（不是"猜"，见该函数文档），调用方
 * 不需要处理 `undefined`。
 */
export type CompactPath = "opaque" | "fallback_decision" | "fallback_render";

export interface CompactOutcomeEvent {
  ts: string;
  rid: string;
  conv_hash: string | null;
  model: string;
  outcome: CompactOutcome;
  /** 仅 `success`：true 表示这次是幂等重放命中缓存 marker，不是新压缩。 */
  replayed?: boolean;
  /** 仅 `budget_exceeded`：预算预判阶段算出的估算 token 数（`estimate_source` 对应的那种方法算出的最终值）。 */
  estimated_tokens?: number;
  /** 仅 `budget_exceeded`：当时对应型号的预算 token 数。 */
  budget_tokens?: number;
  /**
   * ★ #97（用户原话："这个为什么是降级？"——team-lead 排查这个具体问题时
   * 发现的观测缺口）：`estimated_tokens` 是用哪种方法算出来的。
   *
   * - `"cheap"`：字节比例粗筛，粗筛本身就在预算内，没必要为了确认再付
   *   分词器懒加载成本。
   * - `"precise"`：粗筛怀疑超限后触发的精确估算，真分词器完整跑完，没有
   *   触发 2000ms 熔断。
   * - `"precise_extrapolated"`：精确估算触发了熔断，是按已处理比例外推
   *   出来的——**可信度明显低于 `"precise"`**，外推自 20%（刚过下限）和
   *   外推自 90% 的可信度不是一个量级，具体看 `processed_fraction`。
   *
   * ★ 判据是"这个数可不可信"：只做两值版本（合并 precise/precise_extrapolated
   * 成同一个 "tokenizer" 标签）会把可信度天差地别的两种情况标成同一个
   * 值——这比完全不记录更糟（"tokenizer" 会被误读成"这个数很准"），是
   * 这轮改动本身要治的"不同根因共用同一个标签"，不能在这里自己重新制造
   * 一次。仅 `budget_exceeded` 有值。
   */
  estimate_source?: "cheap" | "precise" | "precise_extrapolated";
  /**
   * ★ #97：仅 `estimate_source === "precise_extrapolated"` 时有值——已处理
   * 内容占总长度的比例（0~1）。这是判断外推可信度**最关键**的字段：没有
   * 它，`"precise_extrapolated"` 这个标签本身说明不了什么（20% 和 90% 差
   * 太远）。
   */
  processed_fraction?: number;
  /**
   * ★ #97：`planCompactRequestForBudget` 判断一开始就会算的粗筛值，跟
   * `estimated_tokens`（可能是精确值）并存，与 `estimate_source` 无关地
   * 一律记录（哪怕最终 `estimate_source` 就是 `"cheap"`，此时这个字段跟
   * `estimated_tokens` 数值相同，仍然记录，不特殊剔除）——每一条
   * `budget_exceeded` 记录因此变成一个"粗筛 vs 精确"的真实标定样本，供
   * 以后校准字节→token 比例常数直接从生产数据读，不用再像 8.9 那次靠 qa
   * 专门跑真实会话切片人工标定。仅 `budget_exceeded` 有值。
   */
  cheap_estimate_tokens?: number;
  /** `upstream_failed` 的 error name / `denied` 的结构化 reason。 */
  reason?: string;
  /**
   * ★ #96（reviewer 交叉审查发现的用户可见误导）：`denied` 的真实 HTTP
   * 状态码。#91 之前这个字段没有存在的必要——`denied` 恒等于 409；#91 之后
   * 族 A（`isSelfHealableOpaqueCompactStateFailure` 命中的 reason，撞在非
   * compact 请求上）改成了 400，同一个 `outcome: "denied"` 集合里现在混着
   * 400 和 409，前端如果继续假设"denied = 409"就会给用户错误的指引（比如
   * 对一个 400/族 A 的记录说"用 /clear"，而正确动作是"下次 /compact 自动
   * 恢复，不需要 /clear"）。只对 `denied` 有意义——其它三种 outcome 的
   * 状态码是隐式已知的常量（`success`/`budget_exceeded`/`upstream_failed`
   * 都不改变对外状态码，见各自的 catch 块），不需要重复记录。
   * 可选字段：这次改动之前落盘的历史行没有它，读侧必须当"未知"处理，
   * 不能默认成 409（那正是要修的那个假设）。
   */
  http_status?: number;
  /**
   * ★ #96：`denied` 的失败子因（`#83` 已经产出，这里只是把它接进这条记录）。
   * 只有 `reason === "recompact_failed_original_account"` 这个聚合桶的记录
   * 会有值——其它 `denied` reason 本身已经是完整分类，不需要再细分。跟
   * `opaque-compact-denial-log.ts` 里 `OpaqueCompactDenialInput.cause` 同一个
   * 值域、同一条纪律（结构化 enum，不是自由文本）。前端靠这个字段 + 上面的
   * `http_status`（对 `recompact_failed_original_account` 恒为 409）在
   * `stale_generation`/`preserved_tail_conflict`/`state_too_large` 和其余
   * 账号失败之间给出不同的用户指引，见 `describeRecompactFailure`（后端）
   * 与 `CompactDetailPage.tsx` 里镜像的前端版本。
   */
  cause?: RecompactFailureCause | OpaqueCompactStateFailure;
  /**
   * ★ #88：这次尝试从进入 compact 相关代码路径到落盘/拒绝/降级为止的总耗时
   * （毫秒）。**四种 outcome 都记**——不仅是 `success`：`denied`（400/409
   * fail-closed，见上面 `http_status` 的注释）本该是毫秒级，`budget_exceeded`（预算预判提前拦截，从未
   * 打上游）同样该是毫秒级；如果哪次这类"本该快"的 outcome 耗时到了秒级，
   * 耗时数字本身就是排查线索（比如锁竞争、store 慢查询），不是只有
   * `upstream_failed`/`success` 才有耗时值得看。
   *
   * 可选字段：旧版本写的历史行没有这个字段，读侧（Dashboard/统计聚合）必须
   * 按"缺失=未知"处理，不能假设它总是存在，也不能补 0（0 会被误读成"真的
   * 是 0ms"）。
   */
  duration_ms?: number;
  /**
   * ★ #88：仅当这次尝试真的发起了上游调用时才有值：opaque compact 的
   * `success`（非 `replayed`）/`upstream_failed`，以及降级后的
   * `fallback_render` 普通生成调用。它是 `duration_ms` 的一个子集，用来
   * 回答"慢在上游还是慢在我们自己这边"。
   *
   * `fallback_render` 的 `upstream_ms` 从发起普通生成上游请求开始，覆盖到
   * 流式结果结束或同步拒绝；账号获取、节流和其它本地准备不计入。幂等重放、
   * `budget_exceeded`、没有真正发起上游请求的 `denied`/pre-stream 失败都
   * 缺省这个字段（不是 0）。
   */
  upstream_ms?: number;
  /**
   * ★ #108：见 {@link CompactPath} 头部文档。历史行没有这个字段，读侧一律
   * 用 {@link resolveCompactPath} 取值，不要直接读这个字段——它在原始 JSONL
   * 里可能是 `undefined`。
   */
  compact_path?: CompactPath;
  /**
   * ★ #108/#111：仅 `compact_path === "fallback_render" && outcome === "upstream_failed"`
   * 有值——降级重试自己的失败发生在哪个阶段，见
   * `recordCompactFallbackRenderOutcome` 完整文档。
   *
   * - `"pre_stream"`：从未进入流式阶段就被拒绝（同步 `CodexApiError`：
   *   账号获取失败、跨账号硬绑定冲突、payload 过大、多账号重试耗尽……）。
   *   排查方向是"这次降级本身选错了"——该去调预算估算的阈值、或者换一个
   *   模型/端点，重试大概率还是一样的结果。
   * - `"mid_stream"`：上游已经接受、开始流式生成，但没能等到
   *   `response.completed`（中途断流/客户端中止/耗尽空响应重试）。排查
   *   方向是"这条链路本身不稳定"——该去查网络/上游服务可用性，跟预算
   *   估算是否准确无关。
   *
   * ★ 刻意不用两个 outcome 值表达这个区分（比如
   * `"upstream_failed_pre_stream"`/`"upstream_failed_mid_stream"`）：
   * `outcome` 这个字段本身的语义（成功/失败/拒绝）不该被"在哪个阶段失败"
   * 这个正交维度污染，用独立字段更符合这个文件里其它"outcome 相同、用
   * 子字段细分子因"的先例（`cause` 之于 `denied`、`estimate_source` 之于
   * `budget_exceeded`）。
   */
  failure_stage?: "pre_stream" | "mid_stream";
  /**
   * ★ #115（用户拍板"大胆一点"后的 cheap 估算放宽阈值改动，同批落地的
   * 内容类型埋点）：这次 compact 请求是否含图片内容（`input_image` content
   * part）——见 `codex-compact-service.ts` 的 `CompactBudgetPlan.hasImage`
   * 完整文档。仅 `budget_exceeded` 有值，跟 `estimate_source`/
   * `cheap_estimate_tokens` 同一批字段、同样的适用范围。
   *
   * 存在的意义：`estimate_source:"cheap"` 触发的放宽覆盖两种完全不同的
   * "算不准"场景（含图片、或分词器加载/执行失败）——不带这个字段，两类
   * 在数据里无法区分，没法回答"这次放宽到底救回的是哪一类"，也没法给
   * `CHEAP_ESTIMATE_BUDGET_MULTIPLIER`（目前定为 4）以后重新校准提供依据。
   */
  has_image?: boolean;
  /** ★ #115：见 `CompactBudgetPlan.imageBytes` 同名字段文档。仅 `budget_exceeded` 有值。 */
  image_bytes?: number;
  /** ★ #115：见 `CompactBudgetPlan.textBytes` 同名字段文档。仅 `budget_exceeded` 有值。 */
  text_bytes?: number;
}

export interface RecordCompactOutcomeInput {
  requestId: string;
  clientConversationId: string | null;
  model: string;
  outcome: CompactOutcome;
  replayed?: boolean;
  estimatedTokens?: number;
  budgetTokens?: number;
  /** 见 {@link CompactOutcomeEvent.estimate_source}。 */
  estimateSource?: "cheap" | "precise" | "precise_extrapolated";
  /** 见 {@link CompactOutcomeEvent.processed_fraction}。 */
  processedFraction?: number;
  /** 见 {@link CompactOutcomeEvent.cheap_estimate_tokens}。 */
  cheapEstimateTokens?: number;
  reason?: string;
  /** 见 {@link CompactOutcomeEvent.http_status}。 */
  httpStatus?: number;
  /** 见 {@link CompactOutcomeEvent.cause}。 */
  cause?: RecompactFailureCause | OpaqueCompactStateFailure;
  /** 见 {@link CompactOutcomeEvent.duration_ms}。 */
  durationMs?: number;
  /** 见 {@link CompactOutcomeEvent.upstream_ms}。 */
  upstreamMs?: number;
  /** 见 {@link CompactOutcomeEvent.compact_path}。 */
  compactPath?: CompactPath;
  /** 见 {@link CompactOutcomeEvent.failure_stage}。 */
  failureStage?: "pre_stream" | "mid_stream";
  /** 见 {@link CompactOutcomeEvent.has_image}。 */
  hasImage?: boolean;
  /** 见 {@link CompactOutcomeEvent.image_bytes}。 */
  imageBytes?: number;
  /** 见 {@link CompactOutcomeEvent.text_bytes}。 */
  textBytes?: number;
}

const LOG_FILE = "compact-outcomes.jsonl";
const BACKUP_FILE = "compact-outcomes.1.jsonl";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function logPath(): string {
  return resolve(ensureDataDir(), LOG_FILE);
}

function backupPath(): string {
  return resolve(ensureDataDir(), BACKUP_FILE);
}

/** 记录一次 opaque compact 尝试的最终结果。绝不抛出。 */
export function recordCompactOutcome(input: RecordCompactOutcomeInput): void {
  // 和 error-log.ts 同一条纪律：Vitest 下默认不碰真实 data 目录，除非测试
  // 显式打开这个逃生舱（复用同一个环境变量名，测试基础设施已经认识它）。
  if (process.env.VITEST && !process.env.VITEST_FORCE_APPEND_ERROR_LOG) return;

  try {
    const cfg = getConfig() as {
      observability?: { local_error_log?: boolean; compact_outcomes_max_bytes?: number };
    };
    // 复用 local_error_log 做总开关（同属本地可观测性），不新开一个配置项——
    // 团队目前只有"本地可观测性开/关"这一层判断，没有理由为这一类事件单独
    // 加一个开关。
    if (cfg.observability?.local_error_log === false) return;
    const maxBytes = cfg.observability?.compact_outcomes_max_bytes ?? DEFAULT_MAX_BYTES;

    const event: CompactOutcomeEvent = {
      ts: new Date().toISOString(),
      rid: input.requestId.slice(0, 8),
      conv_hash: input.clientConversationId != null && input.clientConversationId !== ""
        ? auditSessionTag(input.clientConversationId)
        : null,
      model: input.model,
      outcome: input.outcome,
      ...(input.replayed !== undefined ? { replayed: input.replayed } : {}),
      ...(input.estimatedTokens !== undefined ? { estimated_tokens: input.estimatedTokens } : {}),
      ...(input.budgetTokens !== undefined ? { budget_tokens: input.budgetTokens } : {}),
      ...(input.estimateSource !== undefined ? { estimate_source: input.estimateSource } : {}),
      ...(input.processedFraction !== undefined ? { processed_fraction: input.processedFraction } : {}),
      ...(input.cheapEstimateTokens !== undefined ? { cheap_estimate_tokens: input.cheapEstimateTokens } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.httpStatus !== undefined ? { http_status: input.httpStatus } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
      ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
      ...(input.upstreamMs !== undefined ? { upstream_ms: input.upstreamMs } : {}),
      ...(input.compactPath !== undefined ? { compact_path: input.compactPath } : {}),
      ...(input.failureStage !== undefined ? { failure_stage: input.failureStage } : {}),
      ...(input.hasImage !== undefined ? { has_image: input.hasImage } : {}),
      ...(input.imageBytes !== undefined ? { image_bytes: input.imageBytes } : {}),
      ...(input.textBytes !== undefined ? { text_bytes: input.textBytes } : {}),
    };

    rotateJsonlIfNeeded(logPath(), backupPath(), maxBytes);
    appendFileSync(logPath(), JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // 日志失败绝不能影响主流程。
  }
}

/**
 * 降级之后那次 fallback_render 请求的完成状态回填——`messages.ts` 把
 * `compactFallbackRender` 上下文（`requestId`/`startedAt`）挂在 `ProxyRequest`
 * 上之后，请求真正走完（不管成功、失败、还是从未真正进入流式阶段）的每一个
 * 终止点各自调用一次这个函数，绝不遗漏也绝不重复——见下面"覆盖的终止点"。
 *
 * ★★ 这条设计推翻过一次结论，记录一下教训：#108 落地时的判断是"这次请求
 * 恒为流式，`messages.ts` 那一层的 `res.status` 对流式请求的所有同步失败
 * 分支统一是 200（真实状态码编码进 SSE body），没有可信信号，只能记一个
 * 语义残缺的 `render_started`"——这个判断本身没错，但范围判断错了：它把
 * "在 `messages.ts` 那一层看不到" 等同于"整条调用链都看不到"。实际上
 * 这次请求的终止点分两类，**都在调用链更深的地方能看到真实结果**：
 *
 * 1. **从未进入流式阶段就被拒绝**（账号获取失败、跨账号硬绑定冲突、
 *    payload 过大、上游同步抛出不可重试的 `CodexApiError`……）——这些
 *    终止点全部在 `proxy-handler.ts` 内部，那里的状态码/错误信息是
 *    `handleCodexApiError`/`sendProxyUpstreamAttempt` 同步抛出的原始
 *    结果，跟"`res.status` 对流式响应不可靠"这条无关（那条不可靠说的是
 *    `respondWithProxyError` 把这个已知的真实错误**转换**成 SSE body 里的
 *    假 200 之后、传到 `messages.ts` 那一层已经看不出来了——但转换之前，
 *    在 `proxy-handler.ts` 内部，真相是完整的）。这类调用方传
 *    `completed: false`。
 * 2. **进入了流式阶段之后才有结果**——`streaming-handler.ts` 的 `finally`
 *    块（:203 附近）里，`responseCompleted` 只在上游真正发出完成事件时
 *    置 true，中途断流/空响应耗尽重试/客户端主动中止都不会——这是货真
 *    价实的完成信号，不是"流开始了"这种弱信号。那里传
 *    `completed: responseCompleted`。
 *
 * 两类终止点互斥（案例 1 命中就不会走到 `handleStreaming`，反之亦然），
 * 加起来覆盖 `handleProxyRequest`（codex/账号池路径）的全部终止点——含
 * "多账号重试全部耗尽、最终放弃"（`proxy-error-retry-transition.ts` 的
 * `action: "respond"` 分支）：那个函数只有唯一一处调用方（`proxy-handler.ts`
 * 自己），它的返回结果无论走的是"立刻放弃"还是"重试耗尽后放弃"哪条内部
 * 路径，最终都在同一个 `errorRetryTransition.action === "respond"` 判断处
 * 被消费——直接在这个唯一的消费点挂钩子，天然覆盖两条内部路径，不需要
 * 单独进 `proxy-error-retry-transition.ts` 改它本身（那是所有代理请求的
 * 公共路径，改动面越小越好）。
 *
 * 不覆盖 `direct-request-handler.ts`（api-key/adapter 直连路由）：
 * **已确认互斥，不是未知缺口**——`messages.ts:502`
 * `allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter"`，
 * 而 `messages.ts:814` 整个 opaque/fallback 判断块的入口条件里带着
 * `&& !allowUnauthenticated`：
 *
 *   `if (compactPrompt && clientConversationId !== null && req.stream === true && !allowUnauthenticated && opaqueCompactEnabled)`
 *
 * 也就是说只要 `routeMatch.kind` 是 `"api-key"`/`"adapter"`，这一整块
 * （含 `compactFallbackOccurred` 的赋值）**从入口就被短路跳过**，
 * `compactFallbackOccurred` 对这类路由恒为 `false`——不存在"先判断
 * routeMatch 再决定调哪个 handler，两边都可能挂上 compactFallbackRender
 * 上下文"这回事，走到 `routeMatch?.kind === "api-key" | "adapter"` 分支、
 * 调用 `handleDirectRequest` 时，`compactFallbackOccurred` 必然是
 * `false`，`directReq` 里的 `compactFallbackRender` 字段必然不存在。
 * （这条结论第一版写反过 ——把两个判断条件看成独立维度，只看了
 * `proxyReqWithFallbackContext` 的构造代码、没有追溯到 `allowUnauthenticated`
 * 这道更早的入口闸门，被自己发给 team-lead 之前的复核揪出来——如实记录
 * 这个教训，别只留正确结论。）
 *
 * `outcome` 两个值：`completed === true` → `"render_completed"`（真实
 * 完成，不是"提交了"）；否则 → `"upstream_failed"`。**失败细分靠
 * `failure_stage`，不是拆更多 outcome 值**——同步拒绝（换端点也没用，
 * 该去调预算/换模型）和中途断流（换端点本身有效，该去查网络/上游稳定性）
 * 排查方向完全相反，混在一起会让"我该往哪个方向查"这个问题在数据里
 * 消失，是跟 `compact_path` 那次同一个教训（拒绝把置信度/性质不同的两件
 * 事标成同一个值）。
 *
 * `req` 用结构类型而不是 import `ProxyRequest`——避免这个通用日志模块
 * 反向依赖 `proxy-handler-types.ts` 这个代理路由专属类型，两者本来就该
 * 是单向依赖。
 */
type CompactFallbackRenderRequest = {
  compactFallbackRender?: {
    requestId: string;
    startedAt: number;
    upstreamStartedAt?: number;
    upstreamMs?: number;
  };
};

function finishCompactFallbackUpstreamAttempt(
  ctx: NonNullable<CompactFallbackRenderRequest["compactFallbackRender"]>,
  nowMs: () => number,
): void {
  if (ctx.upstreamStartedAt === undefined) return;
  ctx.upstreamMs = (ctx.upstreamMs ?? 0) + Math.max(0, nowMs() - ctx.upstreamStartedAt);
  ctx.upstreamStartedAt = undefined;
}

/** 标记降级后普通生成端点的一次真实上游尝试开始。 */
export function markCompactFallbackUpstreamStart(
  req: CompactFallbackRenderRequest,
  nowMs: () => number = Date.now,
): void {
  const ctx = req.compactFallbackRender;
  if (!ctx) return;
  const startedAt = nowMs();
  // 重试前先封口上一段，避免把本地退避/节流时间算进上游耗时。
  finishCompactFallbackUpstreamAttempt(ctx, () => startedAt);
  ctx.upstreamStartedAt = startedAt;
}

/** 封口当前降级上游尝试；没有上下文或没有真实尝试时严格 no-op。 */
export function markCompactFallbackUpstreamEnd(
  req: CompactFallbackRenderRequest,
  nowMs: () => number = Date.now,
): void {
  const ctx = req.compactFallbackRender;
  if (!ctx) return;
  finishCompactFallbackUpstreamAttempt(ctx, nowMs);
}

export function recordCompactFallbackRenderOutcome(
  req: CompactFallbackRenderRequest & {
    clientConversationId?: string;
    model: string;
  },
  completed: boolean,
  extra?: { httpStatus?: number; failureStage?: "pre_stream" | "mid_stream" },
): void {
  const ctx = req.compactFallbackRender;
  if (!ctx) return;
  try {
    markCompactFallbackUpstreamEnd(req);
    recordCompactOutcome({
      requestId: ctx.requestId,
      clientConversationId: req.clientConversationId ?? null,
      model: req.model,
      compactPath: "fallback_render",
      outcome: completed ? "render_completed" : "upstream_failed",
      durationMs: Date.now() - ctx.startedAt,
      upstreamMs: ctx.upstreamMs,
      httpStatus: extra?.httpStatus,
      failureStage: completed ? undefined : extra?.failureStage,
    });
  } catch {
    // 日志失败绝不能影响主流程——recordCompactOutcome 内部已经兜底，这里
    // 再包一层纯粹是防御性的。
  }
}

function readJsonlFile(path: string): CompactOutcomeEvent[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: CompactOutcomeEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CompactOutcomeEvent);
    } catch {
      // 跳过损坏的行。
    }
  }
  return out;
}

/**
 * ★ #108：把 `compact_path` 补全成确定性的值，不是"猜"。这次改动之前
 * `compact_path` 这个概念不存在，历史行必然没有这个字段——但它们的
 * `outcome` 从写入那一刻起就已经唯一确定属于哪条路径，不存在歧义：
 * `success`/`denied` 只有 opaque 路径会产生（`opaque-compact-bridge.ts`/
 * `opaque-compact-denial-log.ts`），`budget_exceeded`/`upstream_failed`
 * 在这次改动之前只有一个写入方（`opaque-compact-fallback-log.ts`），记的
 * 恒定是"opaque 尝试为什么失败、触发降级"，即 `fallback_decision`。
 *
 * ★ 这不是"读取侧靠 outcome 推导 compact_path"这个模式的一般化用法——
 * 新写入的行（含这次新增的 `fallback_render`）永远由写入方显式带上
 * `compact_path`，本函数只处理"字段诞生之前"的历史存量，这批数据不会
 * 再增长。`render_completed` 这个新 outcome 值不会出现在没有 `compact_path`
 * 的历史行里（它是随这次改动一起引入的，写入方必然同时带上字段）。
 *
 * ★★ 一个容易看错的地方：`upstream_failed` 现在**有两个可能的写入方**
 * ——`fallback_decision`（一直如此）和这次新增的 `fallback_render`（见
 * `recordCompactFallbackRenderOutcome`）。但历史行（没有 `compact_path`
 * 字段的那批）只可能来自前者，因为 `fallback_render` 这个写入方本身是
 * 随这次改动才存在的，不会有"没写 compact_path 字段"的历史包袱——所以
 * 下面这行判断对历史数据依然是穷尽、无歧义的，不需要兜底分支；只是不能
 * 把这条推导逻辑误用在**新**数据上（新数据永远显式带字段，用不上这个
 * 函数的推导分支，见上面第一段）。
 */
export function resolveCompactPath(event: CompactOutcomeEvent): CompactPath {
  if (event.compact_path !== undefined) return event.compact_path;
  return event.outcome === "success" || event.outcome === "denied" ? "opaque" : "fallback_decision";
}

/**
 * 读取全部事件（当前 + 备份文件），最新的排在最前面。
 *
 * ★ #108：统一在这个唯一的读取入口把 `compact_path` 补全（见
 * {@link resolveCompactPath}）——`getCompactOutcomeStats`/
 * `queryCompactOutcomeEvents` 都从这里取数据，补全一次，两处都不用各自
 * 处理"字段可能缺失"这件事，不在两个消费者里各写一遍同样的兜底逻辑。
 * 只在内存里补全，不回写磁盘——原始 JSONL 文件保持不变。
 */
export function readCompactOutcomeLog(limit?: number): CompactOutcomeEvent[] {
  const oldest = readJsonlFile(backupPath());
  const newest = readJsonlFile(logPath());
  const combined = [...oldest, ...newest].map((e) => ({ ...e, compact_path: resolveCompactPath(e) }));
  combined.reverse();
  if (limit !== undefined) return combined.slice(0, limit);
  return combined;
}

/** 清空持久化的 compact outcome 事件（当前 + 备份）。测试/运维用。 */
export function clearCompactOutcomeLog(): void {
  for (const file of [LOG_FILE, BACKUP_FILE]) {
    try {
      const path = resolve(getDataDir(), file);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // 清理是尽力而为，失败不应该影响调用方。
    }
  }
}

// ── 统计聚合（读侧）───────────────────────────────────────────────

export interface CompactOutcomeBreakdown extends Record<CompactOutcome, number> {
  total: number;
  /** success / total，total 为 0 时是 0（不是 NaN）。 */
  success_rate: number;
}

export interface CompactOutcomeStats {
  /** 按原始请求计数——资源消耗视角，一次真实失败可能因客户端退避重试放大成几十条。 */
  by_request: CompactOutcomeBreakdown;
  /**
   * 按会话（`conv_hash`）去重——体验视角，团队认为这是"只能给一个口径就
   * 给这个"的那个。取窗口内每个会话**最后一条**事件的 outcome 作为代表
   * （198 次重试后第 199 次成功，这个会话算成功，不是"失败率 99.5%"）。
   *
   * ★ 已知限制：`conv_hash` 跨进程重启不稳定（见文件头注释），retry storm
   * 跨越重启边界的会话可能被计成两个。Dashboard 展示这个口径时必须把这条
   * 限制显式标出来，不能只在代码注释里说明。
   */
  by_session: CompactOutcomeBreakdown;
  /** 最近的 budget_exceeded 事件，供排查"是不是估算值系统性偏高"用。 */
  recent_budget_exceeded: Array<{
    ts: string;
    rid: string;
    model: string;
    estimated_tokens?: number;
    budget_tokens?: number;
  }>;
}

function emptyBreakdown(): CompactOutcomeBreakdown {
  return {
    success: 0,
    budget_exceeded: 0,
    upstream_failed: 0,
    denied: 0,
    // ★ #108：新增枚举值。默认口径下（见 getCompactOutcomeStats 的
    // compactPathFilter 处理）这个 key 恒为 0——按 compact_path 过滤，不是
    // 按 outcome 过滤，所以 fallback_render 产生的 upstream_failed 事件
    // 同样会被排除在默认聚合之外（不会混进 upstream_failed 这个 key，
    // 那个 key 默认口径下只统计 fallback_decision 的失败）。只有显式传
    // compact_path=fallback_render/all 时才会看到 render_completed 非零，
    // 也才会看到 fallback_render 自己的 upstream_failed 计入 upstream_failed。
    render_completed: 0,
    total: 0,
    success_rate: 0,
  };
}

/**
 * ★ 8.19（reviewer2 P2）：`getCompactOutcomeStats`/`queryCompactOutcomeEvents`
 * 此前各自独立调用 `Date.now()` 换算 cutoff，看起来是同一段逻辑抄了两遍——
 * 真实风险有两层：(1) 未来只改一处（比如把 `3600_000` 改成别的换算方式）
 * 忘了改另一处，两边窗口定义悄悄分叉；(2) `/summary` 和 `/events` 是两次
 * 独立的 HTTP 请求，服务端各自处理时刻的 `Date.now()` 天然不可能完全相同。
 *
 * 这里把 cutoff 换算抽成单一实现，两个函数共用；同时把"现在是什么时刻"
 * 变成显式可传入的 `nowMs` 参数（默认 `Date.now()`）——这样至少能保证
 * "给两个函数传同一个 `nowMs`，一定算出逐位相同的 cutoff"，把"两次独立
 * 实现"这个真正可以消除的风险类别（逻辑分叉）彻底关掉，并且让不变量
 * 测试能用一个固定的 `nowMs` 精确构造"事件正好卡在窗口边界"的场景，不用
 * 依赖真实墙钟时间去撞运气。
 *
 * ★ 已知未覆盖的部分（如实披露，不是没做完）：`/summary`（每 30s 轮询）
 * 和 `/events`（每 15s 轮询）在前端是两个独立计时器各自发起的真实 HTTP
 * 请求，轮询周期本身的 15s 落差远大于毫秒级时钟抖动——这不是这次改动能
 * 解决的问题（要解决就得把两个面板的轮询合并成一个共享节拍器，是更大的
 * 改动），也不是"数字对不上"这个用户可感知问题的主要来源。这里消除的是
 * "同一个请求场景下两处 cutoff 计算逻辑本身就可能不一致"这个更根本的类别。
 */
function resolveWindowCutoffMs(windowHours: number | "all", nowMs: number): number | null {
  return windowHours === "all" ? null : nowMs - windowHours * 3600_000;
}

/**
 * 计算窗口内的成功率统计。`windowHours` 为 `"all"` 时不做时间过滤。
 * `recentBudgetExceededLimit` 控制 `recent_budget_exceeded` 最多返回几条。
 *
 * ★ 8.17：`model` 可选参数——压缩明细面板（汇总区 + 明细列表同 tab）要求
 * 两块区域"用同一套筛选参数"，否则用户按型号筛列表后，上面的汇总数字
 * 还是全部型号的合计，会造成"看到 4 次降级、列表里却对不上"这类误判。
 * 这里只是在窗口过滤之后再加一步按 `model` 精确匹配过滤，不改变任何既有
 * 调用方的行为（不传就是原来的"全部型号"语义）。
 *
 * ★ 8.19：`nowMs` 可选参数，默认 `Date.now()`——见 {@link resolveWindowCutoffMs}
 * 头部注释。不传时行为和之前完全一样。
 *
 * ★ #108：`compactPathFilter` 可选参数——**不传时的默认口径是排除
 * `"fallback_render"`**，不是"不过滤"。这张卡片统计的是"opaque 压缩成功率"
 * 这个特定指标，分母历史上一直是 success/denied/budget_exceeded/
 * upstream_failed 四类（它们都描述"一次 opaque 尝试"，后三类是 opaque
 * 自己失败的三种理由，天然属于这个分母）。`fallback_render` 描述的是完全
 * 不同的问题——"opaque 失败降级之后，换端点重试的那次压缩自己成不成功"
 * ——如果不过滤就混进同一个分母，会稀释并悄悄改变这张卡片一直以来的数字
 * （render 事件只会往 total 里加，永远不会加进 success，因为它压根不是
 * "opaque 成功"这个概念），而调用方毫无感知。默认排除，是保住这张卡片
 * 指标定义不变，不是"为了兼容不敢动"。要看 fallback_render 的统计，显式
 * 传 `"fallback_render"` 或 `"all"`。
 */
export function getCompactOutcomeStats(
  windowHours: number | "all",
  recentBudgetExceededLimit = 10,
  model?: string,
  nowMs: number = Date.now(),
  compactPathFilter?: CompactPath | "all",
): CompactOutcomeStats {
  const all = readCompactOutcomeLog(); // newest first
  const cutoff = resolveWindowCutoffMs(windowHours, nowMs);
  const windowed = cutoff === null ? all : all.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const modelFiltered = model !== undefined && model !== "" ? windowed.filter((e) => e.model === model) : windowed;
  const events = compactPathFilter === undefined
    ? modelFiltered.filter((e) => e.compact_path !== "fallback_render")
    : compactPathFilter === "all"
      ? modelFiltered
      : modelFiltered.filter((e) => e.compact_path === compactPathFilter);

  const byRequest = emptyBreakdown();
  for (const e of events) {
    byRequest[e.outcome] += 1;
    byRequest.total += 1;
  }
  byRequest.success_rate = byRequest.total > 0 ? byRequest.success / byRequest.total : 0;

  // 按会话去重：events 已经是"最新在前"，所以按 conv_hash 第一次遇到的
  // 那条就是这个会话在窗口内最后一次真正发生的事件。
  const sessionOutcome = new Map<string, CompactOutcome>();
  const sessionSeen = new Set<string>();
  for (const e of events) {
    // 没有 conv_hash 的事件（理论上不应该发生，clientConversationId 缺失
    // 时 opaque compact 整条链路会在更早的地方 409）各自算独立会话，用
    // rid 兜底，不与其它无 session 事件误合并。
    const key = e.conv_hash ?? `__no_session_${e.rid}`;
    if (sessionSeen.has(key)) continue;
    sessionSeen.add(key);
    sessionOutcome.set(key, e.outcome);
  }
  const bySession = emptyBreakdown();
  for (const outcome of sessionOutcome.values()) {
    bySession[outcome] += 1;
    bySession.total += 1;
  }
  bySession.success_rate = bySession.total > 0 ? bySession.success / bySession.total : 0;

  const recentBudgetExceeded = events
    .filter((e) => e.outcome === "budget_exceeded")
    .slice(0, recentBudgetExceededLimit)
    .map((e) => ({
      ts: e.ts,
      rid: e.rid,
      model: e.model,
      estimated_tokens: e.estimated_tokens,
      budget_tokens: e.budget_tokens,
    }));

  return { by_request: byRequest, by_session: bySession, recent_budget_exceeded: recentBudgetExceeded };
}

// ── 明细列表（读侧）───────────────────────────────────────────────

export interface CompactOutcomeEventQuery {
  /** `"all"` 时不做时间过滤，语义和 `getCompactOutcomeStats` 一致。 */
  windowHours: number | "all";
  /** 精确匹配 `outcome`，不传表示不筛选（全部五类）。 */
  outcome?: CompactOutcome;
  /** 精确匹配 `model`，不传或空字符串表示不筛选。 */
  model?: string;
  /**
   * ★ #108：精确匹配 `compact_path`。**不传表示不筛选，展示全部三条路径**
   * ——这跟 `getCompactOutcomeStats` 默认排除 `fallback_render` 是刻意相反
   * 的默认口径，不是手滑改岔了：那边是有明确指标定义的聚合数字（"opaque
   * 压缩成功率"，混入无关数据会稀释/污染既有口径），这里是原始明细列表，
   * 本来就该有什么就展示什么——统一展示 opaque 和降级两条路径、方便对比，
   * 正是这次改动的目的（用户原话："降级后的压缩也在这里统一展示"）。
   */
  compactPath?: CompactPath;
  /**
   * `conv_hash` **前缀**匹配（不是模糊搜索）——`conv_hash` 本身是不可逆
   * 哈希，没有"用户记得的会话名"这种东西可搜，只有"我已经看到过某条记录
   * 的 conv_hash，想找同一个会话的其它记录"这个场景，前缀匹配够用。
   * 大小写不敏感。不传或空字符串表示不筛选。
   */
  convHashPrefix?: string;
  /** 默认 50，同 `/admin/logs` 的分页约定。 */
  limit?: number;
  /** 默认 0。 */
  offset?: number;
  /** ★ 8.19：默认 `Date.now()`，见 {@link resolveWindowCutoffMs} 头部注释。 */
  nowMs?: number;
}

export interface CompactOutcomeEventPage {
  events: CompactOutcomeEvent[];
  /** 过滤（时间窗口 + outcome + model）之后、分页之前的总条数。 */
  total: number;
  limit: number;
  offset: number;
  /**
   * ★ 8.18：这次时间窗口内出现过的型号，去重、按字母序排列——供前端型号
   * 筛选下拉框动态生成选项用，不是写死的型号列表（型号会变，见调用点
   * `CompactDetailPage.tsx` 的注释）。
   *
   * 只按**时间窗口**过滤，刻意不按当前请求的 `outcome`/`model` 再过滤
   * ——如果按 `model` 过滤，选中某个型号之后下拉框就会"塌缩"成只剩这一个
   * 选项，用户没法切换回别的型号；如果按 `outcome` 过滤，切换结果类型
   * 筛选时下拉框选项会跟着变化，制造"型号突然消失了"的困惑。这份列表
   * 因此代表"这个时间窗口里理论上还能筛出哪些型号"，是一个相对稳定的
   * 全集，不随其它筛选维度变化。
   */
  availableModels: string[];
  /**
   * ★ #108：这次时间窗口内出现过的 `compact_path`，去重，按固定顺序
   * （`"opaque"` → `"fallback_decision"` → `"fallback_render"`）排列——
   * 供前端路径筛选下拉框用。跟 `availableModels` 同一条纪律：只按时间
   * 窗口过滤，不按当前 outcome/model/compactPath 筛选再过滤，避免选中
   * 某个路径后下拉框"塌缩"成只剩一个选项。
   */
  availableCompactPaths: CompactPath[];
}

const DEFAULT_EVENTS_LIMIT = 50;

/**
 * ★ 8.17：压缩明细面板的列表数据源——`getCompactOutcomeStats` 只返回聚合
 * 统计（外加最多 10 条 `recent_budget_exceeded`，且只有这一种 outcome），
 * 从没有"给我全部原始事件、按时间倒序分页、可选按结果类型/型号筛"这个
 * 读法。这里新增一个专门的查询函数，复用同一份 `readCompactOutcomeLog()`
 * 数据源，不是新的采集/存储——纯读取逻辑，和 `getCompactOutcomeStats`
 * 是同一批数据的两种不同视图（一个看汇总，一个看明细），过滤顺序
 * （时间窗口 → outcome → model → 分页）和 `getCompactOutcomeStats` 的
 * "先按窗口过滤、再按 model 过滤"保持一致，方便两者对同一组筛选条件
 * 算出的 `total` 互相对得上。
 */
export function queryCompactOutcomeEvents(query: CompactOutcomeEventQuery): CompactOutcomeEventPage {
  const all = readCompactOutcomeLog(); // newest first
  const cutoff = resolveWindowCutoffMs(query.windowHours, query.nowMs ?? Date.now());
  const windowed = cutoff === null ? all : all.filter((e) => new Date(e.ts).getTime() >= cutoff);
  // 只按时间窗口算——不能用后面被 outcome/model/compactPath 过滤过的
  // `events`，见 `availableModels`/`availableCompactPaths` 字段文档
  // "为什么不按当前筛选再过滤"。
  const availableModels = [...new Set(windowed.map((e) => e.model))].sort();
  const COMPACT_PATH_ORDER: readonly CompactPath[] = ["opaque", "fallback_decision", "fallback_render"];
  const presentPaths = new Set(windowed.map((e) => e.compact_path));
  const availableCompactPaths = COMPACT_PATH_ORDER.filter((p) => presentPaths.has(p));

  let events = windowed;
  if (query.outcome !== undefined) events = events.filter((e) => e.outcome === query.outcome);
  if (query.model !== undefined && query.model !== "") events = events.filter((e) => e.model === query.model);
  if (query.compactPath !== undefined) events = events.filter((e) => e.compact_path === query.compactPath);
  if (query.convHashPrefix !== undefined && query.convHashPrefix !== "") {
    const prefix = query.convHashPrefix.toLowerCase();
    // ★ 8.19（reviewer2 P2，真崩溃 bug）：此前判断的是 `e.conv_hash !== null`，
    // 但字段缺失（旧格式事件、写入中断截断的行）时它是 `undefined`，不是
    // `null`，后面 `.toLowerCase()` 会直接抛 TypeError 把整个请求打崩——
    // 会话搜索一旦命中一条这样的脏数据，`/admin/compact-outcomes/events`
    // 就 500。改成 `typeof === "string"`，把 `null`/`undefined`/任何非
    // 字符串值一并当作"没有 conv_hash，过滤不到"处理，不再假设字段一定
    // 存在。
    events = events.filter((e) => typeof e.conv_hash === "string" && e.conv_hash.toLowerCase().startsWith(prefix));
  }

  const total = events.length;
  const limit = query.limit ?? DEFAULT_EVENTS_LIMIT;
  const offset = query.offset ?? 0;
  return { events: events.slice(offset, offset + limit), total, limit, offset, availableModels, availableCompactPaths };
}
