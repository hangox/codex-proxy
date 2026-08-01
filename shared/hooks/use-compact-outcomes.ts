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

export function useCompactOutcomeStats(hours: number | "all", refreshIntervalMs = 30_000) {
  const [stats, setStats] = useState<CompactOutcomeStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`/admin/compact-outcomes/summary?hours=${hours}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) setStats(await resp.json());
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, [hours]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return { stats, loading };
}
