/**
 * ★ 8.17：压缩明细面板的列表数据源——`GET /admin/compact-outcomes/events`。
 *
 * 模式照抄 `use-logs.ts` 的 `useLogs`（同一套 fetch/分页/选中状态管理
 * 约定），额外多了一个"时间窗口跟外部（汇总区）共享"的诉求：`hours` 由
 * 调用方传入而不是这个 hook 自己管理状态——设计文档 2.5 节要求汇总区和
 * 明细列表用同一个时间窗口控件驱动两次独立的 fetch，`hours` 因此必须是
 * 外部受控的，不能是这个 hook 内部的 `useState`。
 *
 * ★ task #109（用户原话："我想把压缩都统计到这里来，就是降级后的压缩也
 * 在这里统一展示，这样才能方便对比"）：新增 `compact_path` 维度——同一次
 * 客户端请求，opaque compact 失败后会把**同一个、未经修改**的 compact
 * 请求送进普通生成端点重试（换端点，不是放弃压缩，见
 * `CompactOutcomeEvent.compact_path` 字段文档），这次改动把"为什么触发了
 * 降级"和"降级之后那次重试自己的结果"都记进同一份日志，供这个面板统一
 * 展示、对比。字段名/取值/query 参数名均照抄 backend-dev（task #108）的
 * 实际落地（`src/routes/shared/compact-outcome-log.ts`），本文件只是镜像
 * ——不是自己猜的契约。
 */

import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { CompactOutcome } from "./use-compact-outcomes";

/**
 * ★ task #109：一次尝试记录属于哪条执行路径——镜像后端
 * `compact-outcome-log.ts` 的 `CompactPath`。三个值分别对应三个**互不相同**
 * 的问题，不是两个：
 * - `"opaque"`：真正走了 opaque marker 快速压缩路径的结果（`success`/
 *   `denied`）。
 * - `"fallback_decision"`：opaque 尝试为什么失败、因此触发了降级
 *   （`budget_exceeded`/`upstream_failed`）——这条走的是非流式的
 *   compact-only 端点调用，失败是同步、真实抛出的错误，状态码可信。
 * - `"fallback_render"`：降级之后，换普通生成端点重试的那次压缩**自己**
 *   的结果——`"render_completed"`（真正等到上游发出完成事件，见
 *   `recordCompactFallbackRenderOutcome` 文档）或复用既有的
 *   `"upstream_failed"` 桶（同步被拒/中途断流/客户端中止，这次改动**不
 *   细分子因**，是后端明确的取舍，不是缺失）。
 *
 * ★★ task #111 落地后的更新，记录一次判断被推翻的教训：#108 最初的判断
 * 是"这次请求恒为流式，代理这一层对流式请求的所有同步失败分支统一返回
 * HTTP 200，没有可信信号，只能记一个语义残缺的 render_started"——这个
 * 判断**只对了一半**：它准确描述了"在 `messages.ts` 那一层看"的情况，但
 * 真正可信的完成信号不需要在那一层拿——`streaming-handler.ts` 的 `finally`
 * 块里的 `responseCompleted`（只在上游真正发出完成事件时置 true，中途
 * 断流/空响应/客户端中止都不会）和 `proxy-handler.ts` 里"从未进入流式
 * 阶段就被拒绝"的终止点（那里的状态码是同步、真实抛出的错误，跟流式
 * 响应的 `res.status` 不可靠无关）合起来，已经能覆盖这次 render 尝试的
 * 全部终止路径。`render_completed` 因此是真实、可信的完成信号，跟 opaque
 * 的 `success` 是同一强度的保证——不再是"提交了、不确定接没接受"那种
 * 弱信号了。
 *
 * `"fallback_decision"` 和 `"fallback_render"` 描述的是同一次降级的两个
 * 阶段（先判定失败触发降级，再执行降级后的重试），共享同一个 `rid`，但
 * 刻意不合并成一个值——两者都可能产生 `"upstream_failed"`，但含义完全
 * 不同（一个是 opaque 端点被拒，一个是通用端点被拒），合并会重犯"看着
 * 分类了、其实分不清具体是哪一种"的模糊态。
 *
 * 历史数据（这次改动之前落盘的行）没有这个字段，后端读侧
 * （`resolveCompactPath`）负责确定性地补全（不是猜——见后端函数文档），
 * 前端拿到的 `compact_path` 保证不是 `undefined`。前端渲染仍按团队要求
 * 当开放枚举处理（见 `CompactDetailPage.tsx` 的 `pathMeta`）：遇到未来
 * 可能出现的、这三个值之外的第四个值，不能崩、也不能静默丢掉那条记录，
 * 只能显示"未分类"。
 */
