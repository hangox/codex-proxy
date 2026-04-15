import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export type LogFilterDirection = "ingress" | "egress" | "all";

export interface LogRecord {
  id: string;
  requestId: string;
  direction: "ingress" | "egress";
  ts: string;
  method: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  status?: number | null;
  latencyMs?: number | null;
  stream?: boolean | null;
  error?: string | null;
  request?: unknown;
  response?: unknown;
}

export interface LogState {
  enabled: boolean;
  paused: boolean;
  dropped: number;
  size: number;
  capacity: number;
}

export function useLogs(refreshIntervalMs = 1500) {
  const [direction, setDirection] = useState<LogFilterDirection>("all");
  const [search, setSearch] = useState("");
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<LogState | null>(null);
  const [selected, setSelected] = useState<LogRecord | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (nextPage = page) => {
    try {
      const params = new URLSearchParams({
        direction,
        search: search.trim(),
        limit: String(pageSize),
        offset: String(nextPage * pageSize),
      });
      const resp = await fetch(`/admin/logs?${params.toString()}`);
      if (resp.ok) {
        const body = await resp.json();
        setRecords(body.records);
        setTotal(body.total);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [direction, search, page, pageSize]);

  const loadState = useCallback(async () => {
    try {
      const resp = await fetch("/admin/logs/state");
      if (resp.ok) setState(await resp.json());
    } catch { /* ignore */ }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(page);
    loadState();
    clearTimer();

    const tick = () => {
      if (!document.hidden) {
        load(page);
        loadState();
      }
    };

    timerRef.current = setInterval(tick, refreshIntervalMs);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, loadState, page, refreshIntervalMs, clearTimer]);

  const setLogState = useCallback(async (patch: Partial<Pick<LogState, "enabled" | "paused">>) => {
    const resp = await fetch("/admin/logs/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (resp.ok) setState(await resp.json());
  }, []);

  const selectLog = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/admin/logs/${id}`);
      if (resp.ok) setSelected(await resp.json());
    } catch { /* ignore */ }
  }, []);

  const nextPage = useCallback(() => setPage((p) => p + 1), []);
  const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);

  useEffect(() => {
    load(page);
  }, [page, load]);

  return {
    direction,
    setDirection,
    search,
    setSearch,
    records,
    total,
    loading,
    state,
    setLogState,
    selected,
    selectLog,
    page,
    pageSize,
    nextPage,
    prevPage,
    hasNext: (page + 1) * pageSize < total,
    hasPrev: page > 0,
  };
}
