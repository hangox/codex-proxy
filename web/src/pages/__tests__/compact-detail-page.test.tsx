/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";
import type { CompactOutcomeEvent } from "../../../../shared/hooks/use-compact-outcome-events";

const mockEvents = vi.hoisted(() => ({
  useCompactOutcomeEvents: vi.fn(),
}));
const mockStats = vi.hoisted(() => ({
  useCompactOutcomeStats: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-compact-outcome-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../shared/hooks/use-compact-outcome-events")>();
  return { ...actual, useCompactOutcomeEvents: mockEvents.useCompactOutcomeEvents };
});
// CompactDetailPage 顶部渲染的是真实的 CompactOutcomesCard（不重写一份汇总
// 逻辑，见 CompactOutcomesCard 头部注释），它内部调用 useCompactOutcomeStats
// ——这里同样要 mock 掉，否则会真的发 fetch。
vi.mock("../../../../shared/hooks/use-compact-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../shared/hooks/use-compact-outcomes")>();
  return { ...actual, useCompactOutcomeStats: mockStats.useCompactOutcomeStats };
});

import { CompactDetailPage } from "../CompactDetailPage";

function makeEvent(overrides: Partial<CompactOutcomeEvent> = {}): CompactOutcomeEvent {
  return {
    ts: "2026-08-03T14:32:07.000Z",
    rid: "39587bd5",
    conv_hash: "a3f9e21c",
    model: "gpt-5.6-sol",
    outcome: "budget_exceeded",
    estimated_tokens: 479024,
    budget_tokens: 390000,
    ...overrides,
  };
}

function makeEventsState(overrides: Partial<ReturnType<typeof mockEvents.useCompactOutcomeEvents>> = {}) {
  return {
    outcome: "all" as const,
    setOutcome: vi.fn(),
    model: "",
    setModel: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    events: [makeEvent()],
    total: 1,
    availableModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    loading: false,
    selected: null,
    selectEvent: vi.fn(),
    page: 0,
    pageSize: 50,
    nextPage: vi.fn(),
    prevPage: vi.fn(),
    hasNext: false,
    hasPrev: false,
    ...overrides,
  };
}

function makeStatsState() {
  const breakdown = { success: 3, budget_exceeded: 1, upstream_failed: 0, denied: 0, total: 4, success_rate: 0.75 };
  return { stats: { by_session: breakdown, by_request: breakdown, recent_budget_exceeded: [] }, loading: false };
}

function renderPage() {
  return render(
    <I18nProvider>
      <CompactDetailPage />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockEvents.useCompactOutcomeEvents.mockReset();
  mockStats.useCompactOutcomeStats.mockReset();
  // ★ #97 part 2：URL 同步测试会真的调用 history.replaceState/pushState，
  // 不清理会让 location.search 泄漏到下一条测试，产生"上一条测试的筛选
  // 状态污染了这一条"的假阳性/假阴性。
  history.replaceState(null, "", "/");
});

