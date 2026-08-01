import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useUsageSummary, useUsageHistory, type Granularity, type UsageHistoryRange } from "../../../shared/hooks/use-usage-stats";
import { useCompactOutcomeStats, type CompactOutcomeBreakdown } from "../../../shared/hooks/use-compact-outcomes";
import { UsageChart, formatNumber, formatHitRate, sumUsageWindow, sumWindow } from "../components/UsageChart";
import type { TranslationKey } from "../../../shared/i18n/translations";

// 8.12：复用现有 usage 图表的时间窗口选项，不新发明一套（team-lead 要求）——
// 只取一个子集，"快速压缩"卡片是聚合统计不是时间序列，不需要 1h/6h 这种
// 过细的粒度，但选项本身和现有约定保持同一份来源，不重复定义数值。
const compactHoursOptions: Array<{ hours: UsageHistoryRange; label: TranslationKey }> = [
  { hours: 24, label: "last24h" },
  { hours: 168, label: "last7d" },
  { hours: 720, label: "last30d" },
  { hours: "all", label: "allHistory" },
];

const granularityOptions: Array<{ value: Granularity; label: TranslationKey }> = [
  { value: "five_min", label: "granularityFiveMin" },
  { value: "hourly", label: "granularityHourly" },
  { value: "daily", label: "granularityDaily" },
];

const rangeOptions: Array<{ hours: UsageHistoryRange; label: TranslationKey }> = [
  { hours: 1, label: "last1h" },
  { hours: 6, label: "last6h" },
  { hours: 24, label: "last24h" },
  { hours: 72, label: "last3d" },
  { hours: 168, label: "last7d" },
  { hours: 720, label: "last30d" },
  { hours: 2160, label: "last90d" },
  { hours: "all", label: "allHistory" },
];

