import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useCompactOutcomeEvents } from "../../../shared/hooks/use-compact-outcome-events";
import type { CompactOutcomeEvent, CompactOutcomeFilter } from "../../../shared/hooks/use-compact-outcome-events";
import type { CompactOutcome } from "../../../shared/hooks/use-compact-outcomes";
import type { UsageHistoryRange } from "../../../shared/hooks/use-usage-stats";
import type { TranslationKey } from "../../../shared/i18n/translations";
import { CompactOutcomesCard } from "../components/CompactOutcomesCard";
import { PillToggle } from "../components/PillToggle";

const OUTCOME_META: Record<CompactOutcome, { icon: string; labelKey: TranslationKey; pillClass: string }> = {
  success: { icon: "✅", labelKey: "compactOutcomeSuccess", pillClass: "bg-success-container text-success border-success/30" },
  budget_exceeded: { icon: "⚠️", labelKey: "compactOutcomeBudgetExceeded", pillClass: "bg-warning-container text-warning border-warning/30" },
  upstream_failed: { icon: "❌", labelKey: "compactOutcomeUpstreamFailed", pillClass: "bg-danger-container text-danger border-danger/30" },
  denied: { icon: "🛑", labelKey: "compactOutcomeDenied", pillClass: "bg-danger-container text-danger border-danger/30" },
};

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
  return e.reason ?? "—";
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * ★ #88：耗时格式化——1000ms 门槛之下按整数毫秒显示，之上按秒（一位小数）
 * 显示。不用 `Intl.RelativeTimeFormat` 之类的相对时间格式化——这里显示的是
 * "花了多久"（duration），不是"距现在多久"（相对时刻），语义不同。
 */
function formatDurationMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
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
export function CompactDetailPage() {
  const t = useT();
  const [hours, setHours] = useState<UsageHistoryRange>(24);
  const eventsState = useCompactOutcomeEvents(hours);

  const pageStart = eventsState.total === 0 ? 0 : eventsState.page * eventsState.pageSize + 1;
  const pageEnd = eventsState.total === 0 ? 0 : Math.min(eventsState.total, (eventsState.page + 1) * eventsState.pageSize);
  const pageInfo = `${pageStart}-${pageEnd}`;

  const outcomeFilterOptions: Array<{ value: CompactOutcomeFilter; label: string }> = [
    { value: "all", label: t("compactFilterAll") },
    { value: "success", label: t(OUTCOME_META.success.labelKey) },
    { value: "budget_exceeded", label: t(OUTCOME_META.budget_exceeded.labelKey) },
    { value: "upstream_failed", label: t(OUTCOME_META.upstream_failed.labelKey) },
    { value: "denied", label: t(OUTCOME_META.denied.labelKey) },
  ];

  // 零数据要区分"真的没有"和"当前筛选下没有"——筛选条件非"全部"时，即便
  // 这次窗口内其实有压缩记录，也可能因为筛选而看不到任何一条，两种情况的
  // 文案不该一样，见设计文档 5.1 节。
  //
  // ★ 8.20（reviewer2 P2）：此前只判断了 `outcome`，漏了 `model`——选中一个
  // 该窗口内没有记录的型号时会显示"暂无压缩记录"，而真相是"这个型号在这个
  // 窗口里没有记录"。**两种筛选维度都会让列表空掉，判断必须都覆盖**，只列
  // 其中一个是把"当前有没有在筛"这件事只答对了一半。
  const isFiltered = eventsState.outcome !== "all" || eventsState.model !== "";

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
        />

        <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("compactColResult")}</span>
              <PillToggle options={outcomeFilterOptions} value={eventsState.outcome} onChange={eventsState.setOutcome} />
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
                <span>{t("compactFilteredBy", { label: t(OUTCOME_META[eventsState.outcome].labelKey) })}</span>
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
                          const meta = OUTCOME_META[e.outcome];
                          const isSelected = eventsState.selected?.rid === e.rid && eventsState.selected?.ts === e.ts;
                          return (
                            <button
                              key={`${e.rid}-${e.ts}`}
                              class={`w-full text-left grid grid-cols-12 items-center px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark ${isSelected ? "bg-primary/5" : ""}`}
                              onClick={() => eventsState.selectEvent(e.rid)}
                            >
                              <div class="col-span-2 text-slate-500 dark:text-text-dim font-mono">{formatTimeOnly(e.ts)}</div>
                              <div class="col-span-2">
                                <span class={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${meta.pillClass}`}>
                                  <span>{meta.icon}</span>
                                  <span>{t(meta.labelKey)}</span>
                                </span>
                              </div>
                              <div class="col-span-2 truncate font-mono text-slate-600 dark:text-text-dim">{e.model}</div>
                              {/* 列表这一列只显示总耗时（简洁，跟其它列一样是单值截断展示）；
                                  总耗时 vs 上游耗时的对比放在详情面板那一行，那里有更宽的空间。 */}
                              <div class="col-span-2 truncate font-mono text-slate-600 dark:text-text-dim">
                                {e.duration_ms !== undefined ? formatDurationMs(e.duration_ms) : "—"}
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
                  <DetailPanel event={eventsState.selected} t={t} />
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
function DetailPanel({ event: e, t }: { event: CompactOutcomeEvent; t: (key: TranslationKey, vars?: Record<string, string | number>) => string }) {
  const meta = OUTCOME_META[e.outcome];

  return (
    <div>
      <DetailGroup title={t("compactDetailGroupRecord")}>
        <DetailRow label={t("compactDetailTime")}>{formatFullTime(e.ts)}</DetailRow>
        <DetailRow label={t("compactDetailRid")}>
          <span class="font-mono">{e.rid}</span>
        </DetailRow>
        <DetailRow label={t("compactDetailResult")}>
          <span class={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${meta.pillClass}`}>
            <span>{meta.icon}</span>
            <span>{t(meta.labelKey)}</span>
          </span>
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

      {e.outcome === "budget_exceeded" && (
        <DetailGroup title={t("compactDetailGroupWhy")}>
          <DetailRow label={t("compactDetailEstTokensFull")}>{e.estimated_tokens?.toLocaleString() ?? "—"}</DetailRow>
          <DetailRow label={t("compactDetailBudgetTokensFull")}>{e.budget_tokens?.toLocaleString() ?? "—"}</DetailRow>
          {e.estimated_tokens !== undefined && e.budget_tokens !== undefined && e.budget_tokens > 0 && (
            <DetailRow label={t("compactDetailExceedPct")}>
              +{(((e.estimated_tokens - e.budget_tokens) / e.budget_tokens) * 100).toFixed(1)}%
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
          <DetailRow label={t("compactDetailReason")}>{e.reason ?? "—"}</DetailRow>
        </DetailGroup>
      )}

      <DetailGroup title={t("compactDetailGroupHow")}>
        <p class="text-xs text-slate-600 dark:text-text-dim leading-relaxed">
          {e.outcome === "budget_exceeded" && t("compactDetailHowBudgetExceeded")}
          {e.outcome === "denied" && t("compactDetailHowDenied")}
          {e.outcome === "upstream_failed" && t("compactDetailHowUpstreamFailed")}
          {e.outcome === "success" && (e.replayed ? t("compactDetailHowSuccessReplayed") : t("compactDetailHowSuccess"))}
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
          第 3 节字段清单"需新增采集"那些条目。 */}
      <DetailGroup title={t("compactDetailGroupMissing")}>
        <div class="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-700/40 rounded-lg p-2 leading-relaxed">
          {e.outcome === "success" && t("compactDetailMissingSuccess")}
          {e.outcome === "budget_exceeded" && t("compactDetailMissingBudgetExceeded")}
          {(e.outcome === "upstream_failed" || e.outcome === "denied") && t("compactDetailMissingFailure")}
        </div>
      </DetailGroup>

      {/* ★ 日志页的路由是精确字符串匹配 `location.hash`（见 App.tsx 的
          `activeTab`），不支持 `#/logs?search=...` 这种带查询串的深链接
          （会直接不匹配任何 tab、退回到概览页）——这里只跳转到日志页本身，
          不假装能带查询参数自动预填搜索框，避免一个看起来能用、实际上
          静默失效的链接。rid 就显示在这个详情面板最上面，用户手动复制过去
          搜一下即可。 */}
      <a href="#/logs" class="block text-xs font-medium text-primary hover:underline">
        {t("compactDetailJumpToLogs")}
      </a>
    </div>
  );
}