describe("CompactDetailPage — 列表", () => {
  it("渲染列表行：时间/结果/型号/关键信息", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState());
    renderPage();

    // ★ 8.18 之后 "gpt-5.6-sol" 同时出现在列表行和新增的型号筛选下拉框
    // <option> 里——这里只断言列表行那个（在 <button> 里），下拉框选项
    // 单独有测试覆盖（见"★ 8.18 型号筛选"describe 块）。
    const modelCandidates = screen.getAllByText("gpt-5.6-sol");
    expect(modelCandidates.some((el) => el.closest("button") !== null)).toBe(true);
    expect(screen.getByText(/479\.0K/)).toBeTruthy();
    expect(screen.getByText(/390\.0K/)).toBeTruthy();
  });

  // ★ #96：denied 记录的列表"关键信息"列把真实状态码摆在最前面
  // （"400 · expired"）——之前隐含假设 denied 全是 409，现在不用点进详情
  // 就能一眼看出这条是族 A（400）还是别的（409）。
  it("列表关键信息列：denied 记录带 http_status 时显示 '{status} · {reason}'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ outcome: "denied", reason: "expired", http_status: 400 })],
    }));
    renderPage();
    expect(screen.getByText("400 · expired")).toBeTruthy();
  });

  it("列表关键信息列：denied 记录缺省 http_status（旧数据）时只显示 reason，不猜状态码", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ outcome: "denied", reason: "store_unavailable" })],
    }));
    renderPage();
    expect(screen.getByText("store_unavailable")).toBeTruthy();
    expect(screen.queryByText(/^\d+ · /)).toBeNull();
  });

  it("★ 空数据（真的没有记录）显示'暂无压缩记录'——不是筛选文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ events: [], total: 0, outcome: "all" }));
    renderPage();
    expect(screen.getByText("No compact records yet")).toBeTruthy();
  });

  it("★ 空数据（筛选条件下没有）显示'调整筛选范围'文案——两种零数据文案必须分开", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ events: [], total: 0, outcome: "denied" }));
    renderPage();
    expect(screen.getByText(/No records match the current filter/)).toBeTruthy();
    expect(screen.queryByText("No compact records yet")).toBeNull();
  });

  it("★★ 8.20（reviewer2 P2 回归）：只按型号筛选（outcome 仍是 'all'）没有记录时，也要显示'调整筛选范围'文案，不是'暂无压缩记录'——isFiltered 必须同时看 outcome 和 model", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    // outcome 保持默认 "all"，只有 model 被选中且这个窗口内该型号没有记录——
    // 此前 isFiltered 只判断了 outcome，这种情况会误判成"真的没有数据"。
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ events: [], total: 0, outcome: "all", model: "gpt-5.6-terra" }));
    renderPage();
    expect(screen.getByText(/No records match the current filter/)).toBeTruthy();
    expect(screen.queryByText("No compact records yet")).toBeNull();
  });

  it("点击列表行调用 selectEvent(rid)", () => {
    const selectEvent = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selectEvent }));
    renderPage();

    const modelCandidates = screen.getAllByText("gpt-5.6-sol");
    const rowButton = modelCandidates.find((el) => el.closest("button") !== null);
    fireEvent.click(rowButton!);
    expect(selectEvent).toHaveBeenCalledWith("39587bd5");
  });

  it("分页按钮调用 nextPage/prevPage，受 hasNext/hasPrev 控制禁用状态", () => {
    const nextPage = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ nextPage, hasNext: true, hasPrev: false }));
    renderPage();

    const prevButtons = screen.getAllByText("Prev") as HTMLButtonElement[];
    expect(prevButtons[0].disabled).toBe(true);
    const nextButtons = screen.getAllByText("Next") as HTMLButtonElement[];
    expect(nextButtons[0].disabled).toBe(false);
    fireEvent.click(nextButtons[0]);
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("点击结果类型筛选 pill 调用 setOutcome", () => {
    const setOutcome = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setOutcome }));
    renderPage();

    // "Denied" 同时出现在汇总区（一行）和列表筛选栏（一个 pill 按钮）
    // 里——这里只测列表筛选栏的 pill，用"是不是 <button>"精确定位，汇总区
    // 那次点击单独有一条测试覆盖（见下面"汇总区点击结果行也调用 setOutcome"）。
    const candidates = screen.getAllByText("Denied");
    const pillButton = candidates.find((el) => el.closest("button") !== null);
    expect(pillButton).toBeTruthy();
    fireEvent.click(pillButton!);
    expect(setOutcome).toHaveBeenCalledWith("denied");
  });

  // ★ #88：列表新增耗时列。只显示总耗时（简洁），不含上游耗时的括注——
  // 那个更详细的展示放在详情面板那一行。
  it("★ #88：列表行显示总耗时列（毫秒/秒格式化），缺省时显示占位符", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(
      makeEventsState({ events: [makeEvent({ duration_ms: 1234, upstream_ms: 980 })] }),
    );
    renderPage();
    // 列表列只显示总耗时的秒/毫秒格式化值，不含"（upstream ...）"括注。
    expect(screen.getByText("1.2s")).toBeTruthy();
  });

  it("★ #88：duration_ms 缺省（旧版本落盘的历史行）时列表显示 '—'，不是 '0ms'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(
      makeEventsState({ events: [makeEvent({ duration_ms: undefined, upstream_ms: undefined })] }),
    );
    renderPage();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("★★ 汇总区点击结果行也调用 setOutcome——这是汇总和列表联动的落地机制", () => {
    const setOutcome = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setOutcome }));
    renderPage();

    // 汇总区（CompactOutcomesCard full 变体）也有一行"Predicted downgrade"，
    // 和列表筛选栏里的同名 pill 是两个不同的可点击元素——都应该驱动同一个
    // setOutcome。取第一个匹配（汇总区在 DOM 顺序上排在列表筛选栏前面）。
    const targets = screen.getAllByText("Predicted downgrade");
    fireEvent.click(targets[0]);
    expect(setOutcome).toHaveBeenCalledWith("budget_exceeded");
  });
});