export type CompactPath = "opaque" | "fallback_decision" | "fallback_render";
export type CompactPathFilter = CompactPath | "all";

/**
 * ★ task #109：events 列表专属的 outcome 集合——比 `use-compact-outcomes.ts`
 * 里给汇总卡片用的 `CompactOutcome`（4 值）多一个 `"render_completed"`。
 * 刻意不直接扩展共享的 `CompactOutcome`：那个类型被
 * `CompactOutcomeBreakdown extends Record<CompactOutcome, number>` 复用，
 * 汇总卡片本次按拍板不接入 `fallback_render` 维度——如果连带扩展
 * `CompactOutcome`，会强迫所有构造 `CompactOutcomeBreakdown` 字面量的地方
 * （包括测试 fixture）都要凭空补一个字段，是一次跟这次任务无关的连带改动。
 * `"render_completed"` 只对 `compact_path === "fallback_render"` 有意义。
 *
 * ★★ task #109/qa 崩溃复盘（这条类型声明本身不是崩溃的根因，记录清楚
 * 是为了不重复踩）：这次改动前把它当"跟 `OUTCOME_META` 一一对应的穷举
 * 类型"来用，误以为类型系统会替运行时兜底——实际不会：`OUTCOME_META`
 * 当时是按这个类型声明的 `Record<CompactOutcomeEventOutcome, ...>`
 * （穷举、无兜底），backend-dev 把这次改动从最初设计的 `render_started`
 * 换成 `render_completed` 之后，`OUTCOME_META[outcome]` 拿到
 * `undefined`，`.pillClass` 把整个面板崩了——但这不是"类型联合缺一个
 * case"能拦住的问题：`events` 数组来自 `fetch().json()`，运行时的
 * `outcome` 值本来就不受这里任何 TS 类型标注约束，编译期的字面量联合
 * 类型只帮授权代码本身查错字/给自动补全，从来防不住"后端返回一个这个
 * 类型没列出的字符串"这件事。真正的修复因此不在这个类型声明上，而是把
 * `OUTCOME_META` 改成 `Partial<Record<string, ...>>` + `outcomeMeta()`
 * 兜底（跟 `PATH_META`/`pathMeta()` 同一套纪律）——这里继续保留紧凑的
 * 字面量联合类型，图的是编码时的查错/自动补全，不是运行时安全网。
 */
export type CompactOutcomeEventOutcome = CompactOutcome | "render_completed";

