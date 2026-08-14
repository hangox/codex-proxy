import { useState, useEffect, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useCompactOutcomeEvents } from "../../../shared/hooks/use-compact-outcome-events";
import type {
  CompactOutcomeEvent,
  CompactOutcomeFilter,
  CompactOutcomeEventOutcome,
  CompactPathFilter,
} from "../../../shared/hooks/use-compact-outcome-events";
import type { UsageHistoryRange } from "../../../shared/hooks/use-usage-stats";
import type { TranslationKey } from "../../../shared/i18n/translations";
import { CompactOutcomesCard } from "../components/CompactOutcomesCard";
import { PillToggle } from "../components/PillToggle";

/** 复用给多个函数签名的翻译函数类型——避免同一段长类型在文件里重复抄写。 */
type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/**
 * ★★ task #109（qa 真实复现的崩溃，team-lead 复盘）：这里**必须**是
 * `Partial<Record<...>>` + 兜底查询，不能是穷举式 `Record<...>`。这个
 * 仓库刚真实撞过一次——backend-dev 上线了 `outcome: "render_completed"`
 * 这个新值，而这个对象当时只列了 5 个旧 key，`OUTCOME_META[outcome]` 拿到
 * `undefined`，`OutcomePill` 取 `.pillClass` 直接把整个面板崩掉
 * （`TypeError: Cannot read properties of undefined (reading 'pillClass')`，
 * 列表行和详情面板两处都会命中）。`PATH_META` 从一开始就是开放枚举、有
 * 兜底，这次崩溃的正是没做同样处理的 `OUTCOME_META`——同一个仓库、同一
 * 页面、同一次改动，两处防护标准不一致，栽的就是不一致的那一处。
 *
 * ★ task #111 落地后的语义更新：`render_completed`（不是 `render_started`）
 * ——真正等到上游发出完成事件才记这个值（`streaming-handler.ts` 的
 * `finally` 块里 `responseCompleted`），不是"提交了、不确定接没接受"那种
 * 弱信号。降级重试真的失败（同步被拒 / 中途断流 / 客户端中止）时复用既有
 * 的 `upstream_failed` 桶，不是一个独立值——`compact_path` 字段已经能
 * 区分"这是 opaque 端点被拒还是通用端点被拒"，不需要再造一个新 outcome
 * 值。`render_completed` 现在是真实、可信的完成信号，跟 opaque 的
 * `success` 是同一强度的保证，所以刻意复用同一套视觉（不再是之前那个
 * "进行中/待确认"的弱化蓝色）——两条路径谁成功谁失败，靠旁边的
 * `PathBadge` 区分，不需要 `OutcomePill` 自己再发明一套"看起来没那么
 * 可信"的视觉语言。
 */
const OUTCOME_META: Partial<Record<string, { icon: string; labelKey: TranslationKey; pillClass: string }>> = {
  success: { icon: "✅", labelKey: "compactOutcomeSuccess", pillClass: "bg-success-container text-success border-success/30" },
  budget_exceeded: { icon: "⚠️", labelKey: "compactOutcomeBudgetExceeded", pillClass: "bg-warning-container text-warning border-warning/30" },
  upstream_failed: { icon: "❌", labelKey: "compactOutcomeUpstreamFailed", pillClass: "bg-danger-container text-danger border-danger/30" },
  denied: { icon: "🛑", labelKey: "compactOutcomeDenied", pillClass: "bg-danger-container text-danger border-danger/30" },
  render_completed: { icon: "✅", labelKey: "compactOutcomeRenderCompleted", pillClass: "bg-success-container text-success border-success/30" },
};

const OUTCOME_META_UNKNOWN = { icon: "?", labelKey: "compactOutcomeUnknown" as TranslationKey, pillClass: "bg-slate-50 text-slate-400 border-slate-200 dark:bg-white/5 dark:text-text-dim dark:border-border-dark" };

/**
 * 未知/尚未收录的 outcome 值一律落到这里——不崩、不静默丢掉那条记录，
 * 跟 `pathMeta()` 同一条纪律。**这就是这次真实崩溃要补的那个兜底**，加
 * 一个新 key（比如这次的 `render_completed`）只解决这一次事故，加这个
 * 兜底才让下次后端再新增 outcome 值时不会重演同一场崩溃。
 */
function outcomeMeta(outcome: string): { icon: string; labelKey: TranslationKey; pillClass: string } {
  return OUTCOME_META[outcome] ?? OUTCOME_META_UNKNOWN;
}

/**
 * ★ task #109：压缩路径（`CompactOutcomeEvent.compact_path`）的展示元
 * 数据——镜像后端 `CompactPath` 的三个值，不是两个：
 * - `"opaque"`：真走了 opaque marker 路径。
 * - `"fallback_decision"`：opaque 尝试为什么失败、触发了降级（这条本身
 *   不是"降级后的压缩"，是"降级的原因"）。
 * - `"fallback_render"`：降级之后，换端点重试的那次压缩自己的结果——
 *   这才是用户原话"降级后的压缩"真正指的那一条。
 *
 * 按 team-lead 明确要求做成**开放枚举**：这里只是一个普通 `Record`，查
 * 不到的 key（未来可能出现的第四条路径）会落进 {@link pathMeta} 的兜底
 * 分支，显示"未分类"，不崩、也不静默丢掉那条记录——不写死"只有这三个值"
 * 这个假设。
 *
 * 徽标故意不用 emoji（区别于上面 `OUTCOME_META` 的图标——那是已有设计
 * 语言，不是这次改的对象）：纯文字 + 色块边框，任务里明确要求"能一眼
 * 区分，但不要用 emoji 做标记"。
 */
const PATH_META: Partial<Record<string, { labelKey: TranslationKey; badgeClass: string }>> = {
  opaque: {
    labelKey: "compactPathOpaque",
    badgeClass: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-white/5 dark:text-text-dim dark:border-border-dark",
  },
  fallback_decision: {
    labelKey: "compactPathFallbackDecision",
    badgeClass: "bg-warning-container text-warning border-warning/30",
  },
  fallback_render: {
    labelKey: "compactPathFallbackRender",
    badgeClass: "bg-primary/10 text-primary border-primary/30",
  },
};

const PATH_META_UNKNOWN = { labelKey: "compactPathUnknown" as TranslationKey, badgeClass: "bg-slate-50 text-slate-400 border-slate-200 dark:bg-white/5 dark:text-text-dim dark:border-border-dark" };

/** 未知/尚未收录的 compact_path 值一律落到这里——开放枚举的兜底，见 `PATH_META` 文档。 */
function pathMeta(path: string): { labelKey: TranslationKey; badgeClass: string } {
  return PATH_META[path] ?? PATH_META_UNKNOWN;
}