function UsageContent({ t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading }: {
  t: (key: TranslationKey) => string;
  summary: ReturnType<typeof useUsageSummary>["summary"];
  summaryLoading: boolean;
  granularity: Granularity;
  setGranularity: (g: Granularity) => void;
  hours: UsageHistoryRange;
  setHours: (h: UsageHistoryRange) => void;
  dataPoints: ReturnType<typeof useUsageHistory>["dataPoints"];
  historyLoading: boolean;
}) {
  const rangeWindow = sumWindow(dataPoints);
  const usageWindow = sumUsageWindow(dataPoints);
  const rangeHitRate = historyLoading ? "—" : formatHitRate(rangeWindow.cached, rangeWindow.input);
  const rangeHint = historyLoading
    ? undefined
    : t("cacheHitRateHint")
        .replace("{cached}", formatNumber(rangeWindow.cached))
        .replace("{input}", formatNumber(rangeWindow.input));

  return (
    <>
      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-8 gap-3 mb-6">
        <SummaryCard
          label={t("totalInputTokens")}
          value={historyLoading ? "—" : formatNumber(usageWindow.input_tokens)}
        />
        <SummaryCard
          label={t("totalOutputTokens")}
          value={historyLoading ? "—" : formatNumber(usageWindow.output_tokens)}
        />
        <SummaryCard
          label={t("cacheHitRate")}
          value={summaryLoading ? "—" : formatHitRate(summary?.total_cached_tokens ?? 0, summary?.total_input_tokens ?? 0)}
          hint={
            summaryLoading
              ? undefined
              : t("cacheHitRateHint")
                  .replace("{cached}", formatNumber(summary?.total_cached_tokens ?? 0))
                  .replace("{input}", formatNumber(summary?.total_input_tokens ?? 0))
          }
        />
        <SummaryCard
          label={t("rangeHitRate")}
          value={rangeHitRate}
          hint={rangeHint ?? t("rangeHitRateHint")}
        />
        <SummaryCard
          label={t("imageTokens")}
          value={
            historyLoading
              ? "—"
              : `${formatNumber(usageWindow.image_input_tokens)} / ${formatNumber(usageWindow.image_output_tokens)}`
          }
          hint={historyLoading ? undefined : t("imageTokensHint")}
        />
        <SummaryCard
          label={t("imageRequests")}
          value={
            historyLoading
              ? "—"
              : `${formatNumber(usageWindow.image_request_count)} / ${formatNumber(usageWindow.image_request_failed_count)}`
          }
          hint={
            historyLoading
              ? undefined
              : t("imageRequestsHint")
                  .replace("{ok}", formatNumber(usageWindow.image_request_count))
                  .replace("{failed}", formatNumber(usageWindow.image_request_failed_count))
          }
        />
        <SummaryCard
          label={t("totalRequestCount")}
          value={historyLoading ? "—" : formatNumber(usageWindow.request_count)}
        />
        <SummaryCard
          label={t("activeAccounts")}
          value={summaryLoading ? "—" : `${summary?.active_accounts ?? 0} / ${summary?.total_accounts ?? 0}`}
        />
      </div>

      <CompactOutcomesCard t={t} />

      {/* Controls */}
      <div class="flex flex-wrap gap-2 mb-4">
        {granularityOptions.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => {
              setGranularity(value);
              // Daily with ≤24h produces a single bucket — auto-switch to 3d.
              if (value === "daily" && typeof hours === "number" && hours <= 24) setHours(72);
              // Hourly with <6h has too few buckets — bump to 24h.
              if (value === "hourly" && typeof hours === "number" && hours < 6) setHours(24);
              // 5-min with >24h is a lot of buckets — clamp to 24h.
              if (value === "five_min" && (hours === "all" || hours > 24)) setHours(24);
            }}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              granularity === value
                ? "bg-primary-action text-white border-primary-action"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
        <div class="w-px h-5 bg-gray-200 dark:bg-border-dark self-center" />
        {rangeOptions
          .filter(({ hours: h }) => {
            if (granularity === "daily" && typeof h === "number" && h <= 24) return false;
            if (granularity === "hourly" && typeof h === "number" && h < 6) return false;
            if (granularity === "five_min" && (h === "all" || h > 24)) return false;
            return true;
          })
          .map(({ hours: h, label }) => (
          <button
            key={h}
            onClick={() => setHours(h)}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              hours === h
                ? "bg-primary-action text-white border-primary-action"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
        {historyLoading ? (
          <div class="text-center py-12 text-slate-400 dark:text-text-dim text-sm">Loading...</div>
        ) : (
          <UsageChart data={dataPoints} />
        )}
      </div>
    </>
  );
}

export function UsageStats({ embedded }: { embedded?: boolean } = {}) {
  const t = useT();
  const { summary, loading: summaryLoading } = useUsageSummary();
  const [granularity, setGranularity] = useState<Granularity>("hourly");
  const [hours, setHours] = useState<UsageHistoryRange>(24);
  const { dataPoints, loading: historyLoading } = useUsageHistory(granularity, hours);

  const contentProps = { t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading };

  if (embedded) {
    return (
      <div class="flex flex-col gap-4">
        <UsageContent {...contentProps} />
      </div>
    );
  }

  return (
    <div class="min-h-screen bg-slate-50 dark:bg-bg-dark flex flex-col">
      <header class="sticky top-0 z-50 bg-white dark:bg-card-dark border-b border-gray-200 dark:border-border-dark px-4 py-3">
        <div class="max-w-[1100px] mx-auto flex items-center gap-3">
          <a
            href="#/"
            class="text-sm text-slate-500 dark:text-text-dim hover:text-primary transition-colors"
          >
            &larr; {t("backToDashboard")}
          </a>
          <h1 class="text-base font-semibold text-slate-800 dark:text-text-main">
            {t("usageStats")}
          </h1>
        </div>
      </header>

      <main class="flex-grow px-4 md:px-8 py-6 max-w-[1100px] mx-auto w-full">
        <UsageContent {...contentProps} />
      </main>
    </div>
  );
}

/**
 * ★ 8.12：快速压缩成功率卡片——数据来自 `compact-outcome-log.ts`（8.10
 * 落盘）经 `/admin/compact-outcomes/summary` 暴露。
 *
 * 设计要点（team-lead 规格，逐条对应）：
 * - 默认「按会话」口径（体验视角，"我的压缩好不好使"），可切「按请求」。
 * - 「预判降级」这一行是整张卡片最有价值的部分——terra 那次真实误判就是
 *   靠 `estimated_tokens`/`budget_tokens` 这两个数发现"降级不是真超了，
 *   是估算高估了"，所以这一行必须能展开看明细，不能只有一个数字。
 * - 按会话口径下，隐私限制说明（conv_hash 跨进程重启不稳定）必须在 UI
 *   上可见，不能只留在代码注释里——这是看这个数字的人需要知道的精度边界。
 * - 零数据时显示"暂无数据"，不要显示 0/0 算出来的 "0%"——那会被误读成
 *   "全部失败"，是最糟的误导。
 */
function CompactOutcomesCard({ t }: { t: (key: TranslationKey) => string }) {
  const [view, setView] = useState<"session" | "request">("session");
  const [hours, setHours] = useState<UsageHistoryRange>(24);
  const [budgetExceededExpanded, setBudgetExceededExpanded] = useState(false);
  const { stats, loading } = useCompactOutcomeStats(hours);

  const breakdown: CompactOutcomeBreakdown | null =
    stats === null ? null : view === "session" ? stats.by_session : stats.by_request;
  const hasData = breakdown !== null && breakdown.total > 0;

  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4 mb-6">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-text-main">
          {t("compactOutcomesTitle")}
        </h3>
        <div class="flex flex-wrap gap-2">
          <PillToggle
            options={[
              { value: "session" as const, label: t("compactViewBySession") },
              { value: "request" as const, label: t("compactViewByRequest") },
            ]}
            value={view}
            onChange={setView}
          />
          <PillToggle
            options={compactHoursOptions.map(({ hours: h, label }) => ({ value: h, label: t(label) }))}
            value={hours}
            onChange={setHours}
          />
        </div>
      </div>

      {loading ? (
        <div class="text-center py-8 text-slate-400 dark:text-text-dim text-sm">Loading...</div>
      ) : !hasData ? (
        <div class="text-center py-8 text-slate-400 dark:text-text-dim text-sm">{t("compactNoData")}</div>
      ) : (
        <>
          <div class="text-center mb-4">
            <div class="text-3xl font-bold text-slate-800 dark:text-text-main">
              {Math.round(breakdown.success_rate * 100)}%
            </div>
            <div class="text-xs text-slate-500 dark:text-text-dim mt-1">
              {formatNumber(breakdown.success)} / {formatNumber(breakdown.total)}
            </div>
          </div>

          <div class="space-y-0.5">
            <CompactOutcomeRow icon="✅" label={t("compactOutcomeSuccess")} count={breakdown.success} />
            <CompactOutcomeRow
              icon="⚠️"
              label={t("compactOutcomeBudgetExceeded")}
              count={breakdown.budget_exceeded}
              expandable={breakdown.budget_exceeded > 0}
              expanded={budgetExceededExpanded}
              onToggle={() => setBudgetExceededExpanded((v) => !v)}
            />
            {budgetExceededExpanded && stats && stats.recent_budget_exceeded.length > 0 && (
              <div class="pl-7 pb-1 space-y-0.5">
                {stats.recent_budget_exceeded.map((entry) => (
                  <div key={entry.rid} class="text-[11px] text-slate-500 dark:text-text-dim">
                    {entry.model} — {t("compactEstTokens")} {formatNumber(entry.estimated_tokens ?? 0)} / {t("compactBudgetTokens")}{" "}
                    {formatNumber(entry.budget_tokens ?? 0)}
                  </div>
                ))}
              </div>
            )}
            <CompactOutcomeRow icon="❌" label={t("compactOutcomeUpstreamFailed")} count={breakdown.upstream_failed} />
            <CompactOutcomeRow icon="🛑" label={t("compactOutcomeDenied")} count={breakdown.denied} />
          </div>

          {view === "session" && (
            <div class="mt-3 flex items-start gap-1 text-[11px] text-slate-400 dark:text-text-dim">
              <span>ⓘ</span>
              <span>{t("compactSessionHint")}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CompactOutcomeRow({
  icon,
  label,
  count,
  expandable,
  expanded,
  onToggle,
}: {
  icon: string;
  label: string;
  count: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      class={`flex items-center justify-between py-1.5 px-1 rounded-lg text-sm ${
        expandable ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5" : ""
      }`}
      onClick={expandable ? onToggle : undefined}
    >
      <span class="flex items-center gap-2 text-slate-600 dark:text-text-dim">
        <span>{icon}</span>
        <span>{label}</span>
      </span>
      <span class="flex items-center gap-1 text-slate-800 dark:text-text-main font-medium">
        {formatNumber(count)}
        {expandable && (
          <span class="text-slate-400 dark:text-text-dim text-xs">{expanded ? "▴" : "›"}</span>
        )}
      </span>
    </div>
  );
}

/** 通用胶囊按钮组——和 UsageContent 里 granularity/range 现有的样式保持一致，不新发明一套视觉语言。 */
function PillToggle<V extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: V; label: string }>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div class="flex gap-1">
      {options.map(({ value: v, label }) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
            value === v
              ? "bg-primary-action text-white border-primary-action"
              : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
      <div class="text-xs text-slate-500 dark:text-text-dim mb-1">{label}</div>
      <div class="text-lg font-semibold text-slate-800 dark:text-text-main">{value}</div>
      {hint && <div class="mt-1 text-[11px] text-slate-400 dark:text-text-dim truncate">{hint}</div>}
    </div>
  );
}