export interface CompactOutcomeEvent {
  ts: string;
  rid: string;
  conv_hash: string | null;
  model: string;
  /** ★ task #109：见 {@link CompactPath}。 */
  compact_path: CompactPath;
  outcome: CompactOutcomeEventOutcome;
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
   * 不需要 /clear"，/clear 还会真的清空整个会话）。
   * ★ task #109/#111：`compact_path === "fallback_render"` 的失败记录
   * （`outcome === "upstream_failed"`）**可能**带这个字段——同步被拒的
   * 场景会带（`proxy-handler.ts` 传了真实状态码），中途断流/客户端中止
   * 的场景不会（没有一个"上游返回的状态码"这个概念）。缺省时前端必须当
   * "未知"处理，不能默认成任何具体状态码。
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
   * ★ #88：这次尝试的总耗时（毫秒）——大多数 outcome 都可能有值，缺省是
   * "没采集到"（旧版本落盘的历史行），不是 0，前端渲染时要区分这两种情况。
   * ★★ task #111：`compact_path === "fallback_render"` 的记录**现在也有**
   * 这个字段（`recordCompactFallbackRenderOutcome` 从进入 fallback 分支
   * 算到这次尝试真正结束——完成事件/同步拒绝/中途断流/客户端中止，任一
   * 终止点触发都算数）——不再是早期设计里那个只到"拿到响应对象"为止的
   * 半截耗时，可以放心跟 opaque 的 `duration_ms` 同口径比较。
   */
  duration_ms?: number;
  /**
   * ★ #88：这次尝试里确定花在联系上游的那一段耗时（毫秒），是
   * `duration_ms` 的子集。只有真的发起过上游 compact 调用才有值——
   * `success` 的幂等回放分支、`budget_exceeded`、大多数 `denied` 都没有
   * 这个概念，缺省不代表异常。`fallback_render` 记录同样没有这个字段
   * （`recordCompactFallbackRenderOutcome` 不区分"联系上游"这一段耗时，
   * 只记总耗时）。
   */
  upstream_ms?: number;
  /**
   * ★ task #109（backend-dev 追加落地）：仅
   * `compact_path === "fallback_render" && outcome === "upstream_failed"`
   * 时**可能**有值——把这次降级重试的失败拆成两种排查方向完全相反的
   * 情况，跟当初 `compact_path` 要拆成三值同一个道理（混进同一个桶会让
   * "该往哪查"这个问题在数据里消失）：
   *
   * - `"pre_stream"`：这次重试**从未进入流式阶段**就被拒绝了（账号问题、
   *   payload 太大、上游同步 400……）。恒带真实 `http_status`。排查方向：
   *   **这次降级本身选错了**——该调预算估算阈值，或者换模型，跟链路
   *   稳不稳定无关。
   * - `"mid_stream"`：上游已经接受、开始流式生成，但没能等到完整结束
   *   （中途断流/客户端中止/空响应重试耗尽）。不带 `http_status`——这个
   *   终止点没有单一状态码概念，不强凑。排查方向：**链路本身不稳定**——
   *   该查网络/上游服务可用性，跟这次降级的判断对不对无关。
   *
   * 缺省（`undefined`）是历史行，或者 `outcome !== "upstream_failed"`
   * （`render_completed` 不需要这个字段——成功了，没有"往哪查"这个问题）。
   * 前端渲染仍按团队要求当开放枚举处理：遇到这两个值之外的第三个值，不能
   * 崩、也不能静默丢掉那条记录。
   */
  failure_stage?: "pre_stream" | "mid_stream";
}

export type CompactOutcomeFilter = CompactOutcomeEventOutcome | "all";

/**
 * 切筛选条件（结果类型/型号/压缩路径/会话搜索/时间窗口）时自动回到第一页、
 * 清空选中项——和 `normalizeLogsQueryState` 同一套语义，这里独立实现是
 * 因为筛选维度不同（多了 outcome/model/compactPath，少了 direction），
 * 字段对不上没法直接复用同一个泛型函数，但设计意图一致。
 *
 * ★ task #109：新增 `compactPath` 维度，跟 `outcome`/`model` 同等对待——
 * 切换它同样要回第一页、清选中项，否则会出现"筛了压缩路径，列表刷新了，
 * 但选中的详情还是筛选前那条不相关记录"的错位。
 */
export function normalizeCompactEventsQueryState<T>(
  prev: { outcome: CompactOutcomeFilter; model: string; compactPath: CompactPathFilter; search: string; hours: number | "all"; page: number; selected: T | null },
  next: { outcome?: CompactOutcomeFilter; model?: string; compactPath?: CompactPathFilter; search?: string; hours?: number | "all"; page?: number },
): { outcome: CompactOutcomeFilter; model: string; compactPath: CompactPathFilter; search: string; hours: number | "all"; page: number; selected: T | null } {
  const outcome = next.outcome ?? prev.outcome;
  const model = next.model ?? prev.model;
  const compactPath = next.compactPath ?? prev.compactPath;
  const search = next.search ?? prev.search;
  const hours = next.hours ?? prev.hours;
  const page = next.page ?? prev.page;
  const queryChanged = outcome !== prev.outcome || model !== prev.model || compactPath !== prev.compactPath || search !== prev.search || hours !== prev.hours;
  const pageChanged = page !== prev.page;
  return {
    outcome,
    model,
    compactPath,
    search,
    hours,
    page: queryChanged ? 0 : page,
    selected: queryChanged || pageChanged ? null : prev.selected,
  };
}

