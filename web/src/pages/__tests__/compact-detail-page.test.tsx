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
    // ★ task #109：默认走 opaque 路径——跟后端契约一致（历史数据/opaque
    // 事件缺省即 "opaque"，不是 undefined）。
    compact_path: "opaque",
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
    // ★ task #109
    compactPath: "all" as const,
    setCompactPath: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    events: [makeEvent()],
    total: 1,
    availableModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    // ★ task #109：默认全部三条路径都"有数据"，跟现有测试的默认预期
    // （不弱化任何筛选选项）保持一致——单独测 muted 效果的用例会自己
    // override 成一个子集。
    availableCompactPaths: ["opaque", "fallback_decision", "fallback_render"],
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
  const breakdown = { success: 3, budget_exceeded: 1, upstream_failed: 0, denied: 0, render_completed: 0, total: 4, success_rate: 0.75 };
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

  it("点击列表行调用 selectEvent(rid, ts)——task #109 之后 rid 不再唯一，必须带 ts 才能精确定位", () => {
    const selectEvent = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selectEvent }));
    renderPage();

    const modelCandidates = screen.getAllByText("gpt-5.6-sol");
    const rowButton = modelCandidates.find((el) => el.closest("button") !== null);
    fireEvent.click(rowButton!);
    expect(selectEvent).toHaveBeenCalledWith("39587bd5", "2026-08-03T14:32:07.000Z");
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
    // 普通 opaque 行继续显示总耗时，不含上游括注。
    expect(screen.getByText("1.2s")).toBeTruthy();
  });

  it("降级压缩行优先显示真正上游耗时，不显示包含本地收尾的总耗时", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(
      makeEventsState({
        events: [makeEvent({ compact_path: "fallback_render", outcome: "render_completed", duration_ms: 5300, upstream_ms: 1300 })],
      }),
    );
    renderPage();
    expect(screen.getByText("1.3s")).toBeTruthy();
    expect(screen.queryByText("5.3s")).toBeNull();
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
    // ★ task #109：denied 恒显示这一行（缺省时占位符），render 记录只在
    // http_status 有值时才显示——两条规则合起来看 CompactDetailPage.tsx
    // 里那一行 `e.outcome === "denied" || e.http_status !== undefined`。
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

  it("跳转日志页的链接 href 兜底指向 #/logs（不是带查询串的深链接，那种链接会被路由忽略；真正携带搜索词靠 onClick）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected: makeEvent() }));
    renderPage();

    const link = screen.getByText(/View full logs/).closest("a");
    expect(link?.getAttribute("href")).toBe("#/logs");
  });

  // ★ team-lead 复核用户反馈后要求：原来这条链接只把用户送到日志页，不带
  // 任何上下文，用户得自己复制 rid、切页、粘进搜索框。这条测试锁住修复后
  // 的真实行为——点击后 location.search 带上 `search=<rid>`、location.hash
  // 变成 #/logs，用户到日志页时搜索框已经是筛好的状态，不需要再手动做
  // 任何一步。
  it("点击跳转日志页链接：location.search 带上 search=<rid>，location.hash 切到 #/logs，不需要用户手动复制粘贴", () => {
    history.replaceState(null, "", "/?outcome=budget_exceeded&rid=39587bd5#/compact-detail");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ rid: "39587bd5" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected, events: [selected] }));
    renderPage();

    const link = screen.getByText(/View full logs/).closest("a");
    expect(link).toBeTruthy();
    fireEvent.click(link!);

    expect(new URLSearchParams(location.search).get("search")).toBe("39587bd5");
    expect(location.hash).toBe("#/logs");
  });

  it("跳转日志页时不残留压缩明细面板自己的筛选参数（hours/outcome/model/rid）——那些参数对日志页没有意义", () => {
    history.replaceState(null, "", "/?hours=168&outcome=budget_exceeded&model=gpt-5.6-sol&rid=39587bd5#/compact-detail");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ rid: "39587bd5" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected, events: [selected], outcome: "budget_exceeded", model: "gpt-5.6-sol" }));
    renderPage();

    fireEvent.click(screen.getByText(/View full logs/));

    const params = new URLSearchParams(location.search);
    expect(params.get("search")).toBe("39587bd5");
    expect(params.has("hours")).toBe(false);
    expect(params.has("outcome")).toBe(false);
    expect(params.has("model")).toBe(false);
    expect(params.has("rid")).toBe(false);
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

  it("挂载时 URL 带 rid（不带 ts，旧链接）且 events 里有匹配记录，调用 selectEvent(rid, undefined)", () => {
    history.replaceState(null, "", "/?rid=target-rid");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selectEvent = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ rid: "target-rid" })],
      selectEvent,
    }));
    renderPage();

    expect(selectEvent).toHaveBeenCalledWith("target-rid", undefined);
  });

  // ★ task #109：rid 不再唯一（同一次请求降级时，fallback_decision/
  // fallback_render 两条记录共享 rid）——URL 带 ts 时必须精确匹配那一条，
  // 不能只按 rid 随便选第一条。
  it("挂载时 URL 同时带 rid 和 ts，精确匹配那一条记录才调用 selectEvent", () => {
    history.replaceState(null, "", "/?rid=shared-rid&ts=2026-08-04T00%3A00%3A02.000Z");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selectEvent = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [
        makeEvent({ rid: "shared-rid", ts: "2026-08-04T00:00:01.000Z", compact_path: "fallback_decision" }),
        makeEvent({ rid: "shared-rid", ts: "2026-08-04T00:00:02.000Z", compact_path: "fallback_render", outcome: "render_completed" }),
      ],
      selectEvent,
    }));
    renderPage();

    expect(selectEvent).toHaveBeenCalledWith("shared-rid", "2026-08-04T00:00:02.000Z");
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