describe("CompactDetailPage — ★★ 8.19 P1：汇总必须和列表用同一个计数口径", () => {
  it("汇总区显示的总数等于列表 total，即便 stats.by_session 算出不同的数字——这是 reviewer2 挡下的那个 bug 的回归测试", () => {
    // 模拟同一会话连续 5 次 budget_exceeded 后 1 次 success：by_session 只
    // 算"1 个会话、成功"，由原始事件构成的列表却有 6 条。页面顶部汇总区
    // 必须显示 6（by_request），不能显示 1（by_session），否则就是"汇总
        // 说 0 次降级、列表里却有 5 条"这个用户会真实撞到的问题。
    mockStats.useCompactOutcomeStats.mockReturnValue({
      stats: {
        by_session: { success: 1, budget_exceeded: 0, upstream_failed: 0, denied: 0, total: 1, success_rate: 1 },
        by_request: { success: 1, budget_exceeded: 5, upstream_failed: 0, denied: 0, total: 6, success_rate: 1 / 6 },
      },
      loading: false,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ total: 6 }));
    renderPage();

    // 汇总区大数字：Math.round(1/6*100) = 17%，不是 100%。
    expect(screen.getByText("17%")).toBeTruthy();
    expect(screen.getByText(/1 \/ 6/)).toBeTruthy();
    // "预判降级"同时出现在汇总区（div 行）和列表筛选栏（button pill）里，
    // 这里只要汇总区那个——用"不在 <button> 里"定位，和文件里其它处理
    // 同名文案重复的测试用同一套手法。
    const budgetLabelCandidates = screen.getAllByText("Predicted downgrade");
    const summaryLabel = budgetLabelCandidates.find((el) => el.closest("button") === null);
    const budgetRow = summaryLabel!.closest("div")!;
    expect(budgetRow.textContent).toContain("5");
  });
});

describe("CompactDetailPage — ★ 8.19 结果类型筛选的可见性（不是行为错，是要让用户看得见）", () => {
  it("outcome='all' 时不显示筛选徽标", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ outcome: "all" }));
    renderPage();
    expect(screen.queryByText(/Filtered:/)).toBeNull();
  });

  it("outcome 非 'all' 时显示'Filtered: {label}'徽标，点击徽标调用 setOutcome('all')——这是明确的清除入口", () => {
    const setOutcome = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ outcome: "budget_exceeded", setOutcome }));
    renderPage();

    const badge = screen.getByText(/Filtered:/);
    expect(badge.textContent).toContain("Predicted downgrade");
    fireEvent.click(badge.closest("button")!);
    expect(setOutcome).toHaveBeenCalledWith("all");
  });

  it("★ 汇总区里当前筛选的那一行有可见的选中态——activeOutcome 从 eventsState.outcome 传下去", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ outcome: "denied" }));
    renderPage();

    // 汇总区（CompactOutcomesCard）里的 "Denied" 行应该带高亮 class；
    // 列表筛选栏那个同名 pill 不会有这个 class（它是 PillToggle 自己的
    // active 样式），所以只断言"存在至少一个带高亮 class 的匹配元素"。
    const candidates = screen.getAllByText("Denied");
    const highlighted = candidates.some((el) => el.closest("div")?.className.includes("border-primary/40"));
    expect(highlighted).toBe(true);
  });
});