/**
 * ★ task #109（backend-dev 追加落地）：`CompactOutcomeEvent.failure_stage`
 * 的展示元数据——把"降级重试失败"拆成两种排查方向完全相反的情况：
 * - `"pre_stream"`：从未进入流式阶段就被拒绝——这次降级本身选错了，该调
 *   预算/换模型。
 * - `"mid_stream"`：进了流式阶段但没等到结束——链路不稳定，该查网络/
 *   上游可用性，跟这次降级判断对不对无关。
 *
 * 同样按开放枚举处理（跟 `PATH_META`/`OUTCOME_META` 一致）：这个字段目前
 * 只有这两个值，但字段文档里团队已经明确要求当开放枚举对待——未来出现
 * 第三个值时不能崩、不能静默丢记录，只显示"未分类"。
 */
const FAILURE_STAGE_META: Partial<Record<string, { labelKey: TranslationKey; badgeClass: string }>> = {
  pre_stream: {
    labelKey: "compactFailureStagePreStream",
    badgeClass: "bg-warning-container text-warning border-warning/30",
  },
  mid_stream: {
    labelKey: "compactFailureStageMidStream",
    badgeClass: "bg-danger-container text-danger border-danger/30",
  },
};

const FAILURE_STAGE_META_UNKNOWN = { labelKey: "compactFailureStageUnknown" as TranslationKey, badgeClass: "bg-slate-50 text-slate-400 border-slate-200 dark:bg-white/5 dark:text-text-dim dark:border-border-dark" };

/** 未知/尚未收录的 failure_stage 值一律落到这里——开放枚举的兜底，跟 `pathMeta`/`outcomeMeta` 同一条纪律。 */
function failureStageMeta(stage: string): { labelKey: TranslationKey; badgeClass: string } {
  return FAILURE_STAGE_META[stage] ?? FAILURE_STAGE_META_UNKNOWN;
}

/** 列表行/详情面板/关联记录卡片共用的"结果类型"徽标——避免同一段 pill 标记被抄三遍。 */
function OutcomePill({ outcome, t }: { outcome: string; t: TFn }) {
  const meta = outcomeMeta(outcome);
  return (
    <span class={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${meta.pillClass}`}>
      <span>{meta.icon}</span>
      <span>{t(meta.labelKey)}</span>
    </span>
  );
}

/** 列表行/详情面板/关联记录卡片共用的"压缩路径"徽标。 */
function PathBadge({ path, t }: { path: string; t: TFn }) {
  const meta = pathMeta(path);
  return (
    <span class={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-medium leading-none ${meta.badgeClass}`}>
      {t(meta.labelKey)}
    </span>
  );
}

