/**
 * ★ 8.17：压缩明细面板的列表数据源——`GET /admin/compact-outcomes/events`。
 *
 * 模式照抄 `use-logs.ts` 的 `useLogs`（同一套 fetch/分页/选中状态管理
 * 约定），额外多了一个"时间窗口跟外部（汇总区）共享"的诉求：`hours` 由
 * 调用方传入而不是这个 hook 自己管理状态——设计文档 2.5 节要求汇总区和
 * 明细列表用同一个时间窗口控件驱动两次独立的 fetch，`hours` 因此必须是
 * 外部受控的，不能是这个 hook 内部的 `useState`。
 */

import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { CompactOutcome } from "./use-compact-outcomes";

export interface CompactOutcomeEvent {
  ts: string;
  rid: string;
  conv_hash: string | null;
  model: string;
  outcome: CompactOutcome;
  replayed?: boolean;
  estimated_tokens?: number;
  budget_tokens?: number;
  reason?: string;
}

export type CompactOutcomeFilter = CompactOutcome | "all";

/**
 * 切筛选条件（结果类型/型号/会话搜索/时间窗口）时自动回到第一页、清空
 * 选中项——和 `normalizeLogsQueryState` 同一套语义，这里独立实现是因为
 * 筛选维度不同（多了 outcome/model，少了 direction），字段对不上没法
 * 直接复用同一个泛型函数，但设计意图一致。
 */
export function normalizeCompactEventsQueryState<T>(
  prev: { outcome: CompactOutcomeFilter; model: string; search: string; hours: number | "all"; page: number; selected: T | null },
  next: { outcome?: CompactOutcomeFilter; model?: string; search?: string; hours?: number | "all"; page?: number },
): { outcome: CompactOutcomeFilter; model: string; search: string; hours: number | "all"; page: number; selected: T | null } {
  const outcome = next.outcome ?? prev.outcome;
  const model = next.model ?? prev.model;
  const search = next.search ?? prev.search;
  const hours = next.hours ?? prev.hours;
  const page = next.page ?? prev.page;
  const queryChanged = outcome !== prev.outcome || model !== prev.model || search !== prev.search || hours !== prev.hours;
  const pageChanged = page !== prev.page;
  return {
    outcome,
    model,
    search,
    hours,
    page: queryChanged ? 0 : page,
    selected: queryChanged || pageChanged ? null : prev.selected,
  };
}

const FETCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 50;

export function useCompactOutcomeEvents(hours: number | "all", refreshIntervalMs = 15_000) {
  const [outcome, setOutcomeState] = useState<CompactOutcomeFilter>("all");
  const [model, setModelState] = useState("");
  const [search, setSearchState] = useState("");
  const [events, setEvents] = useState<CompactOutcomeEvent[]>([]);
  const [total, setTotal] = useState(0);
  // ★ 8.18：型号筛选下拉框的选项来源——后端只按时间窗口过滤，不因当前
  // outcome/model 筛选而收窄（见 `compact-outcome-log.ts` 的同名字段注释），
  // 这里原样透传，不在前端另外做二次收窄。
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CompactOutcomeEvent | null>(null);
  const [page, setPageState] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (nextPage: number) => {
    try {
      const params = new URLSearchParams({
        hours: String(hours),
        limit: String(PAGE_SIZE),
        offset: String(nextPage * PAGE_SIZE),
      });
      if (outcome !== "all") params.set("outcome", outcome);
      if (model.trim()) params.set("model", model.trim());
      // 会话搜索（按 conv_hash 前缀）是服务端过滤（`conv_hash_prefix`
      // 参数），不是只对当前这一页数据做本地过滤——conv_hash 本身是不可逆
      // 哈希，没有"模糊搜索"这个概念，只有"前缀匹配"，但仍然需要在分页
      // 之前应用，否则匹配到的记录可能落在别的页，用户在当前页搜不到会
      // 误以为没有这个会话的记录。
      if (search.trim()) params.set("conv_hash_prefix", search.trim());
      const resp = await fetch(`/admin/compact-outcomes/events?${params.toString()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        const body = await resp.json();
        setEvents(body.events);
        setTotal(body.total);
        setAvailableModels(body.availableModels ?? []);
      }
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, [hours, outcome, model, search]);

  const setOutcome = useCallback((nextOutcome: CompactOutcomeFilter) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, search, hours, page, selected }, { outcome: nextOutcome });
    setPageState(next.page);
    setSelected(next.selected);
    setOutcomeState(next.outcome);
  }, [outcome, model, search, hours, page, selected]);

  const setModel = useCallback((nextModel: string) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, search, hours, page, selected }, { model: nextModel });
    setPageState(next.page);
    setSelected(next.selected);
    setModelState(next.model);
  }, [outcome, model, search, hours, page, selected]);

  const setSearch = useCallback((nextSearch: string) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, search, hours, page, selected }, { search: nextSearch });
    setPageState(next.page);
    setSelected(next.selected);
    setSearchState(next.search);
  }, [outcome, model, search, hours, page, selected]);

  const setPage = useCallback((updater: number | ((prev: number) => number)) => {
    setPageState((prevPage) => {
      const nextPage = typeof updater === "function" ? updater(prevPage) : updater;
      const next = normalizeCompactEventsQueryState({ outcome, model, search, hours, page: prevPage, selected }, { page: nextPage });
      setSelected(next.selected);
      return next.page;
    });
  }, [outcome, model, search, hours, selected]);

  // ★ hours 由外部（汇总区共享的时间窗口控件）驱动——切换时和其它筛选
  // 条件一样，回第一页、清选中项，但不经过 setXxx 那几个包装函数（外部
  // 直接改 hours 传进来，不是这个 hook 暴露的 setter），所以单独用一个
  // effect 侦测 hours 变化并归一化查询状态，和 `page`/`selected` 保持一致。
  const prevHoursRef = useRef(hours);
  useEffect(() => {
    if (prevHoursRef.current !== hours) {
      prevHoursRef.current = hours;
      setPageState(0);
      setSelected(null);
    }
  }, [hours]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(page);
    clearTimer();

    const tick = () => {
      if (!document.hidden) load(page);
    };
    timerRef.current = setInterval(tick, refreshIntervalMs);
    const onVisibility = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, page, refreshIntervalMs, clearTimer]);

  const selectEvent = useCallback((rid: string) => {
    setSelected(events.find((e) => e.rid === rid) ?? null);
  }, [events]);

  const nextPage = useCallback(() => setPage((p) => p + 1), [setPage]);
  const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), [setPage]);

  return {
    outcome,
    setOutcome,
    model,
    setModel,
    search,
    setSearch,
    events,
    total,
    availableModels,
    loading,
    selected,
    selectEvent,
    page,
    pageSize: PAGE_SIZE,
    nextPage,
    prevPage,
    hasNext: (page + 1) * PAGE_SIZE < total,
    hasPrev: page > 0,
  };
}