/**
 * ★ task #109：`rid` 不再是唯一键——同一次客户端请求降级时，
 * `fallback_decision` 记录和 `fallback_render` 记录共享同一个 `rid`（见
 * `CompactOutcomeEvent.compact_path` 文档）。`ts` 和 `rid` 组合起来才是
 * 这份数据里真正唯一的键（列表渲染用的 React `key` 就是 `${rid}-${ts}`，
 * 同一个约定这里复用，不是另起一套）——传了 `ts` 时精确匹配那一条。
 *
 * ★★ 只传 `rid`、不传 `ts` 的场景是真实存在的（team-lead 确认过：用户
 * 常见的入口是"从日志页/别人发的链接过来，手上只有 rid，没有 ts"）。这个
 * 场景下选哪一条是 team-lead 拍板的**明确决定**，不是"随便挑第一个碰到
 * 的"——`events` 数组本身是按 `ts` 倒序排列的（最新在前），如果不做任何
 * 处理，"取第一条匹配"实际会选中 `fallback_render`（它的 ts 比
 * `fallback_decision` 更晚，天然排在前面），这跟 team-lead 想要的结果
 * 正好相反，必须显式排除这种误选，不能依赖数组顺序的偶然结果。
 *
 * 拍板结果：只传 rid 时优先选 `fallback_decision`（或没有降级发生时唯一
 * 的那条 `opaque` 记录）——它是时间上更早的那一条，也是"为什么触发了
 * 降级"这个问题的入口；用户从这里能通过详情面板的"关联记录"区块跳到
 * `fallback_render` 那一条，两条记录始终都能看到、都能到达，不存在
 * "选哪条都行、用户看不出还有另一条"的情况。
 *
 * 抽成独立的纯函数（不内联在 `selectEvent` 里）是为了能单独写单测锁住
 * 这条"优先选谁"的决策，不用透过整个 hook + mock fetch 才能验证。
 */
export function pickEventForRid(
  events: CompactOutcomeEvent[],
  rid: string,
  ts?: string,
): CompactOutcomeEvent | null {
  const matches = events.filter((e) => e.rid === rid);
  if (ts !== undefined) {
    return matches.find((e) => e.ts === ts) ?? null;
  }
  if (matches.length <= 1) {
    return matches[0] ?? null;
  }
  return matches.find((e) => e.compact_path !== "fallback_render") ?? matches[0];
}

const FETCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 50;