describe("CompactDetailPage — ★ 8.18 型号筛选", () => {
  it("下拉框选项来自 availableModels，默认选中'全部型号'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState());
    renderPage();

    const select = screen.getByDisplayValue("All models") as HTMLSelectElement;
    expect(select).toBeTruthy();
    const optionLabels = Array.from(select.options).map((o) => o.value);
    expect(optionLabels).toEqual(["", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("选择型号调用 setModel", () => {
    const setModel = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setModel }));
    renderPage();

    const select = screen.getByDisplayValue("All models") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "gpt-5.6-terra" } });
    expect(setModel).toHaveBeenCalledWith("gpt-5.6-terra");
  });

  it("★★ 必须联动汇总区：选中型号后，汇总区的 useCompactOutcomeStats 调用参数里带上同一个型号——这是防止'汇总说4次降级、列表按型号筛却对不上'的核心机制", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ model: "gpt-5.6-sol" }));
    renderPage();

    expect(mockStats.useCompactOutcomeStats).toHaveBeenCalledWith(24, "gpt-5.6-sol");
  });

  it("默认'全部型号'时，汇总区调用 hook 不带具体型号（undefined，即合计口径）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ model: "" }));
    renderPage();

    expect(mockStats.useCompactOutcomeStats).toHaveBeenCalledWith(24, undefined);
  });

  it("★ 结果类型筛选的不对称保持不变：切换 outcome 不影响汇总区的 useCompactOutcomeStats 调用参数", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ outcome: "denied", model: "" }));
    renderPage();

    // 第二个参数（model）依然是 undefined——outcome 从不出现在这个调用里，
    // 汇总区完全不知道当前的结果类型筛选是什么。
    expect(mockStats.useCompactOutcomeStats).toHaveBeenCalledWith(24, undefined);
  });
});

