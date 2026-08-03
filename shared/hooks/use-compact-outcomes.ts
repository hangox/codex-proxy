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
  total: number;
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
