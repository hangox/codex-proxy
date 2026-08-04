/**
 * Hook for the opaque compact "quick compaction success rate" Dashboard card.
 *
 * Mirrors `use-usage-stats.ts`'s fetch/poll pattern deliberately — same
 * timeout guard, same polling shape — so the two cards behave consistently
 * and there's only one convention for the rest of the dashboard to follow.
 */

import { useState, useEffect, useCallback } from "preact/hooks";

export type CompactOutcome = "success" | "budget_exceeded" | "upstream_failed" | "denied";

export interface CompactOutcomeBreakdown {
  success: number;
  budget_exceeded: number;
  upstream_failed: number;
  denied: number;
  /**
   * ★ task #109（backend-dev 追加落地）：这个 outcome 只会来自
   * `compact_path === "fallback_render"` 的记录。在顶层 `by_request`/
   * `by_session`（"opaque 压缩成功率"这张卡片一直用的口径）里恒为 0——
   * 那两个字段默认排除 fallback_render，是刻意保住既有指标定义不被稀释，
   * 不是这个字段没接上。真正有意义的地方是 `CompactOutcomeStats.render`
   * 那组并列数据。
   */
  render_completed: number;
  total: number;
  /**
   * ★★ task #109：`CompactOutcomeStats.render` 那组里，这个字段名字虽然
   * 叫 `success_rate`，算的却恒是 `success / total`——而 render 组永远没有
   * `success`（只有 `render_completed`），所以这个字段对 render 组**没有
   * 意义**，前端不能直接展示它。render 组的"完成率"要自己拿
   * `render_completed / total` 现算（见 `CompactOutcomesCard.tsx`），
   * backend-dev 原话："请不要直接展示它"。
   */
  success_rate: number;
}

export interface CompactOutcomeStats {
  by_request: CompactOutcomeBreakdown;
  by_session: CompactOutcomeBreakdown;
  recent_budget_exceeded: Array<{
    ts: string;
    rid: string;
    model: string;
    estimated_tokens?: number;
    budget_tokens?: number;
  }>;
  /**
   * ★ task #109（backend-dev 追加落地，team-lead 批准"summary 默认排除
   * fallback_render"时的附加条件）：跟顶层 `by_request`/`by_session` 并列
   * 的第二组数据——"降级之后那次重试，救回来多少"。跟顶层用同一次请求、
   * 同一套 `hours`/`model` 筛选返回，不需要前端再单独发一次
   * `compact_path=fallback_render` 的请求。
   *
   * `render.by_request.success`/`budget_exceeded`/`denied` 恒为 0
   * （fallback_render 路径不会产生这几种 outcome，只有 `render_completed`/
   * `upstream_failed` 有意义）。没有 `recent_budget_exceeded`——不适用。
   *
   * 可选字段：旧版本后端（这次改动之前）的响应体没有这个键，前端必须
   * 当"这个功能还没上线"处理（不显示 render 分组），不能假设它总是存在。
   */
  render?: {
    by_request: CompactOutcomeBreakdown;
    by_session: CompactOutcomeBreakdown;
  };
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * ★ 8.17：新增可选 `model` 参数——压缩明细面板要求汇总区和明细列表共用
 * 同一套筛选参数（含型号），否则用户按型号筛列表后，汇总区数字还是全部
 * 型号的合计，会造成"看到 N 次降级、列表里对不上"的误判。不传（或传
 * `null`/空字符串）时行为和之前完全一样——`UsageStats.tsx` 里的简化卡片
 * 不需要型号筛选，继续调用 `useCompactOutcomeStats(24)` 不用改。
 */
export function useCompactOutcomeStats(
  hours: number | "all",
  model?: string | null,
  refreshIntervalMs = 30_000,
) {
  const [stats, setStats] = useState<CompactOutcomeStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ hours: String(hours) });
      if (model) params.set("model", model);
      const resp = await fetch(`/admin/compact-outcomes/summary?${params.toString()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) setStats(await resp.json());
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, [hours, model]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return { stats, loading };
}