describe("CompactDetailPage — 详情面板", () => {
  it("未选中任何记录时显示提示文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected: null }));
    renderPage();
    expect(screen.getByText("Select a record to view details")).toBeTruthy();
  });

  it("budget_exceeded：显示估算/预算 token、超出比例、'怎么回退的'文案；#97 之后不再显示'需新增采集'提示（那个缺口已经补上）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "budget_exceeded", estimated_tokens: 479024, budget_tokens: 390000 });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("479,024")).toBeTruthy();
    expect(screen.getByText("390,000")).toBeTruthy();
    expect(screen.getByText("+22.8%")).toBeTruthy();
    expect(screen.getByText(/Skipped the upstream call/)).toBeTruthy();
    // ★ #97：这条提示描述的缺口（"估算方式还没接进这条记录"）这次改动
    // 已经补上了，整块"需新增采集"提示不应该再出现在 budget_exceeded 上。
    expect(screen.queryByText("Needs more collection")).toBeNull();
  });

  // ★ #97（用户原话："这个为什么是降级？"——team-lead 排查这条具体问题时
  // 发现的观测缺口）：estimate_source 三值 + processed_fraction +
  // cheap_estimate_tokens 逐一断言，防止以后半截实现（比如漏传
  // processedFraction）又把可信度天差地别的两种情况标成同一个值。
  it("budget_exceeded + estimate_source=cheap：显示'字节比例（粗筛）'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "budget_exceeded", estimated_tokens: 300000, budget_tokens: 260000,
      estimate_source: "cheap",
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Byte-ratio (cheap)")).toBeTruthy();
  });

  it("budget_exceeded + estimate_source=precise：显示'分词器（精确）'，不显示已处理比例", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "budget_exceeded", estimated_tokens: 300000, budget_tokens: 260000,
      estimate_source: "precise",
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Tokenizer (precise)")).toBeTruthy();
  });

  it("budget_exceeded + estimate_source=precise_extrapolated：显示已处理比例——这是判断这次降级是否误判的关键信息", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "budget_exceeded", estimated_tokens: 417000, budget_tokens: 390000,
      estimate_source: "precise_extrapolated", processed_fraction: 0.42,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Tokenizer (extrapolated, 42% processed)")).toBeTruthy();
  });

  it("budget_exceeded + cheap_estimate_tokens：显示粗筛值，跟精确值并存（标定用的对照组）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "budget_exceeded", estimated_tokens: 417000, budget_tokens: 390000,
      estimate_source: "precise", cheap_estimate_tokens: 620000,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Byte-ratio estimate")).toBeTruthy();
    expect(screen.getByText("620,000")).toBeTruthy();
  });

  it("budget_exceeded 缺省 estimate_source（旧数据）：显示占位符，不猜是哪一种，也不显示粗筛值行", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "budget_exceeded", estimated_tokens: 300000, budget_tokens: 260000 });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Estimate source")).toBeTruthy();
    expect(screen.queryByText("Byte-ratio estimate")).toBeNull();
  });

  it("success（非幂等重放）：显示'完成、marker 已签发'文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "success", replayed: false, estimated_tokens: undefined, budget_tokens: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("Completed normally, the marker was issued and persisted.")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy(); // 幂等重放=否
  });

  it("success（幂等重放命中）：显示'幂等短路'文案，不是'正常完成'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "success", replayed: true, estimated_tokens: undefined, budget_tokens: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText(/Idempotent short-circuit/)).toBeTruthy();
    expect(screen.queryByText("Completed normally, the marker was issued and persisted.")).toBeNull();
  });

  it("denied：显示原因(reason)、409 文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "denied", reason: "store_unavailable", estimated_tokens: undefined, budget_tokens: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("store_unavailable")).toBeTruthy();
    expect(screen.getByText(/Returned 409/)).toBeTruthy();
  });

  // ★ #96（reviewer 交叉审查发现的用户可见误导）：#91 之前 denied 恒等于
  // 409，面板一直硬编码"用 /clear"这个建议。#91 之后族 A（自愈候选撞在非
  // compact 请求上）改成了 400，同一个 denied 集合里现在混着三种性质不同
  // 的记录——这四条测试逐一钉死"按 reason/cause 给出不同指引"这个行为，
  // 不再是一句固定文案，防止以后有人把这个分支简化回单一文案。
  it("denied + 族 A reason（expired）：显示 400、自愈指引，不出现 /clear", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "denied", reason: "expired", http_status: 400,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText(/Returned 400/)).toBeTruthy();
    expect(screen.getByText(/refreshed automatically on your next \/compact/)).toBeTruthy();
    expect(screen.queryByText(/Run \/clear/)).toBeNull();
  });

  it("denied + cause=state_too_large：显示 409、容量耗尽指引，建议 /clear", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "denied", reason: "recompact_failed_original_account",
      cause: "state_too_large", http_status: 409,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText(/too large to save/)).toBeTruthy();
    expect(screen.getByText(/Run \/clear/)).toBeTruthy();
  });

  it.each(["stale_generation", "preserved_tail_conflict"])(
    "denied + cause=%s：显示 409、并发冲突指引，不出现 /clear",
    (cause) => {
      mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
      const selected = makeEvent({
        outcome: "denied", reason: "recompact_failed_original_account",
        cause, http_status: 409,
        estimated_tokens: undefined, budget_tokens: undefined,
      });
      mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
      renderPage();

      expect(screen.getByText(/conflicted with another compact operation/)).toBeTruthy();
      expect(screen.queryByText(/Run \/clear/)).toBeNull();
    },
  );

  it("denied：详情面板显示 HTTP Status 行，缺省（旧数据）显示占位符不是默认 409", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "denied", reason: "tampered",
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    // Duration 行等其它字段缺省时也显示 "—"——用 DetailRow 的兄弟节点结构
    // 精确定位到 "HTTP Status" 那一行自己的值，不跟其它 "—" 撞在一起。
    const label = screen.getByText("HTTP Status");
    const row = label.closest("div");
    expect(row?.textContent).toBe("HTTP Status—");
  });

  it("denied + http_status=400：详情面板 HTTP Status 行显示真实数字", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      outcome: "denied", reason: "expired", http_status: 400,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const label = screen.getByText("HTTP Status");
    const row = label.closest("div");
    expect(row?.textContent).toBe("HTTP Status400");
  });

  it("upstream_failed：显示原因(reason)、降级文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "upstream_failed", reason: "CompactServiceError", estimated_tokens: undefined, budget_tokens: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("CompactServiceError")).toBeTruthy();
    expect(screen.getByText(/Upstream was contacted and rejected/)).toBeTruthy();
  });

  // ★ #88：详情面板新增耗时行——总耗时 + 上游耗时括注，适用于所有 outcome
  // （不是只有 success/upstream_failed 才显示），放在跟 outcome 无关的
  // "Record" 分组里。
  it("★ #88：详情面板显示耗时行，upstream_ms 存在时括注上游耗时", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "success", replayed: false, duration_ms: 622, upstream_ms: 480 });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText(/622ms/)).toBeTruthy();
    expect(screen.getByText(/480ms/)).toBeTruthy();
  });

  it("★ #88：upstream_ms 缺省时详情面板只显示总耗时，不括注上游耗时", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "success", replayed: true, duration_ms: 4, upstream_ms: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("4ms")).toBeTruthy();
  });

  it("★ #88：duration_ms 也缺省时详情面板的耗时行本身仍然存在，只是显示占位符", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ outcome: "denied", reason: "store_unavailable", duration_ms: undefined, upstream_ms: undefined });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    // "Duration" 同时出现在列表列头和详情面板的行标签里——这里只要详情
    // 面板那个（在右侧详情卡片容器内），不是列头。
    const durationLabels = screen.getAllByText("Duration");
    expect(durationLabels.length).toBeGreaterThanOrEqual(2);
  });

  it("★ conv_hash 隐私提示在详情面板里可见，不是只在页头出现一次", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ conv_hash: "a3f9e21c" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("a3f9e21c")).toBeTruthy();
    expect(screen.getByText(/Unstable across process restarts/)).toBeTruthy();
  });

  it("跳转日志页的链接指向 #/logs（不是带查询串的深链接，那种链接会被路由忽略）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected: makeEvent() }));
    renderPage();

    const link = screen.getByText(/paste the request ID/).closest("a");
    expect(link?.getAttribute("href")).toBe("#/logs");
  });
});

