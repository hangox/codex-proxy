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
 * - `denied`：409 / fail-closed（store 不可用、跨账号不重试等），客户端
 *   拿到的是硬错误，会话可能直接死——语义和"悄悄降级但仍然成功"完全不同，
 *   刻意不并入 `upstream_failed`，且必须在 Dashboard 上可见（team-lead
 *   原话："恰恰是最该被看见的一类"）。
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

export type CompactOutcome = "success" | "budget_exceeded" | "upstream_failed" | "denied";

export interface CompactOutcomeEvent {
  ts: string;
  rid: string;
  conv_hash: string | null;
  model: string;
  outcome: CompactOutcome;
  /** 仅 `success`：true 表示这次是幂等重放命中缓存 marker，不是新压缩。 */
  replayed?: boolean;
  /** 仅 `budget_exceeded`：预算预判阶段算出的估算 token 数。 */
  estimated_tokens?: number;
  /** 仅 `budget_exceeded`：当时对应型号的预算 token 数。 */
  budget_tokens?: number;
  /** `upstream_failed` 的 error name / `denied` 的结构化 reason。 */
  reason?: string;
}

export interface RecordCompactOutcomeInput {
  requestId: string;
  clientConversationId: string | null;
  model: string;
  outcome: CompactOutcome;
  replayed?: boolean;
  estimatedTokens?: number;
  budgetTokens?: number;
  reason?: string;
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
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };

    rotateJsonlIfNeeded(logPath(), backupPath(), maxBytes);
    appendFileSync(logPath(), JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // 日志失败绝不能影响主流程。
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

/** 读取全部事件（当前 + 备份文件），最新的排在最前面。 */
export function readCompactOutcomeLog(limit?: number): CompactOutcomeEvent[] {
  const oldest = readJsonlFile(backupPath());
  const newest = readJsonlFile(logPath());
  const combined = [...oldest, ...newest];
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
  return { success: 0, budget_exceeded: 0, upstream_failed: 0, denied: 0, total: 0, success_rate: 0 };
}

/**
 * 计算窗口内的成功率统计。`windowHours` 为 `"all"` 时不做时间过滤。
 * `recentBudgetExceededLimit` 控制 `recent_budget_exceeded` 最多返回几条。
 */
export function getCompactOutcomeStats(
  windowHours: number | "all",
  recentBudgetExceededLimit = 10,
): CompactOutcomeStats {
  const all = readCompactOutcomeLog(); // newest first
  const cutoff = windowHours === "all" ? null : Date.now() - windowHours * 3600_000;
  const events = cutoff === null ? all : all.filter((e) => new Date(e.ts).getTime() >= cutoff);

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