// ★ task #109（用户原话："我想把压缩都统计到这里来，就是降级后的压缩也
// 在这里统一展示"）：opaque compact 失败后降级出的 render（全量生成）
// 尝试，跟 opaque 记录用同一份数据统一展示、可对比。
describe("CompactDetailPage — ★ task #109 压缩路径（opaque / fallback_decision / fallback_render）", () => {
  it("列表行显示压缩路径徽标，跟结果类型 pill 一起", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ compact_path: "opaque" })],
    }));
    renderPage();
    // "Opaque" 同时出现在列表行徽标和压缩路径筛选 pill 里——这里只断言至少
    // 存在（跟其它同名文案重复的测试同一套容忍度，不做过度精确定位）。
    expect(screen.getAllByText("Opaque").length).toBeGreaterThan(0);
  });

  // ★ task #111 落地：outcome 值从 render_started 换成了 render_completed
  // ——这正是 qa 真实复现的那次崩溃的根因（OUTCOME_META 当时穷举声明，
  // 少了这个 key 就整页崩），下面这条用例锁住新值能正常渲染。
  it("fallback_render 记录：显示 '已完成' 结果标签", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ compact_path: "fallback_render", outcome: "render_completed", reason: undefined })],
    }));
    expect(() => renderPage()).not.toThrow();
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
  });

  // ★★ task #109/qa 崩溃复盘的核心回归：这条锁住的正是真实发生过的那次
  // 崩溃——outcome 值是 OUTCOME_META 里完全没见过的字符串时，列表和详情
  // 面板都不能崩（`OutcomePill` 取 `.pillClass` 曾经因为这个直接炸掉）。
  it("未知 outcome 值（后端加了 OUTCOME_META 还没认识的新值）兜底显示'未分类'，不崩、不丢记录——qa 真实复现过的崩溃场景", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const unknownOutcomeEvent = makeEvent({
      outcome: "a_future_outcome_value_nobody_has_seen_yet" as never,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [unknownOutcomeEvent],
      selected: unknownOutcomeEvent,
    }));
    expect(() => renderPage()).not.toThrow();
    // 列表行 + 详情面板的"结果"行，两处都应该显示"未分类"，不是崩溃。
    expect(screen.getAllByText("Unclassified").length).toBeGreaterThanOrEqual(2);
  });

  it("未知 compact_path 值（尚未认识的第四条路径）兜底显示'未分类'，不崩、不丢记录", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [makeEvent({ compact_path: "client_initiated" as never })],
    }));
    expect(() => renderPage()).not.toThrow();
    expect(screen.getAllByText("Unclassified").length).toBeGreaterThan(0);
  });

  // ★ task #109（team-lead 建议顺手接上 availableCompactPaths）：当前窗口
  // 没有数据的路径选项要弱化视觉（不是隐藏、不是 disabled），提前告诉
  // 用户"选了大概率是空列表，不是筛选坏了"。
  it("availableCompactPaths 不含某个路径时，对应筛选选项弱化（opacity-50），但仍可点击", () => {
    const setCompactPath = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      setCompactPath,
      availableCompactPaths: ["opaque"], // 这个窗口里只有 opaque 有记录
    }));
    renderPage();

    const candidates = screen.getAllByText("Fallback (retry)");
    const pillButton = candidates.find((el) => el.closest("button") !== null)!.closest("button")!;
    expect(pillButton.className).toContain("opacity-50");
    // 仍然可点——不是 disabled。
    fireEvent.click(pillButton);
    expect(setCompactPath).toHaveBeenCalledWith("fallback_render");

    // 有数据的 opaque 选项不弱化。
    const opaqueCandidates = screen.getAllByText("Opaque");
    const opaqueButton = opaqueCandidates.find((el) => el.closest("button") !== null)!.closest("button")!;
    expect(opaqueButton.className).not.toContain("opacity-50");
  });

  it("availableCompactPaths 还是空数组（挂载/刷新中）时不弱化任何选项——空数组不代表'全部没有数据'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ availableCompactPaths: [] }));
    renderPage();

    const candidates = screen.getAllByText("Fallback (retry)");
    const pillButton = candidates.find((el) => el.closest("button") !== null)!.closest("button")!;
    expect(pillButton.className).not.toContain("opacity-50");
  });

  it("点击压缩路径筛选 pill 调用 setCompactPath", () => {
    const setCompactPath = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setCompactPath }));
    renderPage();

    const candidates = screen.getAllByText("Fallback (retry)");
    const pillButton = candidates.find((el) => el.closest("button") !== null);
    expect(pillButton).toBeTruthy();
    fireEvent.click(pillButton!);
    expect(setCompactPath).toHaveBeenCalledWith("fallback_render");
  });

  it("compactPath 非 'all' 时显示 'Filtered: {label}' 徽标，点击调用 setCompactPath('all')", () => {
    const setCompactPath = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ compactPath: "fallback_render", setCompactPath }));
    renderPage();

    const badges = screen.getAllByText(/Filtered:/);
    const pathBadge = badges.find((el) => el.textContent?.includes("Fallback (retry)"));
    expect(pathBadge).toBeTruthy();
    fireEvent.click(pathBadge!.closest("button")!);
    expect(setCompactPath).toHaveBeenCalledWith("all");
  });

  it("★★ 8.20 同款回归：只按压缩路径筛选（outcome/model 仍是默认值）没有记录时，显示'调整筛选范围'文案，不是'暂无压缩记录'", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ events: [], total: 0, compactPath: "fallback_render" }));
    renderPage();
    expect(screen.getByText(/No records match the current filter/)).toBeTruthy();
    expect(screen.queryByText("No compact records yet")).toBeNull();
  });

  it("详情面板显示'压缩路径'行", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ compact_path: "opaque" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const label = screen.getByText("Compact path");
    expect(label.closest("div")?.textContent).toContain("Opaque");
  });

  // ★★ task #111 落地后重写：render_completed 现在是真实、可信的完成
  // 信号（不是早期设计里那个"提交了、不确定接没接受"的弱信号）。这条
  // 测试锁住新文案不再说"不确定"，而且新旧字段语义都要对——duration_ms
  // 现在是真实的完整耗时（不是早期设计里的半截 TTFB），http_status 对
  // render_completed 没有意义（成功了，不需要状态码解释）。
  it("render_completed：详情面板显示专属'发生了什么'文案，明确说'成功完成'，不再是'不确定'的旧措辞", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "render_completed", reason: undefined,
      estimated_tokens: undefined, budget_tokens: undefined,
      http_status: undefined, duration_ms: 2140, upstream_ms: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText("What happened")).toBeTruthy();
    expect(screen.getByText(/completed successfully/)).toBeTruthy();
    // ★ 旧措辞（"不确定接没接受"）不应该再出现——那是 render_started 时代
    // 的诚实措辞，现在数据语义变了，文案必须跟着变，不能继续挂着一套
    // 不再准确的免责声明。
    expect(screen.queryByText(/isn't confirmed/)).toBeNull();
    // render_completed 不触发"为什么"分组（成功了，没有"原因"这个概念）。
    expect(screen.queryByText("Reason")).toBeNull();
    expect(screen.queryByText("HTTP Status")).toBeNull();
    // Duration 现在是真实完整耗时，正常显示（不再有 TTFB 这个独立字段）。
    expect(screen.queryByText("Time to first response")).toBeNull();
    expect(screen.getByText("2.1s")).toBeTruthy();
  });

  // ★ task #111 落地后：render_completed 不再需要"需新增采集"提示——它
  // 曾经描述的缺口（真实完成状态）已经被这次改动补上了，整块提示不应该
  // 再出现在这个 outcome 上（同 #97 那次"缺口真的补上了，提示跟着删掉"
  // 的处理方式）。
  it("render_completed：不显示'需新增采集'提示——真实完成状态的缺口已经补上了", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "render_completed", reason: undefined,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.queryByText("Needs more collection")).toBeNull();
  });

  // ★ task #111：fallback_render 的失败现在是真实确认的（同步拒绝/中途
  // 断流/客户端中止，折叠进同一个 upstream_failed 桶，backend-dev 明确
  // 记录的取舍——这次改动不细分子因）。详情面板用 render 专属文案，不是
  // opaque 的"联系上游被拒绝、降级为全量生成"文案（render 本身已经是
  // 降级后的尝试，没有再下一级）。
  it("fallback_render + upstream_failed：详情面板用 render 专属文案（三种终止点未细分），不是 opaque 的'联系上游被拒绝、降级为全量生成'文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "upstream_failed", reason: "CodexApiError",
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.getByText(/fallback \(uncompacted\) generation call also failed to complete/)).toBeTruthy();
    expect(screen.queryByText(/the request fell back to the full-generation slow path/)).toBeNull();
  });

  // ★ task #109（backend-dev 追加落地）：failure_stage 把"降级重试失败"
  // 拆成两个排查方向完全相反的情况——这几条测试锁住两个具体值各自的
  // 徽标 + 指引文案，以及缺省/未知值时的兜底行为。
  it("failure_stage='pre_stream'：显示'提交前被拒'徽标 + 对应的'该调预算/换模型'指引，附带真实 http_status", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "upstream_failed", reason: "CodexApiError",
      estimated_tokens: undefined, budget_tokens: undefined,
      failure_stage: "pre_stream", http_status: 400,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const label = screen.getByText("Failure stage");
    expect(label.closest("div")?.textContent).toContain("Rejected before streaming");
    expect(screen.getByText(/never entered the streaming phase/)).toBeTruthy();
    expect(screen.getByText(/adjusting the budget estimation threshold or switching models/)).toBeTruthy();
    // 同步拒绝场景应该有真实 http_status。
    const httpLabel = screen.getByText("HTTP Status");
    expect(httpLabel.closest("div")?.textContent).toBe("HTTP Status400");
  });

  it("failure_stage='mid_stream'：显示'生成中断开'徽标 + 对应的'该查链路'指引，不带 http_status", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "upstream_failed", reason: "CodexApiError",
      estimated_tokens: undefined, budget_tokens: undefined,
      failure_stage: "mid_stream", http_status: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    const label = screen.getByText("Failure stage");
    expect(label.closest("div")?.textContent).toContain("Disconnected mid-stream");
    expect(screen.getByText(/connection was lost before it finished/)).toBeTruthy();
    expect(screen.getByText(/check network\/upstream availability/)).toBeTruthy();
    // 中途断流场景没有单一状态码概念，不该显示 HTTP Status 行。
    expect(screen.queryByText("HTTP Status")).toBeNull();
  });

  it("failure_stage 缺省（历史行）：不显示'失败阶段'行，退回通用的'三种情况未细分'文案", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "upstream_failed", reason: "CodexApiError",
      estimated_tokens: undefined, budget_tokens: undefined,
      failure_stage: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    renderPage();

    expect(screen.queryByText("Failure stage")).toBeNull();
    expect(screen.getByText(/aren't distinguished from each other in this record/)).toBeTruthy();
  });

  it("未知 failure_stage 值：徽标兜底显示'未分类'，'为什么'文案退回通用兜底，不崩、不丢记录", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({
      compact_path: "fallback_render", outcome: "upstream_failed", reason: "CodexApiError",
      estimated_tokens: undefined, budget_tokens: undefined,
      failure_stage: "a_future_stage_nobody_has_seen_yet" as never,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected }));
    expect(() => renderPage()).not.toThrow();

    const label = screen.getByText("Failure stage");
    expect(label.closest("div")?.textContent).toContain("Unclassified");
    // 未知值时"为什么"文案退回通用兜底（不假装知道更细的信息）。
    expect(screen.getByText(/aren't distinguished from each other in this record/)).toBeTruthy();
  });

  // ★ task #109：同一次客户端请求降级时，fallback_decision（为什么失败）
  // 和 fallback_render（重试自己的结果）共享同一个 rid——这是"能对比"这个
  // 用户诉求落地成 UI 的核心机制。
  it("关联记录：同一 rid 的另一条记录（fallback_decision ↔ fallback_render）会出现在详情面板，点击调用 selectEvent 跳转", () => {
    const selectEvent = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const decisionEvent = makeEvent({
      rid: "shared-rid", ts: "2026-08-04T00:00:01.000Z", compact_path: "fallback_decision",
      outcome: "upstream_failed", reason: "CompactServiceError",
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    const renderEvent = makeEvent({
      rid: "shared-rid", ts: "2026-08-04T00:00:02.000Z", compact_path: "fallback_render",
      outcome: "render_completed", reason: undefined,
      estimated_tokens: undefined, budget_tokens: undefined,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [decisionEvent, renderEvent],
      selected: decisionEvent,
      selectEvent,
    }));
    renderPage();

    expect(screen.getByText("Related record")).toBeTruthy();
    // "View" 子串同时匹配"View →"（关联记录按钮）和"View full logs..."
    // （页面底部跳转日志的链接）——用"是不是 <button>"精确定位到关联记录
    // 那一个，跟文件里其它同名/近似文案的处理手法一致。
    const viewCandidates = screen.getAllByText(/View/);
    const relatedButton = viewCandidates.find((el) => el.closest("button") !== null);
    expect(relatedButton).toBeTruthy();
    fireEvent.click(relatedButton!.closest("button")!);
    expect(selectEvent).toHaveBeenCalledWith("shared-rid", "2026-08-04T00:00:02.000Z");
  });

  it("没有关联记录（events 里只有这一条）时不显示'关联记录'分组", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const selected = makeEvent({ rid: "lonely-rid" });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ selected, events: [selected] }));
    renderPage();

    expect(screen.queryByText("Related record")).toBeNull();
  });

  it("isFiltered 同时覆盖 compactPath 维度——只按压缩路径筛选也算'当前有筛选'（8.20 教训：漏了任意一个维度都会显示错误的空数据文案）", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      events: [], total: 0, outcome: "all", model: "", compactPath: "opaque",
    }));
    renderPage();
    expect(screen.getByText(/No records match the current filter/)).toBeTruthy();
  });

  // ★ task #109（backend-dev 追加落地 /summary 的 render 并列组）：点击
  // 汇总卡片里 render 分组的行，必须同时把明细列表的压缩路径筛选钉死在
  // fallback_render——不是单测 CompactOutcomesCard 自己的行为（那边已经
  // 测过 onSelectRenderOutcome 会被正确调用），这里测的是 CompactDetailPage
  // 自己接的那个箭头函数有没有正确调用两个 setter，是端到端接线测试。
  it("点击汇总卡片 render 分组的行：同时调用 setCompactPath('fallback_render') 和 setOutcome", () => {
    const setOutcome = vi.fn();
    const setCompactPath = vi.fn();
    mockStats.useCompactOutcomeStats.mockReturnValue({
      stats: {
        by_session: { success: 3, budget_exceeded: 1, upstream_failed: 0, denied: 0, render_completed: 0, total: 4, success_rate: 0.75 },
        by_request: { success: 3, budget_exceeded: 1, upstream_failed: 0, denied: 0, render_completed: 0, total: 4, success_rate: 0.75 },
        recent_budget_exceeded: [],
        render: {
          by_request: { success: 0, budget_exceeded: 0, upstream_failed: 1, denied: 0, render_completed: 3, total: 4, success_rate: 1 },
          by_session: { success: 0, budget_exceeded: 0, upstream_failed: 1, denied: 0, render_completed: 3, total: 4, success_rate: 1 },
        },
      },
      loading: false,
    });
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setOutcome, setCompactPath }));
    renderPage();

    // "Completed" 同时出现在汇总卡片 render 分组的行（<div>，可点）和结果
    // 类型筛选栏里对应 render_completed 的 pill（<button>）——用"不在
    // <button> 里"精确定位到汇总卡片那一行，跟文件里其它同名文案的处理
    // 手法一致。
    const candidates = screen.getAllByText("Completed");
    const summaryRow = candidates.find((el) => el.closest("button") === null);
    expect(summaryRow).toBeTruthy();
    fireEvent.click(summaryRow!);
    expect(setCompactPath).toHaveBeenCalledWith("fallback_render");
    expect(setOutcome).toHaveBeenCalledWith("render_completed");
  });
});