export function useCompactOutcomeEvents(hours: number | "all", refreshIntervalMs = 15_000) {
  const [outcome, setOutcomeState] = useState<CompactOutcomeFilter>("all");
  const [model, setModelState] = useState("");
  // ★ task #109：默认 `"all"`——镜像后端 `/admin/compact-outcomes/events`
  // 这次改动新增的 `compact_path` 参数不传时的默认口径（三条路径全部
  // 摊平展示，不过滤）。`/summary` 那边默认相反（排除 `fallback_render`，
  // 见 `CompactOutcomesCard.tsx`/`use-compact-outcomes.ts`），两个端点的
  // 默认值刻意不对称，这里不能抄错。
  const [compactPath, setCompactPathState] = useState<CompactPathFilter>("all");
  const [search, setSearchState] = useState("");
  const [events, setEvents] = useState<CompactOutcomeEvent[]>([]);
  const [total, setTotal] = useState(0);
  // ★ 8.18：型号筛选下拉框的选项来源——后端只按时间窗口过滤，不因当前
  // outcome/model 筛选而收窄（见 `compact-outcome-log.ts` 的同名字段注释），
  // 这里原样透传，不在前端另外做二次收窄。
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /**
   * ★ task #109：这个时间窗口内实际出现过的压缩路径——同一条纪律，只按
   * 时间窗口过滤。用途是让筛选 UI 能区分"这个路径在当前窗口里没有记录"
   * 和"筛选坏了/看不出有没有数据"，不是决定筛选选项本身有哪些（选项列表
   * 仍然来自 `PATH_META` 那个开放枚举——这个字段只用来给暂无数据的选项
   * 加一个弱化的视觉提示，未加载完成前是空数组，调用方不应该在这个数组
   * 为空时就认定"所有路径都没数据"）。
   */
  const [availableCompactPaths, setAvailableCompactPaths] = useState<string[]>([]);
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
      // ★ task #109：只在不是"全部"时才显式传参——和 outcome/model 同一个
      // 省略惯例，`"all"` 就是不传，让后端走它自己的默认值（`/events` 默认
      // 已经是 all，这里传不传其实等价，但保持惯例一致，未来这个端点默认
      // 值再变也不会连带影响这里的行为）。参数名 `compact_path` 照抄后端
      // query 参数名，不是这次自己发明的。
      if (compactPath !== "all") params.set("compact_path", compactPath);
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
        // ★ task #109（team-lead 建议顺手接上）：只按时间窗口过滤，不因
        // 当前 outcome/model/compactPath 筛选而收窄——跟 availableModels
        // 同一条纪律，见 `compact-outcome-log.ts` 同名字段注释。
        setAvailableCompactPaths(body.availableCompactPaths ?? []);
      }
    } catch { /* network error / timeout / abort — fall through */ }
    finally { setLoading(false); }
  }, [hours, outcome, model, compactPath, search]);

  const setOutcome = useCallback((nextOutcome: CompactOutcomeFilter) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, compactPath, search, hours, page, selected }, { outcome: nextOutcome });
    setPageState(next.page);
    setSelected(next.selected);
    setOutcomeState(next.outcome);
  }, [outcome, model, compactPath, search, hours, page, selected]);

  const setModel = useCallback((nextModel: string) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, compactPath, search, hours, page, selected }, { model: nextModel });
    setPageState(next.page);
    setSelected(next.selected);
    setModelState(next.model);
  }, [outcome, model, compactPath, search, hours, page, selected]);

  // ★ task #109：跟 setOutcome/setModel 同一套模式——切换压缩路径筛选时
  // 回第一页、清选中项。
  const setCompactPath = useCallback((next_: CompactPathFilter) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, compactPath, search, hours, page, selected }, { compactPath: next_ });
    setPageState(next.page);
    setSelected(next.selected);
    setCompactPathState(next.compactPath);
  }, [outcome, model, compactPath, search, hours, page, selected]);

  const setSearch = useCallback((nextSearch: string) => {
    const next = normalizeCompactEventsQueryState({ outcome, model, compactPath, search, hours, page, selected }, { search: nextSearch });
    setPageState(next.page);
    setSelected(next.selected);
    setSearchState(next.search);
  }, [outcome, model, compactPath, search, hours, page, selected]);

  const setPage = useCallback((updater: number | ((prev: number) => number)) => {
    setPageState((prevPage) => {
      const nextPage = typeof updater === "function" ? updater(prevPage) : updater;
      const next = normalizeCompactEventsQueryState({ outcome, model, compactPath, search, hours, page: prevPage, selected }, { page: nextPage });
      setSelected(next.selected);
      return next.page;
    });
  }, [outcome, model, compactPath, search, hours, selected]);

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

  const selectEvent = useCallback((rid: string, ts?: string) => {
    setSelected(pickEventForRid(events, rid, ts));
  }, [events]);

  const nextPage = useCallback(() => setPage((p) => p + 1), [setPage]);
  const prevPage = useCallback(() => setPage((p) => Math.max(0, p - 1)), [setPage]);

  return {
    outcome,
    setOutcome,
    model,
    setModel,
    compactPath,
    setCompactPath,
    search,
    setSearch,
    events,
    total,
    availableModels,
    availableCompactPaths,
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
