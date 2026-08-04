import { useCompactOutcomeStats, type CompactOutcomeBreakdown, type CompactOutcome } from "../../../shared/hooks/use-compact-outcomes";
import type { UsageHistoryRange } from "../../../shared/hooks/use-usage-stats";
import type { TranslationKey } from "../../../shared/i18n/translations";
import { formatNumber } from "./UsageChart";
import { PillToggle } from "./PillToggle";

// 8.12：复用现有 usage 图表的时间窗口选项，不新发明一套（team-lead 要求）——
// 只取一个子集，"快速压缩"卡片是聚合统计不是时间序列，不需要 1h/6h 这种
// 过细的粒度，但选项本身和现有约定保持同一份来源，不重复定义数值。
const compactHoursOptions: Array<{ hours: UsageHistoryRange; label: TranslationKey }> = [
  { hours: 24, label: "last24h" },
  { hours: 168, label: "last7d" },
  { hours: 720, label: "last30d" },
  { hours: "all", label: "allHistory" },
];

/**
 * ★ 8.12/8.17：快速压缩成功率卡片——数据来自 `compact-outcome-log.ts`（8.10
 * 落盘）经 `/admin/compact-outcomes/summary` 暴露。
 *
 * ★★ 8.17：从 `UsageStats.tsx` 抽成独立组件，两处使用，不是两份实现——
 * 压缩明细面板（`CompactDetailPage.tsx`）需要这张卡片原样搬到新 tab 顶部
 * （`variant="full"`），`UsageStats.tsx` 保留一个简化入口（`variant=
 * "compact"`）——两处共用同一个 `useCompactOutcomeStats` hook 和同一份
 * 组件，不是各自实现一遍统计逻辑，避免"同一个数字两处各算一遍，口径分叉
 * 就是 bug"（这个仓库已经在别的地方吃过这个亏，见 `clampReasoningEffort
 * ToModel`/`REASONING_EFFORT_BUDGET` 那次教训）。完整取舍见
 * `compact-detail-panel-design.md` 2.4 节。
 *
 * ★★★ 8.19（reviewer2 P1 修复，真的会误导用户的 bug）：这张卡片曾经有一个
 * "按会话/按请求"的视图切换，`full` 变体默认显示 `by_session`（按
 * `conv_hash` 去重、只取每个会话窗口内最后一条 outcome）。但下方明细列表
 * （`CompactDetailPage.tsx`）从来都是**原始事件、不做会话去重**的——同一
 * 会话连续 5 次 `budget_exceeded` 后 1 次 `success`，`by_session` 只算"1 个
 * 会话、成功"，列表却有 6 条、其中 5 条能被"预判降级"筛出来。这正是
 * team-lead 一直强调要防的"汇总说 4 次降级、列表里对不上"，只是方向反了
 * （这次是汇总说 0、列表有 5 条）。
 *
 * 修复方式不是"让列表也做会话聚合"（那是另一个功能，仓库里目前没有"一行
 * 代表一个会话"的详情语义），而是**两个卡片各自内部自洽、不再共用一套
 * "视图"概念**：
 * - `variant="compact"`（`UsageStats.tsx` 的入口卡片）= 体验视角，固定用
 *   `by_session`——"我的压缩好不好使"，198 次重试后 1 次成功应该算这个
 *   会话成功，不是失败率 99.5%。这张卡片没有下方明细列表联动，不存在
 *   "数字对不上"的风险。
 * - `variant="full"`（压缩明细页顶部）= 取证视角，固定用 `by_request`——
 *   和下方原始事件列表天然是同一个计数口径，`events.total` 恒等于
 *   `by_request.total`（`compact-outcome-log.test.ts` 的不变量测试锁住）。
 *
 * 不再提供"切换视图"这个 UI——切过去之后列表依旧是原始事件，对不上的
 * 问题不会因为多了个切换按钮而消失，反而制造"这个开关到底控制什么"的
 * 新困惑。`full` 变体固定按请求口径下方加一行说明文字，用户能看到口径、
 * 但不能切错。
 *
 * `variant="full"`（默认，用于新 tab）：
 * - 时间窗口切换（`hours`/`onHoursChange` 受控于父组件——设计要求汇总区
 *   和下方明细列表共用同一个时间窗口控件，不能是这张卡片自己管理的内部
 *   状态）。
 * - 四类结果都可点击（`onSelectOutcome`），点击后父组件把明细列表的结果
 *   类型筛选设成对应值——这是"汇总的 4 次预判降级，点一下就能在下面列表
 *   里看到对应的 4 条"这个联动的落地方式。★ 8.17 之前 `budget_exceeded`
 *   一行是"点击展开内联预览最近几条"，现在有了下方的完整明细列表，内联
 *   预览是冗余交互（同一次点击不能既展开预览又筛选列表，语义会打架），
 *   改成统一的"点击=筛选下方列表"。★ 结果类型筛选**刻意不反向联动**汇总
 *   区——汇总必须始终显示全貌，被筛窄了就失去"从全貌下钻某一类"的意义
 *   （和型号筛选的联动方向刻意相反，`compact-detail-panel-design.md`
 *   2.5 节论证过）。`activeOutcome` 只用来给当前选中的那一行加高亮，不
 *   改变汇总数字本身。
 * - `model`：可选型号过滤，透传给 `useCompactOutcomeStats`，用于和下方
 *   明细列表的型号筛选联动——不传时是"全部型号"的合计。
 * - `activeOutcome`：当前明细列表的结果类型筛选值（`"all"` 或具体
 *   outcome），**只用于视觉高亮**对应的那一行（"哪一类被筛中了"一眼可见，
 *   不是"点了但看不出选没选中"），不影响汇总数字。
 *
 * `variant="compact"`（用于 `UsageStats.tsx`）：固定最近 24 小时、不显示
 * 时间窗口切换、不显示四行明细，只有成功率大数字 + 总数 +（有预判降级时）
 * 一行提示 + "查看详情 →" 跳转新 tab。
 */