/** 详情面板"为什么"分组里用的失败阶段徽标（同步拒绝 vs 中途断流）。 */
function FailureStageBadge({ stage, t }: { stage: string; t: TFn }) {
  const meta = failureStageMeta(stage);
  return (
    <span class={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-medium leading-none ${meta.badgeClass}`}>
      {t(meta.labelKey)}
    </span>
  );
}

/**
 * ★ #96（reviewer 交叉审查发现的用户可见误导）：`#91` 之前 `denied` 恒等于
 * 409，Dashboard 一直硬编码"denied = 409 = 建议 /clear"这个假设。`#91` 之后
 * 族 A（自愈候选撞在非 compact 请求上）改成了 400，同一个 `denied` 集合里
 * 现在混着三种性质完全不同的记录——继续给统一指引会教用户做错事（对一条
 * 400/族 A 的记录说"用 /clear"，而正确动作是"下次 /compact 自动恢复"，
 * /clear 还会真的清空整个会话）。
 *
 * 这里镜像后端两处判断（不是重新发明分类）：
 * - `messages.ts` 的 `isSelfHealableOpaqueCompactStateFailure`（族 A：
 *   not_found/expired/missing）——命中时这条 denied 记录的 `reason` 就是
 *   这三个值之一，说明这是一次撞在非 compact 请求上的自愈候选（真正的
 *   compact 请求会走 200 自愈，不会出现在这里）。
 * - `messages.ts` 的 `describeRecompactFailure` 三桶划分——只有
 *   `reason === "recompact_failed_original_account"` 的记录会带 `cause`。
 *
 * 判断顺序：先查 `reason`（族 A 判断不需要 `cause`，旧数据也能正确分类），
 * 再查 `cause`（族 A 之外，只有 recompact 聚合桶的记录才有 `cause`）。
 */
const SELF_HEALABLE_DENIED_REASONS = new Set(["expired", "not_found", "missing"]);
const CONCURRENCY_DENIED_CAUSES = new Set(["stale_generation", "preserved_tail_conflict"]);

function deniedGuidanceKey(e: CompactOutcomeEvent): TranslationKey {
  if (e.reason !== undefined && SELF_HEALABLE_DENIED_REASONS.has(e.reason)) {
    return "compactDetailHowDeniedSelfHeal";
  }
  if (e.cause === "state_too_large") {
    return "compactDetailHowDeniedTooLarge";
  }
  if (e.cause !== undefined && CONCURRENCY_DENIED_CAUSES.has(e.cause)) {
    return "compactDetailHowDeniedConflict";
  }
  // 默认桶：致命 store 故障、tampered/account_mismatch/comp_hash_mismatch、
  // 以及 recompact 聚合桶里"账号失败"那类 cause（含缺省的旧数据，没有
  // http_status/cause 字段时也落在这里——这是改动前唯一的行为，不是新增的
  // 猜测）。
  return "compactDetailHowDeniedClear";
}

/** 列表里"关键信息"那一列——按 outcome 类型拼一句摘要，字段都是已有数据，不是新增采集。 */
function keyInfoLine(e: CompactOutcomeEvent, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  if (e.outcome === "budget_exceeded") {
    const est = e.estimated_tokens !== undefined ? formatK(e.estimated_tokens) : "?";
    const budget = e.budget_tokens !== undefined ? formatK(e.budget_tokens) : "?";
    return `${t("compactDetailEstTokensFull")} ${est} / ${t("compactDetailBudgetTokensFull")} ${budget}`;
  }
  if (e.outcome === "success") {
    return e.replayed ? t("compactDetailReplayedYes") : "—";
  }
  // ★ #96：denied 记录顺带把真实状态码摆在最前面——之前列表和详情面板都
  // 隐含"denied = 409"，现在直接把号码亮出来，不用点进详情才知道。
  if (e.outcome === "denied" && e.http_status !== undefined) {
    return `${e.http_status} · ${e.reason ?? "—"}`;
  }
  return e.reason ?? "—";
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * ★ #97（用户原话："这个为什么是降级？"——team-lead 排查这条具体问题时
 * 发现的观测缺口）：`budget_exceeded` 记录的估算方式，用来判断这次
 * `estimated_tokens` 可不可信。`precise_extrapolated` 时把 `processed_fraction`
 * 括注在后面——外推自 20% 和外推自 90% 的可信度不是一个量级，只显示
 * "外推的"这三个字不够，必须把这个数字亮出来。缺省（旧数据，这次改动
 * 之前落盘的行）显示占位符，不猜是哪一种。
 */
function estimateSourceText(
  e: CompactOutcomeEvent,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (e.estimate_source === "cheap") return t("compactDetailEstimateSourceCheap");
  if (e.estimate_source === "precise") return t("compactDetailEstimateSourcePrecise");
  if (e.estimate_source === "precise_extrapolated") {
    const pct = e.processed_fraction !== undefined ? `${(e.processed_fraction * 100).toFixed(0)}%` : "?";
    return t("compactDetailEstimateSourcePreciseExtrapolated", { pct });
  }
  return "—";
}

/**
 * ★ #88：耗时格式化——1000ms 门槛之下按整数毫秒显示，之上按秒（一位小数）
 * 显示。不用 `Intl.RelativeTimeFormat` 之类的相对时间格式化——这里显示的是
 * "花了多久"（duration），不是"距现在多久"（相对时刻），语义不同。
 */
function formatDurationMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 列表显示值：降级压缩行优先显示真正普通生成上游耗时，旧行回退总耗时。 */
function listDurationMs(e: CompactOutcomeEvent): number | undefined {
  if (e.compact_path === "fallback_render") return e.upstream_ms ?? e.duration_ms;
  return e.duration_ms;
}

/**
 * 列表/详情共用的耗时摘要——`upstream_ms` 存在时括注上游耗时，方便一眼看出
 * "慢在上游还是慢在我们自己"（restore/preservedTail 合并/预算裁剪/save），
 * 不存在时只显示总耗时。两者都缺省（旧版本落盘的历史行，采集埋点上线前）
 * 时返回 `undefined`，调用方渲染成"—"，不是"0ms"——缺失和"确实是 0" 是
 * 两件不同的事。
 */
function formatDurationSummary(
  e: CompactOutcomeEvent,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (e.duration_ms === undefined) return undefined;
  const total = formatDurationMs(e.duration_ms);
  if (e.upstream_ms === undefined) return total;
  return `${total}（${t("compactDetailUpstreamMs")} ${formatDurationMs(e.upstream_ms)}）`;
}

function formatFullTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function formatTimeOnly(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString();
}

/**
 * ★★ 8.17：独立压缩明细面板——`compact-detail-panel-design.md` 落地实现。
 *
 * 页面结构（用户澄清后的版本，见设计文档 2.0 节）：汇总区在最上面
 * （`CompactOutcomesCard` `variant="full"`），下面是明细列表（主从布局，
 * 复用 `LogsPage.tsx` 的模式——列表左、详情右，`lg` 断点以下堆叠）。
 *
 * ★ 时间窗口只有一个控件，放在汇总区（`CompactOutcomesCard` 内部的
 * `PillToggle`），这里把 `hours` 状态提到页面级别、通过 props 下发给汇总区
 * 和 `useCompactOutcomeEvents`，两者共用同一个值——保证汇总数字和列表
 * 数字在同一个时间窗口下始终一致，不会出现"汇总说 4 次降级、列表里对不上"。
 *
 * ★ 结果类型筛选：汇总区四行都可点击（`onSelectOutcome`），点击直接把
 * 列表的 `outcome` 筛选设成对应值——这是"点汇总、下面自动筛出对应记录"
 * 这条联动的落地。
 *
 * ★ 8.18：型号筛选——下拉框选项来自 `useCompactOutcomeEvents().availableModels`
 * （后端只按时间窗口过滤，不因当前 outcome/model 筛选而收窄或塌缩，见
 * `compact-outcome-log.ts` 同名字段的注释），不是硬编码列表，也不是从
 * 一个独立的"型号列表"端点单独拉——直接复用这次请求已经带回来的数据，
 * 避免多一次网络往返、也避免和实际有压缩记录的型号集合脱节。
 *
 * ★★ 型号筛选**必须联动汇总区**（和"结果类型筛选不联动汇总区"刻意不
 * 对称——见下方 `CompactOutcomesCard` 的 `model` prop 传参，以及组件
 * 头部注释里"为什么型号联动、结果类型不联动"的设计取舍）：选中型号后，
 * 汇总区的成功率/总数也要按这个型号重新计算，不能列表按型号筛了、汇总
 * 区还是全部型号的合计——那样会出现"汇总说 4 次降级、切到这个型号后
 * 列表却只有 1 条"的错觉。默认是"全部型号"（`eventsState.model === ""`）。
 *
 * ★ 会话搜索这一版仍然**没有** UI（后端 `conv_hash_prefix` 参数已就绪，
 * 但用户这次只点了型号筛选，见 team-lead 转达）——跟随实际拍板范围，
 * 以后要加只是纯前端工作。
 */
// ★ #97 part 2（用户原话："这个为什么是降级？上面能不能加个 id？不然我
// 不好告诉你具体的问题是那个？或者 url 可以体现也可以"）：url 反映当前
// 选中记录 + 时间范围/结果筛选/型号筛选，刷新/分享链接后能定位回同一个
// 视图——排查问题时用户不用再口头描述"我筛了 xx 型号、点了第 3 条"，
// 一个链接就够。
//
// 只跟 `location.search`（`?` 后面那段）打交道，不碰 `location.hash`——
// `App.tsx` 的 tab 路由是对 `hash` 做**精确字符串匹配**
// （`TABS.find((t) => t.hash === hash)`），如果把这些参数塞进 hash 里
// （比如 `#/compact-detail?rid=xxx`），这个精确匹配会失配，整个 tab 都
// 渲染不出来——两套状态天生就该分层：hash 管"在哪个 tab"，search 管
// "这个 tab 内部的视图状态"，互不干扰。
const HOURS_URL_VALUES: readonly UsageHistoryRange[] = [24, 168, 720, "all"];

function parseHoursFromUrl(raw: string | null): UsageHistoryRange | null {
  if (raw === null) return null;
  if (raw === "all") return "all";
  const n = Number(raw);
  return HOURS_URL_VALUES.includes(n) ? n : null;
}

function parseOutcomeFromUrl(raw: string | null): CompactOutcomeFilter | null {
  if (
    raw === "all" || raw === "success" || raw === "budget_exceeded" || raw === "upstream_failed" ||
    raw === "denied" || raw === "render_completed"
  ) {
    return raw;
  }
  return null;
}

/**
 * ★ task #109：压缩路径筛选的 URL 值——只识别当前已知的三个值（镜像后端
 * `CompactPath`），未来出现第四个值之前，旧链接里出现不认识的字符串
 * （或压根没有这个参数）一律当"全部"处理，不报错、不崩，跟 `PATH_META`
 * 的开放枚举兜底是同一条纪律。query 参数名 `compact_path` 照抄后端。
 */
function parseCompactPathFromUrl(raw: string | null): CompactPathFilter | null {
  if (raw === "all" || raw === "opaque" || raw === "fallback_decision" || raw === "fallback_render") return raw;
  return null;
}

/** 读一次当前 `location.search`，用于组件挂载时的初始状态——之后的读写都走 `useEffect`。 */
function readInitialParamsFromUrl(): {
  hours: UsageHistoryRange | null;
  outcome: CompactOutcomeFilter | null;
  model: string | null;
  compactPath: CompactPathFilter | null;
  rid: string | null;
  /**
   * ★ task #109：`rid` 不再唯一（同一次请求降级时，`fallback_decision` 和
   * `fallback_render` 两条记录共享同一个 rid），URL 里必须再带一个 `ts`
   * 才能精确还原选中的是哪一条——没有 `ts` 的旧链接（这次改动之前分享
   * 出去的）仍然可以用，只是退化成"选中第一条匹配的记录"，不会报错或
   * 选中失败。
   */
  ts: string | null;
} {
  if (typeof location === "undefined") return { hours: null, outcome: null, model: null, compactPath: null, rid: null, ts: null };
  const params = new URLSearchParams(location.search);
  return {
    hours: parseHoursFromUrl(params.get("hours")),
    outcome: parseOutcomeFromUrl(params.get("outcome")),
    model: params.get("model"),
    compactPath: parseCompactPathFromUrl(params.get("compact_path")),
    rid: params.get("rid"),
    ts: params.get("ts"),
  };
}

export function CompactDetailPage() {
  const t = useT();
  // 初始值只在组件第一次挂载时读一次 URL（惰性初始化，不是每次渲染都读）——
  // 之后的每一次变化由下面的 useEffect 写回 URL，形成"URL 是当前视图状态
  // 的镜像"这个单向数据流，不需要每次渲染都重新解析。
  const initialParams = useRef(readInitialParamsFromUrl()).current;
  const [hours, setHours] = useState<UsageHistoryRange>(initialParams.hours ?? 24);
  const eventsState = useCompactOutcomeEvents(hours);

  // ★ outcome/model 的初始值不能靠 useState 的惰性初始化直接塞给
  // useCompactOutcomeEvents 内部状态（那个 hook 没有暴露"初始 outcome/model"
  // 这两个入参，改它的签名会影响到其它潜在调用方）——改用 setOutcome/setModel
  // 在挂载后立刻应用一次。这两个 setter 本来就会顺带清页码/选中项，这里是
  // 组件刚挂载的第一次调用，page/selected 本来就是初始值，没有副作用上的
  // 落差。只在挂载时跑一次（依赖数组为空），不是每次 URL 变化都重新读——
  // 之后 outcome/model 的变化只应该来自用户操作，不是 URL 被动触发。
  useEffect(() => {
    if (initialParams.outcome !== null && initialParams.outcome !== "all") {
      eventsState.setOutcome(initialParams.outcome);
    }
    if (initialParams.model !== null && initialParams.model !== "") {
      eventsState.setModel(initialParams.model);
    }
    // ★ task #109：跟 outcome/model 同一套挂载时应用一次的模式。
    if (initialParams.compactPath !== null && initialParams.compactPath !== "all") {
      eventsState.setCompactPath(initialParams.compactPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ rid 选中：只在当前已加载的 events 里真的能找到这个 rid 时才调用
  // selectEvent——不是"events 一加载完就无条件尝试一次"：`selectEvent` 找
  // 不到会把 `selected` 设成 `null`，挂载阶段这本来就是初始值、无害，但
  // 语义上"我确认过这条记录在，才去选中它"比"随手扔一个可能查无此人的
  // rid 过去，指望内部 find 帮我兜底"更清楚。用一个 ref 标记"已经选中
  // 过一次"，避免用户手动切换筛选、清空选中项之后，这个 effect 又把 URL
  // 里那个陈旧的 rid 重新选回来（那样用户永远清不掉选中状态）——分页/
  // 时间窗口刷新导致 `events` 变化时，只要还没成功选中过，就会用最新一批
  // `events` 再试一次（目标 rid 可能不在第一页/当时还没加载出来）。
  //
  // ★ task #109：`rid` 不再唯一——同一次请求的 opaque/render 两条记录共享
  // 同一个 rid。URL 里带 `ts` 时精确匹配那一条；没有 `ts`（这次改动之前
  // 分享出去的旧链接）时退化成"选中第一条匹配 rid 的记录"，不报错。
  const triedInitialRidSelect = useRef(false);
  useEffect(() => {
    if (triedInitialRidSelect.current) return;
    if (!initialParams.rid) return;
    const hasMatch = initialParams.ts
      ? eventsState.events.some((e) => e.rid === initialParams.rid && e.ts === initialParams.ts)
      : eventsState.events.some((e) => e.rid === initialParams.rid);
    if (!hasMatch) return;
    triedInitialRidSelect.current = true;
    eventsState.selectEvent(initialParams.rid, initialParams.ts ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsState.events]);

  // 状态 → URL 的单向同步：hours/outcome/model/compact_path/选中记录 任一
  // 变化都重写 `location.search`。用 `replaceState` 不是 `pushState`——
  // 每次切筛选/翻页选记录都会触发，用 `pushState` 会把浏览器"后退"按钮
  // 变成没用的筛选历史重放，不是用户想要的导航语义；分享/刷新要的是
  // "当前状态可还原"，不是"每一步操作都能后退"。
  useEffect(() => {
    if (typeof location === "undefined" || typeof history === "undefined") return;
    const params = new URLSearchParams(location.search);
    if (hours !== 24) params.set("hours", String(hours)); else params.delete("hours");
    if (eventsState.outcome !== "all") params.set("outcome", eventsState.outcome); else params.delete("outcome");
    if (eventsState.model !== "") params.set("model", eventsState.model); else params.delete("model");
    // ★ task #109：query 参数名 `compact_path` 照抄后端，跟 `outcome`/
    // `model` 一样只在不是"全部"时才写入。
    if (eventsState.compactPath !== "all") params.set("compact_path", eventsState.compactPath); else params.delete("compact_path");
    if (eventsState.selected) {
      params.set("rid", eventsState.selected.rid);
      // ★ task #109：`ts` 是精确还原选中记录的必要信息（rid 不再唯一），
      // 见上面 rid 选中 effect 的注释。
      params.set("ts", eventsState.selected.ts);
    } else {
      params.delete("rid");
      params.delete("ts");
    }
    const query = params.toString();
    const newUrl = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
    if (newUrl !== `${location.pathname}${location.search}${location.hash}`) {
      history.replaceState(null, "", newUrl);
    }
  }, [hours, eventsState.outcome, eventsState.model, eventsState.compactPath, eventsState.selected]);

  const pageStart = eventsState.total === 0 ? 0 : eventsState.page * eventsState.pageSize + 1;
  const pageEnd = eventsState.total === 0 ? 0 : Math.min(eventsState.total, (eventsState.page + 1) * eventsState.pageSize);
  const pageInfo = `${pageStart}-${pageEnd}`;

  // ★ task #109/qa 崩溃复盘：选项列表跟 `OUTCOME_META` 的 key 走同一份
  // 来源（`Object.keys`），不再逐个手写字面量——手写列表正是这次真实崩溃
  // 的同类风险（后端加一个新 outcome 值，这里的硬编码列表却没人记得同步
  // 更新）。跟下面 `pathFilterOptions` 用 `PATH_META` 的做法保持一致。
  const outcomeFilterOptions: Array<{ value: CompactOutcomeFilter; label: string }> = [
    { value: "all", label: t("compactFilterAll") },
    ...Object.keys(OUTCOME_META).map((o) => ({ value: o as CompactOutcomeFilter, label: t(outcomeMeta(o).labelKey) })),
  ];

  // ★ task #109：压缩路径筛选——四档"全部/Opaque/降级判定/降级压缩"，跟
  // 结果类型筛选是两个独立维度。选项直接来自 `PATH_META`（开放枚举），
  // 不是硬编码三个值——`PATH_META` 以后加第四个 key，这里不用跟着改。
  //
  // ★ team-lead 建议顺手接上：`eventsState.availableCompactPaths` 是这个
  // 时间窗口内实际出现过的路径（后端只按时间窗口过滤，见该字段文档）。
  // 选项列表本身仍然固定来自 `PATH_META`（不因为窗口里暂时没数据就让某个
  // 选项消失——那样用户会以为这个维度不存在，见 team-lead 原话），只是给
  // 当前窗口没有记录的选项加一个弱化的视觉提示（`PillToggle` 的 `muted`），
  // 提前告诉用户"选了大概率看到空列表，不是筛选坏了"。挂载/刷新期间
  // `availableCompactPaths` 还是空数组时不弱化任何选项——那不代表"全部
  // 没有数据"，只是还没加载完成。
  const pathFilterOptions: Array<{ value: CompactPathFilter; label: string; muted?: boolean }> = [
    { value: "all", label: t("compactFilterAll") },
    ...Object.keys(PATH_META).map((p) => ({
      value: p as CompactPathFilter,
      label: t(pathMeta(p).labelKey),
      muted: eventsState.availableCompactPaths.length > 0 && !eventsState.availableCompactPaths.includes(p),
    })),
  ];

  // 零数据要区分"真的没有"和"当前筛选下没有"——筛选条件非"全部"时，即便
  // 这次窗口内其实有压缩记录，也可能因为筛选而看不到任何一条，两种情况的
  // 文案不该一样，见设计文档 5.1 节。
  //
  // ★ 8.20（reviewer2 P2）：此前只判断了 `outcome`，漏了 `model`——选中一个
  // 该窗口内没有记录的型号时会显示"暂无压缩记录"，而真相是"这个型号在这个
  // 窗口里没有记录"。**两种筛选维度都会让列表空掉，判断必须都覆盖**，只列
  // 其中一个是把"当前有没有在筛"这件事只答对了一半。
  // ★ task #109：这次又新增了一个维度（压缩路径），同一条纪律——三个
  // 筛选维度全部要覆盖，不能只顾旧的两个又漏了新的一个。
  const isFiltered = eventsState.outcome !== "all" || eventsState.model !== "" || eventsState.compactPath !== "all";

  // ★★ task #109（backend-dev 追加落地 /summary 的 render 并列组之后）：
  // `CompactOutcomesCard` 的 `activeOutcome` prop 类型已经加宽到含
  // `"render_completed"`——汇总卡片现在真的有一行对应它了，不用再像之前
  // 那样把这个值转换成 `undefined` 藏起来，直接透传 `eventsState.outcome`
  // 就行。

  return (
    // ★ 8.17：这个页面只作为 SPA 内的 tab 内容渲染（`App.tsx` 的
    // `activeTab === "#/compact-detail"` 分支），不是独立的整页——和
    // `ErrorsPage.tsx` 同一个模式（`<section>` 包裹，没有自己的
    // `<header>`/`min-h-screen` 整页壳），不能照抄 `UsageStats.tsx`/
    // `LogsPage.tsx` 那种"既能整页独立跑、也能 embedded"的双模式（那两个
    // 页面历史上有独立入口的场景，这个页面从设计起就只在 Dashboard tab
    // 系统里用，没有这个需求，加一个用不到的 `embedded` 开关只是多余的
    // 分支）。
    <section class="flex flex-col gap-4">
      <div>
        <h2 class="text-lg font-bold text-slate-800 dark:text-text-main">{t("compactDetail")}</h2>
        <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">{t("compactDetailDesc")}</p>
      </div>

        <CompactOutcomesCard
          t={t}
          variant="full"
          hours={hours}
          onHoursChange={setHours}
          model={eventsState.model || undefined}
          activeOutcome={eventsState.outcome}
          onSelectOutcome={(outcome) => eventsState.setOutcome(outcome)}
          activeCompactPath={eventsState.compactPath}
          // ★ task #109：点击 render 分组的行，不能只 setOutcome——还要把
          // 压缩路径钉死在 fallback_render，否则"降级重试的 upstream_failed"
          // 点出来的列表会混进 fallback_decision 那组不相关的失败记录（见
          // `CompactOutcomesCard.tsx` 里 `onSelectRenderOutcome` 的文档）。
          onSelectRenderOutcome={(outcome) => {
            eventsState.setCompactPath("fallback_render");
            eventsState.setOutcome(outcome);
          }}
        />

        <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("compactColResult")}</span>
              <PillToggle options={outcomeFilterOptions} value={eventsState.outcome} onChange={eventsState.setOutcome} />
            </div>
            {/* ★ task #109：压缩路径筛选——独立于上面的结果类型筛选，跟
                型号筛选一样放在同一行，视觉语言保持一致（同款 label + 控件
                的组合，只是这里复用 PillToggle 而不是下拉框，因为选项是个
                小的固定集合，跟结果类型筛选的展示方式对称）。 */}
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("compactColPath")}</span>
              <PillToggle options={pathFilterOptions} value={eventsState.compactPath} onChange={eventsState.setCompactPath} />
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("compactColModel")}</span>
              <select
                value={eventsState.model}
                onChange={(e) => eventsState.setModel((e.target as HTMLSelectElement).value)}
                class="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              >
                <option value="">{t("compactFilterAllModels")}</option>
                {eventsState.availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            {/* ★ 8.19（reviewer2 提醒的可见性问题——不是行为错，是用户可能
                看不出列表已经被筛过了）：结果类型筛选不联动汇总区（汇总必须
                保持全貌，见 CompactOutcomesCard 头部注释），所以"列表被筛
                窄了"这件事必须在列表这一侧显眼地标出来，而不是让用户去猜
                "为什么汇总说 18 条列表只有 4 条"。这个徽标本身也是一个明确
                的清除入口（点击=回到"全部"），不用去找筛选栏里的"全部"那
                个 pill。 */}
            {eventsState.outcome !== "all" && (
              <button
                onClick={() => eventsState.setOutcome("all")}
                class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
              >
                <span>{t("compactFilteredBy", { label: t(outcomeMeta(eventsState.outcome).labelKey) })}</span>
                <span aria-hidden="true">×</span>
              </button>
            )}
            {/* ★ task #109：压缩路径筛选跟结果类型筛选一样不联动汇总区
                （汇总卡片本次拍板不接入这个维度），所以同一条 8.19 的纪律
                适用——列表被筛窄了必须在列表这一侧显眼标出来。 */}
            {eventsState.compactPath !== "all" && (
              <button
                onClick={() => eventsState.setCompactPath("all")}
                class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
              >
                <span>{t("compactFilteredBy", { label: t(pathMeta(eventsState.compactPath).labelKey) })}</span>
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
          <div class="text-xs text-slate-500 dark:text-text-dim">
            {t("logsPageSummary", { total: eventsState.total, range: pageInfo })}
          </div>
        </div>

        <div class="flex flex-col lg:flex-row gap-4 min-w-0">
          <div class="flex-1 min-w-0">
            <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-card-dark">
              {eventsState.loading && eventsState.events.length === 0 ? (
                <div class="p-8 text-center text-xs text-slate-400 dark:text-text-dim">Loading...</div>
              ) : eventsState.total === 0 ? (
                <EmptyState text={isFiltered ? t("compactListEmptyFiltered") : t("compactListEmpty")} />
              ) : (
                <>
                  <div class="overflow-x-auto">
                    <div class="min-w-[560px]">
                      <div class="grid grid-cols-12 text-xs text-slate-500 dark:text-text-dim px-3 py-2 border-b border-slate-200 dark:border-border-dark">
                        <div class="col-span-2">{t("compactColTime")}</div>
                        <div class="col-span-2">{t("compactColResult")}</div>
                        <div class="col-span-2">{t("compactColModel")}</div>
                        <div class="col-span-2">{t("compactColDuration")}</div>
                        <div class="col-span-4">{t("compactColKeyInfo")}</div>
                      </div>
                      <div class="max-h-[480px] overflow-y-auto">
                        {eventsState.events.map((e) => {
                          const durationMs = listDurationMs(e);
                          // ★ task #109：`rid` 不再唯一（同一次请求的 opaque/
                          // render 两条记录共享同一个 rid），选中态判断和
                          // `selectEvent` 调用都必须带上 `ts` 才能精确定位到
                          // 这一行，不能只靠 rid。
                          const isSelected = eventsState.selected?.rid === e.rid && eventsState.selected?.ts === e.ts;
                          return (
                            <button
                              key={`${e.rid}-${e.ts}`}
                              class={`w-full text-left grid grid-cols-12 items-center px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark ${isSelected ? "bg-primary/5" : ""}`}
                              onClick={() => eventsState.selectEvent(e.rid, e.ts)}
                            >
                              <div class="col-span-2 text-slate-500 dark:text-text-dim font-mono">{formatTimeOnly(e.ts)}</div>
                              {/* ★ task #109：压缩路径徽标叠在结果类型 pill 下面，
                                  同一个单元格里——不新开一列（省一次改表头/列宽的
                                  连带改动），两者堆叠着看正好回答"发生了什么 +
                                  走的哪条路径"这两个一起看才有意义的问题。 */}
                              <div class="col-span-2 flex flex-col items-start gap-0.5">
                                <OutcomePill outcome={e.outcome} t={t} />
                                <PathBadge path={e.compact_path} t={t} />
                              </div>
                              <div class="col-span-2 truncate font-mono text-slate-600 dark:text-text-dim">{e.model}</div>
                              {/* 普通路径继续显示总耗时；降级压缩行优先显示真正打
                                  普通生成上游的耗时，避免把降级决定后的本地收尾时间误当成
                                  压缩本身耗时。旧版本 fallback_render 没有 upstream_ms 时
                                  回退到 duration_ms，历史记录仍可读。 */}
                              <div class="col-span-2 truncate font-mono text-slate-600 dark:text-text-dim">
                                {durationMs !== undefined ? formatDurationMs(durationMs) : "—"}
                              </div>
                              <div class="col-span-4 truncate text-slate-600 dark:text-text-dim">{keyInfoLine(e, t)}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-border-dark text-xs text-slate-500 dark:text-text-dim">
                    <button
                      class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
                      disabled={!eventsState.hasPrev}
                      onClick={eventsState.prevPage}
                    >
                      {t("logsPrev")}
                    </button>
                    <span>{t("logsPageSummary", { total: eventsState.total, range: pageInfo })}</span>
                    <button
                      class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
                      disabled={!eventsState.hasNext}
                      onClick={eventsState.nextPage}
                    >
                      {t("logsNext")}
                    </button>
                  </div>
                </>
              )}
            </div>
            <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-2">{t("compactRetentionHint")}</p>
          </div>

          <div class="w-full lg:w-[380px] shrink-0">
            <div class="border border-slate-200 dark:border-border-dark rounded-lg bg-white dark:bg-card-dark">
              <div class="px-3 py-2 text-xs text-slate-500 dark:text-text-dim border-b border-slate-200 dark:border-border-dark">
                {t("compactDetailGroupRecord")}
              </div>
              <div class="p-3 max-h-[540px] overflow-y-auto">
                {eventsState.selected ? (
                  <DetailPanel
                    event={eventsState.selected}
                    events={eventsState.events}
                    onSelectRelated={(rid, ts) => eventsState.selectEvent(rid, ts)}
                    t={t}
                  />
                ) : (
                  <div class="text-xs text-slate-400 dark:text-text-dim py-6 text-center">
                    {t("compactDetailSelectHint")}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div class="p-10 text-center">
      <div class="inline-flex items-center justify-center size-10 rounded-full bg-slate-100 dark:bg-border-dark text-slate-400 dark:text-text-dim mb-3">
        <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <p class="text-sm text-slate-500 dark:text-text-dim">{text}</p>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="flex items-start justify-between gap-3 py-1 text-xs">
      <span class="text-slate-500 dark:text-text-dim shrink-0">{label}</span>
      <span class="text-slate-800 dark:text-text-main text-right break-all">{children}</span>
    </div>
  );
}

function DetailGroup({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="mb-4 last:mb-0">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-text-dim mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * 详情面板——按 outcome 类型渲染不同的"为什么"/"怎么回退的"内容，不是
 * 固定模板套所有类型（原型确认过的形态，见文件头注释）。
 */
/**
 * ★ #97 part 2（用户原话："上面能不能加个 id？不然我不好告诉你具体的问题
 * 是那个？"）：请求 ID 一直显示在面板上，但用户没有办法把它交给排查的人
 * ——只能手动框选文本再复制，容易漏字符/带上多余空白。加一个点击复制
 * 按钮，复制成功后给 2 秒的可见反馈（不是复制了但用户不知道复制了没有）。
 */
function CopyableRid({ rid, t }: { rid: string; t: (key: TranslationKey, vars?: Record<string, string | number>) => string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(rid).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // 剪贴板权限被拒绝/不支持时静默失败——rid 本来就以纯文本显示在旁边，
      // 用户仍然可以手动框选复制，不是唯一入口，不需要额外报错 UI。
    });
  };
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class="font-mono">{rid}</span>
      <button
        type="button"
        onClick={handleCopy}
        class="text-slate-400 dark:text-text-dim hover:text-slate-600 dark:hover:text-text-main transition-colors"
        title={t("compactDetailCopyRid")}
      >
        {copied ? (
          <span class="text-[10px] text-success">{t("compactDetailCopied")}</span>
        ) : (
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>
    </span>
  );
}

function DetailPanel({
  event: e,
  events,
  onSelectRelated,
  t,
}: {
  event: CompactOutcomeEvent;
  /**
   * ★ task #109：当前已加载（受时间窗口/筛选/分页限制）的事件列表——用来
   * 找"关联记录"（同一个 rid 的另一条记录——一次降级会产生
   * `fallback_decision`+`fallback_render` 两条记录，共享同一个 rid，见
   * `CompactOutcomeEvent.compact_path` 文档）。已知限制：只在这份已加载
   * 的数据里找，不会为了找关联记录单独发一次请求——如果用户按压缩路径
   * 筛过（比如只看 opaque），另一半记录不在 `events` 里，关联记录区就
   * 不会显示，不是"没有关联记录"，是"当前筛选范围里看不到"。这是一个
   * 已知取舍，不是 bug：为了这个次要功能单独发请求/绕开当前筛选条件
   * 查询，复杂度收益不成比例。
   */
  events: CompactOutcomeEvent[];
  onSelectRelated: (rid: string, ts: string) => void;
  t: TFn;
}) {
  // ★ task #109：同一次客户端请求降级时，`fallback_decision`（为什么触发
  // 降级）和 `fallback_render`（降级后那次重试自己的结果）共享同一个 rid
  // （用 `ts` 排除自己）。
  const related = events.find((other) => other.rid === e.rid && other.ts !== e.ts);

  return (
    <div>
      <DetailGroup title={t("compactDetailGroupRecord")}>
        <DetailRow label={t("compactDetailTime")}>{formatFullTime(e.ts)}</DetailRow>
        <DetailRow label={t("compactDetailRid")}>
          <CopyableRid rid={e.rid} t={t} />
        </DetailRow>
        <DetailRow label={t("compactDetailResult")}>
          <OutcomePill outcome={e.outcome} t={t} />
        </DetailRow>
        {/* ★ task #109：压缩路径紧挨着结果类型——两者一起看才回答"发生了
            什么 + 走的哪条路径"。 */}
        <DetailRow label={t("compactDetailPath")}>
          <PathBadge path={e.compact_path} t={t} />
        </DetailRow>
        <DetailRow label={t("compactDetailModel")}>
          <span class="font-mono">{e.model}</span>
        </DetailRow>
        {/* ★ #88：耗时是所有 outcome 都可能有的字段（不只是 success/
            upstream_failed 才有意义——denied/budget_exceeded 理应是毫秒级，
            耗时数字本身就是排查线索），放进跟 outcome 无关的"Record"分组，
            不放进下面按 outcome 分支渲染的"Why"分组。 */}
        <DetailRow label={t("compactDetailDuration")}>
          {formatDurationSummary(e, t) ?? "—"}
        </DetailRow>
      </DetailGroup>

      {/* ★ task #109：关联记录——同一次请求降级时产生的另一条记录
          （fallback_decision ↔ fallback_render）。这正是用户要的"能对比"
          落地成 UI：不需要用户自己去凑两条 rid 相同的行，点一下直接跳转
          到另一条。 */}
      {related && (
        <DetailGroup title={t("compactDetailGroupRelated")}>
          <button
            type="button"
            onClick={() => onSelectRelated(related.rid, related.ts)}
            class="w-full text-left text-xs px-2 py-1.5 rounded-md border border-slate-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark flex items-center justify-between gap-2"
          >
            <span class="flex items-center gap-1.5 flex-wrap">
              <PathBadge path={related.compact_path} t={t} />
              <OutcomePill outcome={related.outcome} t={t} />
            </span>
            <span class="text-slate-400 dark:text-text-dim shrink-0 whitespace-nowrap">{t("compactDetailViewRelated")} →</span>
          </button>
          <p class="text-[11px] text-slate-400 dark:text-text-dim mt-1">{t("compactDetailRelatedHint")}</p>
        </DetailGroup>
      )}

      {e.outcome === "budget_exceeded" && (
        <DetailGroup title={t("compactDetailGroupWhy")}>
          <DetailRow label={t("compactDetailEstTokensFull")}>{e.estimated_tokens?.toLocaleString() ?? "—"}</DetailRow>
          <DetailRow label={t("compactDetailBudgetTokensFull")}>{e.budget_tokens?.toLocaleString() ?? "—"}</DetailRow>
          {e.estimated_tokens !== undefined && e.budget_tokens !== undefined && e.budget_tokens > 0 && (
            <DetailRow label={t("compactDetailExceedPct")}>
              +{(((e.estimated_tokens - e.budget_tokens) / e.budget_tokens) * 100).toFixed(1)}%
            </DetailRow>
          )}
          {/* ★ #97（用户原话："这个为什么是降级？"——team-lead 排查这条具体
              问题时发现的观测缺口）：这次 estimated_tokens 到底可不可信——
              精确算完的和熔断后从 20% 外推的可信度天差地别，缺了这一行
              用户没法判断这次降级是不是误判。 */}
          <DetailRow label={t("compactDetailEstimateSource")}>
            {estimateSourceText(e, t)}
          </DetailRow>
          {/* ★ #97：粗筛值跟精确值并存，让每一条记录都是一个"粗筛 vs 精确"
              的标定样本——不只在 estimate_source 是 cheap 时才有意义，
              precise/precise_extrapolated 场景下这一行才是真正的对照组。 */}
          {e.cheap_estimate_tokens !== undefined && (
            <DetailRow label={t("compactDetailCheapEstimateTokens")}>
              {e.cheap_estimate_tokens.toLocaleString()}
            </DetailRow>
          )}
        </DetailGroup>
      )}
      {e.outcome === "success" && (
        <DetailGroup title={t("compactDetailGroupWhy")}>
          <DetailRow label={t("compactDetailReplayed")}>
            {e.replayed ? t("compactDetailReplayedYes") : t("compactDetailReplayedNo")}
          </DetailRow>
        </DetailGroup>
      )}
      {(e.outcome === "upstream_failed" || e.outcome === "denied") && (
        <DetailGroup title={t("compactDetailGroupWhy")}>
          {/* ★ #96：denied 专有——HTTP 状态码不再是隐含的 409，直接摆出来，
              跟下面"怎么回退的"里的指引对应，不用用户自己去猜。denied 恒
              显示这一行（缺省=旧数据时显示占位符"—"，不是悄悄不显示这一
              行——这一点#96 就是这么设计的，这次没有改）。
              ★ task #109：非 denied 时只在真的有值才显示——`fallback_render`
              失败时（`compact_path === "fallback_render"`）可能带
              `http_status`（`failure_stage === "pre_stream"` 恒带，见下面
              `failure_stage` 那一行），中途断流场景（`"mid_stream"`）不带。 */}
          {(e.outcome === "denied" || e.http_status !== undefined) && (
            <DetailRow label={t("compactDetailHttpStatus")}>{e.http_status ?? "—"}</DetailRow>
          )}
          {/* ★ task #109（backend-dev 追加落地）：把"降级重试失败"拆成两种
              排查方向完全相反的情况——同步拒绝（该调预算/换模型）vs 中途
              断流（该查链路）。缺省时（历史行）不显示这一行，不假装比
              后端实际记录更细。 */}
          {e.compact_path === "fallback_render" && e.failure_stage !== undefined && (
            <DetailRow label={t("compactDetailFailureStage")}>
              <FailureStageBadge stage={e.failure_stage} t={t} />
            </DetailRow>
          )}
          <DetailRow label={t("compactDetailReason")}>{e.reason ?? "—"}</DetailRow>
        </DetailGroup>
      )}

      <DetailGroup
        title={e.compact_path === "fallback_render" ? t("compactDetailGroupWhatRender") : t("compactDetailGroupHow")}
      >
        {/* ★ task #109：`fallback_render` 记录本身就是"降级之后那次尝试"，
            标题/文案不能沿用 opaque 语境的"怎么回退的"（这次尝试失败之后
            已经没有再降一级的地方了，用同一套文案会误导用户以为还有下一
            层）——按 `compact_path` 先分流，opaque/fallback_decision 分支
            保持原样，不是重新设计整套判断。
            ★★ task #111 落地后的语义更新：`render_completed` 是真实、
            可信的完成信号（不是"提交了，不确定接没接受"那种弱信号了）。
            ★★ task #109（backend-dev 追加落地）：`upstream_failed` 进一步
            按 `failure_stage` 分流——同步拒绝和中途断流的排查方向完全
            相反，不能用同一句话打发。缺省（历史行）时退回原来那句"三种
            情况未细分"的文案，不假装知道更多。 */}
        <p class="text-xs text-slate-600 dark:text-text-dim leading-relaxed">
          {e.compact_path === "fallback_render" ? (
            <>
              {e.outcome === "render_completed" && t("compactDetailHowRenderCompleted")}
              {/* ★ 三元链而不是三个并列 `&&`——`failure_stage` 是开放枚举，
                  未来出现第三个值时必须落回通用文案，不能因为不匹配前两个
                  分支就渲染出一句空白（那样比直接显示"未细分"的兜底措辞
                  更糟：用户会以为这里本该有文字但丢了）。 */}
              {e.outcome === "upstream_failed" && (
                e.failure_stage === "pre_stream" ? t("compactDetailHowRenderFailedPreStream") :
                e.failure_stage === "mid_stream" ? t("compactDetailHowRenderFailedMidStream") :
                t("compactDetailHowRenderUpstreamFailed")
              )}
            </>
          ) : (
            <>
              {e.outcome === "budget_exceeded" && t("compactDetailHowBudgetExceeded")}
              {e.outcome === "denied" && t(deniedGuidanceKey(e))}
              {e.outcome === "upstream_failed" && t("compactDetailHowUpstreamFailed")}
              {e.outcome === "success" && (e.replayed ? t("compactDetailHowSuccessReplayed") : t("compactDetailHowSuccess"))}
            </>
          )}
        </p>
      </DetailGroup>

      <DetailGroup title={t("compactDetailGroupSession")}>
        <DetailRow label={t("compactDetailConvHash")}>
          <span class="font-mono">{e.conv_hash ?? "—"}</span>
        </DetailRow>
        <div class="flex items-start gap-1 text-[11px] text-slate-400 dark:text-text-dim mt-1">
          <span>ⓘ</span>
          <span>{t("compactDetailConvHashHint")}</span>
        </div>
      </DetailGroup>

      {/* ★ 需新增采集——按 outcome 类型给出对应的黄色提示块，让用户看得见
          "还能更详细"，不是悄悄不显示。见 compact-detail-panel-design.md
          第 3 节字段清单"需新增采集"那些条目。
          ★ #97：budget_exceeded 原来这里的提示是"估算方式还没接进这条
          记录"——这次改动把 estimate_source/processed_fraction/
          cheap_estimate_tokens 全部接进来了，那条提示已经不成立，整块
          跟着删掉（不是留一个空字符串占位），不是"顺手清理"，是它描述的
          缺口这次真的补上了。 */}
      {/* ★ task #111 落地后：render_completed 不再需要这个提示——它曾经
          描述的缺口（"不确认上游是否接受、更不确认是否生成成功"）已经被
          `streaming-handler.ts` 的真实完成信号补上了，整块提示对
          render_completed 已经不成立，不留在这里（同 #97 那次"缺口真的
          补上了，提示跟着删掉"的处理方式，不是遗漏）。 */}
      {(e.outcome === "success" || e.outcome === "upstream_failed" || e.outcome === "denied") && (
        <DetailGroup title={t("compactDetailGroupMissing")}>
          <div class="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/40 rounded-lg p-2 leading-relaxed">
            {e.outcome === "success" && t("compactDetailMissingSuccess")}
            {(e.outcome === "upstream_failed" || e.outcome === "denied") && t("compactDetailMissingFailure")}
          </div>
        </DetailGroup>
      )}

      {/* ★ team-lead 复核用户反馈："一个链接需要配一句'然后你手动做这三步'，
          说明它没做完"——原来的文案是"去日志页——把上面的请求 ID 粘贴到
          搜索框里查 →"，配的是纯 `<a href="#/logs">`，不带任何上下文，
          用户得自己复制 rid、切页、粘进搜索框。这条链接是面板刚做时写的，
          当时请求 ID 不能复制、日志页也不支持从 URL 接收搜索词，只能让
          用户手抄；#97 已经把"请求 ID 可复制"和"URL 反映视图状态"这两块
          拼图都补上了，但这条链接当时没跟着更新。
          日志页的路由是精确字符串匹配 `location.hash`（见 App.tsx 的
          `activeTab`），不支持 `#/logs?search=...` 这种把参数塞进 hash 的
          深链接（会直接不匹配任何 tab、退回到概览页）——和这个面板自己的
          URL 状态同步用的是同一套分层："search"（`location.search`）
          管视图状态、hash 管在哪个 tab，互不干扰。所以这里先把
          `search=<rid>` 写进 `location.search`（用 replaceState，不产生
          导航历史），再改 `location.hash` 触发 tab 切换——日志页那边读到
          的 `location.search` 已经带着这个参数。
          rid 是否需要精确匹配：日志存储的 `search` 用 `includes()` 子串
          匹配（`src/logs/store.ts`「★ 8.17」），面板显示的 rid 就是
          `requestId.slice(0,8)`，日志记录里存的 `requestId` 在没有客户端
          自定义 `x-request-id` 头的正常路径下本身就是 8 位（见
          `src/middleware/request-id.ts`），两边字符串相同——不是"恰好能
          搜到"的前缀匹配侥幸，是同一个值。 */}
      <a
        href="#/logs"
        class="block text-xs font-medium text-primary hover:underline"
        onClick={(event) => {
          event.preventDefault();
          if (typeof location === "undefined" || typeof history === "undefined") return;
          const params = new URLSearchParams();
          params.set("search", e.rid);
          history.replaceState(null, "", `${location.pathname}?${params.toString()}${location.hash}`);
          location.hash = "#/logs";
        }}
      >
        {t("compactDetailJumpToLogs")}
      </a>
    </div>
  );
}