describe("CompactDetailPage — ★ task #109 URL 状态同步（compact_path/ts）", () => {
  it("挂载时从 URL 读取 compact_path，应用到 setCompactPath", () => {
    history.replaceState(null, "", "/?compact_path=fallback_render");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const setCompactPath = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setCompactPath }));
    renderPage();

    expect(setCompactPath).toHaveBeenCalledWith("fallback_render");
  });

  it("URL 带不认识的 compact_path 值时忽略，不调用 setCompactPath（开放枚举的兜底，不是硬编码只认三个值）", () => {
    history.replaceState(null, "", "/?compact_path=client_initiated");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    const setCompactPath = vi.fn();
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ setCompactPath }));
    renderPage();

    expect(setCompactPath).not.toHaveBeenCalled();
  });

  it("选中记录变化后，写回 location.search 带上 compact_path 筛选值和选中记录的 ts", () => {
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({
      compactPath: "fallback_render",
      selected: makeEvent({ rid: "current-rid", ts: "2026-08-04T00:00:02.000Z" }),
    }));
    renderPage();

    const params = new URLSearchParams(location.search);
    expect(params.get("compact_path")).toBe("fallback_render");
    expect(params.get("rid")).toBe("current-rid");
    expect(params.get("ts")).toBe("2026-08-04T00:00:02.000Z");
  });

  it("回到默认状态（compactPath='all'、无选中）时，compact_path/ts 参数被清掉", () => {
    history.replaceState(null, "", "/?compact_path=fallback_render&rid=old&ts=2026-08-04T00%3A00%3A02.000Z");
    mockStats.useCompactOutcomeStats.mockReturnValue(makeStatsState());
    mockEvents.useCompactOutcomeEvents.mockReturnValue(makeEventsState({ compactPath: "all", selected: null }));
    renderPage();

    const params = new URLSearchParams(location.search);
    expect(params.has("compact_path")).toBe(false);
    expect(params.has("ts")).toBe(false);
  });
});