export function CompactOutcomesCard({
  t,
  variant = "full",
  hours,
  onHoursChange,
  model,
  activeOutcome,
  onSelectOutcome,
  activeCompactPath,
  onSelectRenderOutcome,
}: {
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  variant?: "full" | "compact";
  hours: UsageHistoryRange;
  onHoursChange?: (h: UsageHistoryRange) => void;
  model?: string | null;
  // ★ task #109：加宽到含 `"render_completed"`——这个值曾经在这个组件的
  // 世界观里不存在（汇总卡片本次拍板不接入 render 维度），现在render 组
  // 上线了，调用方（`CompactDetailPage.tsx`）传的 `eventsState.outcome`
  // 本来就可能是这个值，不用再在调用方那边转换成 `undefined` 藏起来。
  activeOutcome?: CompactOutcome | "render_completed" | "all";
  onSelectOutcome?: (outcome: CompactOutcome) => void;
  /**
   * ★ task #109（backend-dev 追加落地，team-lead 明确要求"排除
   * fallback_render 的附加条件是并列展示 render 组数字"）：只对
   * `variant="full"` 有意义——当前明细列表的压缩路径筛选值，只用来给
   * render 分组里"选中"的那一行加高亮，跟 `activeOutcome` 是同一套用途，
   * 不影响汇总数字本身。之所以需要单独一个 prop（不能只靠 `activeOutcome`
   * 判断）：`upstream_failed` 这个 outcome 值在 opaque 分组（来自
   * fallback_decision）和 render 分组（来自 fallback_render）都可能出现，
   * 只看 `activeOutcome === "upstream_failed"` 没法区分用户筛的是哪一组，
   * 会导致两个不相关的行同时被高亮。
   */
  activeCompactPath?: string;
  /**
   * ★ task #109：render 分组两行的点击回调——跟 `onSelectOutcome` 分开，
   * 不复用同一个函数，是因为点击 render 分组的行不只是设置 outcome，还
   * 必须同时把压缩路径筛选钉死在 `"fallback_render"`（否则"降级重试的
   * upstream_failed"点出来的列表会混进 fallback_decision 那组不相关的
   * 失败记录，用户点了却看到一堆看不懂是什么的行）。
   */
  onSelectRenderOutcome?: (outcome: "render_completed" | "upstream_failed") => void;
}) {
  const { stats, loading } = useCompactOutcomeStats(hours, variant === "full" ? model : undefined);

  // ★ 8.19：不再有可切换的"视图"——每个变体固定用哪个口径是它自己的语义
  // 决定的，不是用户可调的选项（见上面头部注释的完整推理）。
  const breakdown: CompactOutcomeBreakdown | null =
    stats === null ? null : variant === "compact" ? stats.by_session : stats.by_request;
  const hasData = breakdown !== null && breakdown.total > 0;

  // ★ task #109：render 分组的展示状态跟上面的 opaque `breakdown`/`hasData`
  // 完全独立算——两组理论上可能一个有数据一个没有（比如这个窗口里 opaque
  // 全部走通、一次都没降级），不能让 opaque 那边"没数据"顺带把 render 组
  // 也吞掉，也不能反过来。`stats.render` 缺省（旧后端，这次改动还没部署到
  // 的环境）时整块不渲染，不是显示成"没数据"——那是两件不同的事："这个
  // 功能还没上线"和"这个功能上线了但这个窗口恰好没有降级"。
  const renderBreakdown = variant === "full" ? stats?.render?.by_request ?? null : null;
  const hasRenderData = renderBreakdown !== null && renderBreakdown.total > 0;
  // ★★ backend-dev 原话："success_rate 这个字段名字是 success_rate，实际
  // 算的是 success/total，render 组永远没有 success（只有
  // render_completed），这个字段对 render 组没有意义，请不要直接展示
  // 它"——自己拿 render_completed/total 现算，不读 `renderBreakdown.
  // success_rate`。
  const renderCompletionRate = renderBreakdown !== null && renderBreakdown.total > 0
    ? renderBreakdown.render_completed / renderBreakdown.total
    : 0;

  if (variant === "compact") {
    return (
      <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4 mb-6">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-text-main mb-3">
          {t("compactOutcomesTitle")}
        </h3>
        {loading ? (
          <div class="text-center py-4 text-slate-400 dark:text-text-dim text-sm">Loading...</div>
        ) : !hasData ? (
          <div class="text-center py-4 text-slate-400 dark:text-text-dim text-sm">{t("compactNoData")}</div>
        ) : (
          <>
            <div class="text-center mb-2">
              <div class="text-3xl font-bold text-slate-800 dark:text-text-main">
                {Math.round(breakdown.success_rate * 100)}%
              </div>
              <div class="text-xs text-slate-500 dark:text-text-dim mt-1">
                {formatNumber(breakdown.success)} / {formatNumber(breakdown.total)} · {t("last24h")}
              </div>
            </div>
            {breakdown.budget_exceeded > 0 && (
              <div class="text-center text-xs text-amber-600 dark:text-amber-400">
                ⚠️ {t("compactBudgetExceededCount", { count: breakdown.budget_exceeded })}
              </div>
            )}
          </>
        )}
        <a
          href="#/compact-detail"
          class="block text-center text-xs font-medium text-primary hover:underline mt-3"
        >
          {t("compactViewDetail")} →
        </a>
      </div>
    );
  }

  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4 mb-6">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-text-main">
          {t("compactOutcomesTitle")}
        </h3>
        <div class="flex flex-wrap gap-2">
          <PillToggle
            options={compactHoursOptions.map(({ hours: h, label }) => ({ value: h, label: t(label) }))}
            value={hours}
            onChange={(h) => onHoursChange?.(h)}
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
            <CompactOutcomeRow
              icon="✅"
              label={t("compactOutcomeSuccess")}
              count={breakdown.success}
              active={activeOutcome === "success"}
              onClick={onSelectOutcome ? () => onSelectOutcome("success") : undefined}
            />
            <CompactOutcomeRow
              icon="⚠️"
              label={t("compactOutcomeBudgetExceeded")}
              count={breakdown.budget_exceeded}
              active={activeOutcome === "budget_exceeded"}
              onClick={onSelectOutcome ? () => onSelectOutcome("budget_exceeded") : undefined}
            />
            <CompactOutcomeRow
              icon="❌"
              label={t("compactOutcomeUpstreamFailed")}
              count={breakdown.upstream_failed}
              // ★ task #109：`upstream_failed` 这个 outcome 值在 opaque
              // 分组（来自 fallback_decision）和下面新增的 render 分组
              // （来自 fallback_render）都可能出现——只判断
              // `activeOutcome === "upstream_failed"` 会让两个不相关的行
              // 同时高亮，必须再看 `activeCompactPath` 排除掉"用户其实筛的
              // 是 render 分组那条"这种情况。
              active={activeOutcome === "upstream_failed" && activeCompactPath !== "fallback_render"}
              onClick={onSelectOutcome ? () => onSelectOutcome("upstream_failed") : undefined}
            />
            <CompactOutcomeRow
              icon="🛑"
              label={t("compactOutcomeDenied")}
              count={breakdown.denied}
              active={activeOutcome === "denied"}
              onClick={onSelectOutcome ? () => onSelectOutcome("denied") : undefined}
            />
          </div>

          {/* ★ 8.19：固定按请求口径，不再是"按会话时才提示"——见头部注释。 */}
          <div class="mt-3 flex items-start gap-1 text-[11px] text-slate-400 dark:text-text-dim">
            <span>ⓘ</span>
            <span>{t("compactCountingBasisRequest")}</span>
          </div>
        </>
      )}

      {/* ★ task #109（backend-dev 追加落地，team-lead 明确要求）：并列展示
          "降级重试"这组数字——跟上面 opaque 那组**完全独立**渲染（不嵌套在
          `hasData` 分支里），理由见 `renderBreakdown`/`hasRenderData` 声明
          处的注释。`stats.render` 缺省（旧后端）时整块不出现，不是显示成
          "没数据"。
          ★★ 两条硬要求都在这里落地：
          1. 同屏可见，不用切换视图——这个 section 就在上面那组下方，同一
             张卡片里。
          2. 分母写清楚，不能让用户自己脑补——大字号数字旁边直接拼出
             "{completed} of {total} completed" 这种带分母的句子（不是只有
             一个孤立的百分比），另外 `compactRenderCountingBasisHint` 那行
             提示明确点破"这组的分母跟上面不是一回事，不能直接比"。 */}
      {!loading && stats?.render && (
        <div class="mt-4 pt-4 border-t border-gray-200 dark:border-border-dark">
          <h4 class="text-xs font-semibold text-slate-600 dark:text-text-dim mb-2">
            {t("compactRenderGroupTitle")}
          </h4>
          {!hasRenderData ? (
            <div class="text-center py-2 text-slate-400 dark:text-text-dim text-xs">{t("compactNoData")}</div>
          ) : (
            <>
              <div class="text-center mb-2">
                <div class="text-2xl font-bold text-slate-800 dark:text-text-main">
                  {Math.round(renderCompletionRate * 100)}%
                </div>
                <div class="text-xs text-slate-500 dark:text-text-dim mt-1">
                  {t("compactRenderSummary", { completed: renderBreakdown!.render_completed, total: renderBreakdown!.total })}
                </div>
              </div>

              <div class="space-y-0.5">
                <CompactOutcomeRow
                  icon="✅"
                  label={t("compactOutcomeRenderCompleted")}
                  count={renderBreakdown!.render_completed}
                  active={activeCompactPath === "fallback_render" && activeOutcome === "render_completed"}
                  onClick={onSelectRenderOutcome ? () => onSelectRenderOutcome("render_completed") : undefined}
                />
                <CompactOutcomeRow
                  icon="❌"
                  label={t("compactOutcomeUpstreamFailed")}
                  count={renderBreakdown!.upstream_failed}
                  active={activeCompactPath === "fallback_render" && activeOutcome === "upstream_failed"}
                  onClick={onSelectRenderOutcome ? () => onSelectRenderOutcome("upstream_failed") : undefined}
                />
              </div>

              <div class="mt-2 flex items-start gap-1 text-[11px] text-slate-400 dark:text-text-dim">
                <span>ⓘ</span>
                <span>{t("compactRenderCountingBasisHint")}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CompactOutcomeRow({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      class={`flex items-center justify-between py-1.5 px-1 rounded-lg text-sm border ${
        active
          ? "border-primary/40 bg-primary/5 dark:bg-primary/10"
          : `border-transparent ${onClick ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5" : ""}`
      }`}
      onClick={onClick}
    >
      <span class="flex items-center gap-2 text-slate-600 dark:text-text-dim">
        <span>{icon}</span>
        <span>{label}</span>
      </span>
      <span class="flex items-center gap-1 text-slate-800 dark:text-text-main font-medium">
        {formatNumber(count)}
        {onClick && (
          <span class="text-slate-400 dark:text-text-dim text-xs">›</span>
        )}
      </span>
    </div>
  );
}