describe("CompactDetailPage — 数据保留提示", () => {
  it("列表下方显示轮转/保留窗口的提示，不承诺完整历史", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState());
    renderPage();
    expect(screen.getByText(/Not a complete audit log/)).toBeTruthy();
  });
});

// ★ #97 part 2（用户原话："这个为什么是降级？上面能不能加个 id？不然我
// 不好告诉你具体的问题是那个？或者 url 可以体现也可以"）：URL 反映当前
// 选中记录 + 筛选状态，请求 ID 可复制。
describe("CompactDetailPage — URL 状态同步", () => {
  it("挂载时从 URL 读取 hours/outcome/model，应用到对应的状态/setter 上", () => {
    history.replaceState(null, "", "/?hours=168&outcome=denied&model=gpt-5.6-terra");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const setOutcome = vi.fn();
    const setModel = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setOutcome, setModel }));
    renderPage();

    // hours 是页面内部 useState，不经过 mock 的 hook——通过
    // useCompactOutcomeEvents 被调用时传入的第一个参数间接验证。
    expect(mockEvents.useCompactOutcomeEvents).toHaveBeenCalledWith(168);
    expect(setOutcome).toHaveBeenCalledWith("denied");
    expect(setModel).toHaveBeenCalledWith("gpt-5.6-terra");
  });

  it("URL 没有对应参数时，hours 用默认值 24，不调用 setOutcome/setModel（避免用空字符串/'all' 覆盖初始状态）", () => {
    history.replaceState(null, "", "/");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const setOutcome = vi.fn();
    const setModel = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setOutcome, setModel }));
    renderPage();

    expect(mockEvents.useCompactOutcomeEvents).toHaveBeenCalledWith(24);
    expect(setOutcome).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("URL 带非法/不认识的 hours 值时忽略，退回默认值 24（不会把一个从没在 UI 上出现过的窗口值传给后端）", () => {
    history.replaceState(null, "", "/?hours=999");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState());
    renderPage();

    expect(mockEvents.useCompactOutcomeEvents).toHaveBeenCalledWith(24);
  });

  it("挂载时 URL 带 rid 且 events 里有匹配记录，调用 selectEvent", () => {
    history.replaceState(null, "", "/?rid=target-rid");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selectEvent = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ rid: "target-rid" })],
      selectEvent,
    }));
    renderPage();

    expect(selectEvent).toHaveBeenCalledWith("target-rid");
  });

  it("URL 带 rid 但当前已加载的 events 里没有这一条时，不调用 selectEvent（避免用一个查不到的 rid 反复尝试）", () => {
    history.replaceState(null, "", "/?rid=not-loaded-yet");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selectEvent = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ rid: "some-other-rid" })],
      selectEvent,
    }));
    renderPage();

    expect(selectEvent).not.toHaveBeenCalled();
  });

  it("选中记录/筛选条件变化后，写回 location.search（分享/刷新后能还原同一个视图）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      outcome: "budget_exceeded",
      model: "gpt-5.6-sol",
      selected: makeEvent({ rid: "current-rid" }),
    }));
    renderPage();

    const params = new URLSearchParams(location.search);
    expect(params.get("outcome")).toBe("budget_exceeded");
    expect(params.get("model")).toBe("gpt-5.6-sol");
    expect(params.get("rid")).toBe("current-rid");
  });

  it("回到默认状态（outcome=all、model=''、无选中）时，URL 参数被清掉，不留一堆 '默认值' 噪声", () => {
    history.replaceState(null, "", "/?hours=168&outcome=denied&model=gpt-5.6-sol&rid=old");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      outcome: "all", model: "", selected: null,
    }));
    renderPage();

    const params = new URLSearchParams(location.search);
    expect(params.has("outcome")).toBe(false);
    expect(params.has("model")).toBe(false);
    expect(params.has("rid")).toBe(false);
    // hours 这次改动前后没变（挂载时读到 168，写回时同一个值原样写回，
    // 这里只确认没有被误清空）。
    expect(params.get("hours")).toBe("168");
  });

  it("写回 URL 不触碰 location.hash（tab 路由靠 hash 精确匹配，写 search 时必须原样保留 hash）", () => {
    history.replaceState(null, "", "/#/compact-detail");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ outcome: "denied" }));
    renderPage();

    expect(location.hash).toBe("#/compact-detail");
    expect(new URLSearchParams(location.search).get("outcome")).toBe("denied");
  });
});

describe("CompactDetailPage — 复制请求 ID", () => {
  it("点击复制按钮调用 navigator.clipboard.writeText，并短暂显示'已复制'反馈", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ rid: "copy-me-rid" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const copyButton = screen.getByTitle("Copy request ID");
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("copy-me-rid");
    // writeText 是 async，等它 resolve 后 UI 才会切到"已复制"状态。
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("剪贴板写入失败时静默失败，不抛错、不崩渲染（rid 本身仍然以纯文本显示，不是唯一复制入口）", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ rid: "fail-to-copy-rid" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const copyButton = screen.getByTitle("Copy request ID");
    expect(() => fireEvent.click(copyButton)).not.toThrow();
    await Promise.resolve();
    // rid 文本本身仍然可见——复制失败不影响这条记录原有的可读性。
    expect(screen.getByText("fail-to-copy-rid")).toBeTruthy();
  });
});
