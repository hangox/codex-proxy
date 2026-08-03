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
  /**
   * ★ #97（用户原话："这个为什么是降级？上面能不能加个 id？"——team-lead
   * 排查用户报告的一条具体降级记录时发现的观测缺口）：`estimated_tokens`
   * 是用哪种方法算出来的。
   *
   * - `"cheap"`：字节比例粗筛，粗筛本身就在预算内。
   * - `"precise"`：真分词器完整跑完，没有触发 2000ms 熔断。
   * - `"precise_extrapolated"`：精确估算触发了熔断，是按已处理比例外推
   *   出来的——**可信度明显低于 `"precise"`**，具体看 `processed_fraction`。
   *
   * 判据是"这个数可不可信"：不做区分（合并成一个标签）会把可信度天差
   * 地别的两种情况标成同一个值，比完全不记录更糟。仅 `budget_exceeded`
   * 有值。
   */
  estimate_source?: "cheap" | "precise" | "precise_extrapolated";
  /**
   * ★ #97：仅 `estimate_source === "precise_extrapolated"` 时有值——已
   * 处理内容占总长度的比例（0~1）。判断外推可信度**最关键**的字段：外推
   * 自 20%（刚过下限）和外推自 90% 的可信度不是一个量级。
   */
  processed_fraction?: number;
  /**
   * ★ #97：`planCompactRequestForBudget` 判断一开始就会算的粗筛值，跟
   * `estimated_tokens`（可能是精确值）并存——每一条 `budget_exceeded`
   * 记录因此是一个"粗筛 vs 精确"的真实标定样本。仅 `budget_exceeded` 有值。
   */
  cheap_estimate_tokens?: number;
  reason?: string;
  /**
   * ★ #96（reviewer 交叉审查发现的用户可见误导）：`denied` 记录的真实 HTTP
   * 状态码。`#91` 之前 `denied` 恒等于 409，Dashboard 一直硬编码这个假设
   * （标签写死"Denied (409)"、指引写死"用 /clear"）；`#91` 之后族 A（自愈
   * 候选撞在非 compact 请求上）改成了 400，同一个 `outcome: "denied"` 集合
   * 里现在混着 400 和 409——继续按旧假设渲染会给用户错误的指引（对一条
   * 400/族 A 的记录说"用 /clear"，而正确动作是"下次 /compact 自动恢复，
   * 不需要 /clear"，/clear 还会真的清空整个会话）。只有 `denied` 会有这个
   * 字段——其它三种 outcome 的状态码是隐式已知的常量，不需要重复记录。
   * 缺省时是这次改动之前落盘的历史行，前端必须当"未知"处理，不能默认成
   * 409（那正是要修的那个假设）。
   */
  http_status?: number;
  /**
   * ★ #96：`denied` 的失败子因（`#83` 产出，只对 `reason ===
   * "recompact_failed_original_account"` 这个聚合桶有值——其它 `denied`
   * reason 本身已经是完整分类）。前端靠这个字段在 `state_too_large`/
   * `stale_generation`/`preserved_tail_conflict` 和其余账号失败之间给出
   * 不同指引，镜像后端 `describeRecompactFailure` 的三桶划分（见
   * `messages.ts`），不是重新发明一套分类。
   */
  cause?: string;
  /**
   * ★ #88：这次尝试的总耗时（毫秒）——四种 outcome 都可能有值，缺省是
   * "没采集到"（旧版本落盘的历史行），不是 0，前端渲染时要区分这两种情况。
   */
  duration_ms?: number;
  /**
   * ★ #88：这次尝试里确定花在联系上游的那一段耗时（毫秒），是
   * `duration_ms` 的子集。只有真的发起过上游 compact 调用才有值——
   * `success` 的幂等回放分支、`budget_exceeded`、大多数 `denied` 都没有
   * 这个概念，缺省不代表异常。
   */
  upstream_ms?: number;
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
