/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider, useT } from "../../../shared/i18n/context";
import type { CompactOutcomeStats } from "../../../shared/hooks/use-compact-outcomes";

const mockCompactOutcomes = vi.hoisted(() => ({
  useCompactOutcomeStats: vi.fn(),
}));

vi.mock("../../../shared/hooks/use-compact-outcomes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/hooks/use-compact-outcomes")>();
  return { ...actual, useCompactOutcomeStats: mockCompactOutcomes.useCompactOutcomeStats };
});

import { CompactOutcomesCard } from "./CompactOutcomesCard";

function breakdown(overrides: Partial<CompactOutcomeStats["by_session"]> = {}) {
  return {
    success: 10,
    budget_exceeded: 0,
    upstream_failed: 0,
    denied: 0,
    // ★ task #109：顶层 by_request/by_session 恒为 0（那两个口径默认排除
    // fallback_render）——测试默认值反映这条不变量，需要非零值的测试
    // （render 组）会自己 override。
    render_completed: 0,
    total: 10,
    success_rate: 1,
    ...overrides,
  };
}

function makeStats(overrides: Partial<CompactOutcomeStats> = {}): CompactOutcomeStats {
  const b = breakdown();
  return {
    by_session: b,
    by_request: b,
    recent_budget_exceeded: [],
    ...overrides,
  };
}

// `CompactOutcomesCard` 接收 `t` 作为 prop（不是自己调用 `useT()`）——真实
// 调用方（`UsageStats.tsx`/`CompactDetailPage.tsx`）都是自己先拿到 `t` 再
// 传下去，测试里同样需要一个能拿到真实 `t` 的包装组件，不能直接把
// `I18nProvider` 包在外面就指望 `t` prop 自动生效。
function CardWrapper(props: Omit<Parameters<typeof CompactOutcomesCard>[0], "t">) {
  const t = useT();
  return <CompactOutcomesCard t={t} {...props} />;
}

function renderCard(props: Partial<Parameters<typeof CompactOutcomesCard>[0]> = {}) {
  return render(
    <I18nProvider>
      <CardWrapper hours={24} {...props} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockCompactOutcomes.useCompactOutcomeStats.mockReset();
});

describe("CompactOutcomesCard — variant=compact (UsageStats 简化入口)", () => {
  it("显示成功率、总数、'查看详情' 链接，不显示视图/时间窗口切换", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ variant: "compact" });

    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText(/View details/)).toBeTruthy();
    // 简化卡片不应该出现"按会话"/"按请求"这类视图切换文案。
    expect(screen.queryByText("By session")).toBeNull();
    expect(screen.queryByText("By request")).toBeNull();
  });

  it("有预判降级时显示提示行，没有时不显示", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({ by_session: breakdown({ budget_exceeded: 4, success: 6, total: 10, success_rate: 0.6 }) }),
      loading: false,
    });
    const { rerender } = renderCard({ variant: "compact" });
    expect(screen.getByText(/4 predicted downgrade/)).toBeTruthy();

    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    rerender(
      <I18nProvider>
        <CardWrapper hours={24} variant="compact" />
      </I18nProvider>,
    );
    expect(screen.queryByText(/predicted downgrade/)).toBeNull();
  });

  it("零数据时显示'暂无数据'文案，不是 0/0 算出来的 0%", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({ by_session: breakdown({ success: 0, total: 0, success_rate: 0 }) }),
      loading: false,
    });
    renderCard({ variant: "compact" });
    expect(screen.getByText("No data yet")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("loading 时显示 Loading 文案", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: null, loading: true });
    renderCard({ variant: "compact" });
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("★ compact 变体不把 model 透传给 hook（即便父组件传了）——固定看全部型号", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ variant: "compact", model: "gpt-5.6-sol" });
    expect(mockCompactOutcomes.useCompactOutcomeStats).toHaveBeenCalledWith(24, undefined);
  });

  it("★★ 8.19：compact 变体固定使用 by_session 口径（体验视角），即便 by_request 不同", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        by_session: breakdown({ success: 1, total: 1, success_rate: 1 }), // 会话去重后：1 个会话成功
        by_request: breakdown({ success: 1, budget_exceeded: 5, total: 6, success_rate: 1 / 6 }), // 原始事件：6 条
      }),
      loading: false,
    });
    renderCard({ variant: "compact" });
    expect(screen.getByText("100%")).toBeTruthy(); // by_session 的成功率，不是 by_request 的 17%
    expect(screen.getByText(/1 \/ 1/)).toBeTruthy();
  });
});

describe("CompactOutcomesCard — variant=full（默认，压缩明细面板顶部）", () => {
  it("渲染时间窗口切换、四类结果行；不再有按会话/按请求的视图切换", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        by_request: breakdown({ success: 5, budget_exceeded: 2, upstream_failed: 1, denied: 1, total: 9, success_rate: 5 / 9 }),
      }),
      loading: false,
    });
    renderCard();

    expect(screen.queryByText("By session")).toBeNull();
    expect(screen.queryByText("By request")).toBeNull();
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByText("Predicted downgrade")).toBeTruthy();
    expect(screen.getByText("Upstream failed")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("★★★ 8.19 P1 修复：full 变体固定使用 by_request 口径，即便 by_session 算出不同的数字——这是汇总数字必须和下方原始事件列表对得上的核心保证", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        // 同一会话连续 5 次 budget_exceeded 后 1 次 success：by_session 只
        // 算"1 个会话、最后成功"，by_request 才是原始 6 条事件——下方明细
        // 列表天然是原始事件，展示 by_session 会让用户看到"0 次降级"，
        // 但列表里筛"预判降级"却有 5 条，这正是 reviewer2 挡下的 bug。
        by_session: breakdown({ success: 1, budget_exceeded: 0, total: 1, success_rate: 1 }),
        by_request: breakdown({ success: 1, budget_exceeded: 5, total: 6, success_rate: 1 / 6 }),
      }),
      loading: false,
    });
    renderCard();

    expect(screen.getByText("17%")).toBeTruthy(); // Math.round(1/6 * 100)
    expect(screen.getByText(/1 \/ 6/)).toBeTruthy();
    // "预判降级"那一行的计数应该是 5（by_request），不是 0（by_session）——
    // 该行的 div 同时包含 label span 和 count span，closest("div") 就是那
    // 整行。
    const budgetRow = screen.getByText("Predicted downgrade").closest("div")!;
    expect(budgetRow.textContent).toContain("5");
  });

  it("点击时间窗口 pill 调用 onHoursChange", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    const onHoursChange = vi.fn();
    renderCard({ onHoursChange });

    fireEvent.click(screen.getByText("Last 7d"));
    expect(onHoursChange).toHaveBeenCalledWith(168);
  });

  it("★ 点击结果行调用 onSelectOutcome，携带正确的 outcome 值——这是汇总区和下方明细列表联动的落地机制", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        by_request: breakdown({ success: 5, budget_exceeded: 2, upstream_failed: 1, denied: 1, total: 9, success_rate: 5 / 9 }),
      }),
      loading: false,
    });
    const onSelectOutcome = vi.fn();
    renderCard({ onSelectOutcome });

    fireEvent.click(screen.getByText("Predicted downgrade"));
    expect(onSelectOutcome).toHaveBeenCalledWith("budget_exceeded");

    fireEvent.click(screen.getByText("Denied"));
    expect(onSelectOutcome).toHaveBeenCalledWith("denied");
  });

  it("不传 onSelectOutcome 时结果行不可点击（不报错）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard();
    fireEvent.click(screen.getByText("Success"));
    // 没有 onSelectOutcome，点击应该是 no-op，不抛错——测试本身能跑完就是断言。
  });

  it("★ 8.19：固定显示'按请求'计数口径说明文字（不再是按会话时才提示）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard();
    expect(screen.getByText(/per request/)).toBeTruthy();
  });

  it("★★ 8.19：结果类型筛选不反向联动汇总——outcome 变化时 useCompactOutcomeStats 调用参数不受影响（不对称设计的另一半）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ activeOutcome: "budget_exceeded" });
    // 第二个参数只受 model 影响，和 activeOutcome 无关——activeOutcome
    // 只用于高亮，不应该出现在任何传给 hook 的参数里。
    expect(mockCompactOutcomes.useCompactOutcomeStats).toHaveBeenCalledWith(24, undefined);
  });

  it("★ activeOutcome 匹配的那一行有可见的选中态（不只是 hover）——避免'点了但看不出选没选中'", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ activeOutcome: "budget_exceeded" });

    const activeRow = screen.getByText("Predicted downgrade").closest("div")!;
    const otherRow = screen.getByText("Success").closest("div")!;
    expect(activeRow.className).toContain("border-primary/40");
    expect(otherRow.className).not.toContain("border-primary/40");
  });

  it("activeOutcome='all'（或不传）时没有任何一行处于选中态", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ activeOutcome: "all" });
    const rows = ["Success", "Predicted downgrade", "Upstream failed", "Denied"];
    for (const label of rows) {
      const row = screen.getByText(label).closest("div")!;
      expect(row.className).not.toContain("border-primary/40");
    }
  });

  it("★ full 变体把 model 透传给 hook", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard({ model: "gpt-5.6-sol" });
    expect(mockCompactOutcomes.useCompactOutcomeStats).toHaveBeenCalledWith(24, "gpt-5.6-sol");
  });
});

/**
 * ★ task #109（backend-dev 追加落地 /summary 的 render 并列组，team-lead
 * 批准"顶层排除 fallback_render"时明确设成的附加条件）：跟顶层 opaque
 * 分组并列展示的"降级重试"分组——同屏可见，不用切换视图，分母写清楚。
 */
describe("CompactOutcomesCard — variant=full 的 render 并列组", () => {
  function renderBreakdown(overrides: Partial<CompactOutcomeStats["by_session"]> = {}) {
    // fallback_render 路径不会产生 success/budget_exceeded/denied，这三个
    // 恒为 0——跟后端契约保持一致，不是随手写的占位值。
    return {
      success: 0,
      budget_exceeded: 0,
      upstream_failed: 0,
      denied: 0,
      render_completed: 0,
      total: 0,
      // ★★ 这个字段对 render 组没有意义（backend-dev 原话），故意给一个
      // 明显错误的值（1，即 100%）——如果组件不小心直接读了这个字段而不是
      // 自己算 render_completed/total，测试就能抓到。
      success_rate: 1,
      ...overrides,
    };
  }

  it("stats.render 缺省（旧后端还没部署这次改动）时整块不渲染，不是显示成'没数据'", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({ stats: makeStats(), loading: false });
    renderCard();
    expect(screen.queryByText("Fallback Retries")).toBeNull();
  });

  it("stats.render 存在但 total=0 时显示'没数据'", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({ render: { by_request: renderBreakdown(), by_session: renderBreakdown() } }),
      loading: false,
    });
    renderCard();
    expect(screen.getByText("Fallback Retries")).toBeTruthy();
    // "No data yet" 这个文案在 opaque 分组也可能出现（取决于 opaque 是否
    // 有数据）——这里用 getAllByText 容忍两处都可能出现同一段文案。
    expect(screen.getAllByText("No data yet").length).toBeGreaterThan(0);
  });

  it("★ 完成率自己算 render_completed/total，不直接读 success_rate 字段（那个字段对 render 组没有意义）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        // opaque 分组这次故意也给一个跟"骗人的 render success_rate（1）"
        // 不一样的数字（62%），避免 opaque 分组自己合法产出的百分比数字
        // 跟这条测试想抓的 render 组 bug（直接显示了错误的 success_rate=1
        // 即 100%）撞在一起，看不出到底是哪个数字。
        by_request: breakdown({ success: 5, total: 8, success_rate: 5 / 8 }),
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard();

    // 3/4 = 75%，不是 render.by_request.success_rate 字段里骗人的 100%
    // （renderBreakdown() 默认给的 success_rate: 1 就是这个陷阱值）。
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("★ 分母在句子里写清楚（不是只有一个孤立的百分比）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard();
    expect(screen.getByText("3 of 4 completed")).toBeTruthy();
    // 分母提示：明确点破这组的分母跟上面 opaque 那组不是一回事。
    expect(screen.getByText(/different denominator/)).toBeTruthy();
  });

  it("点击 render 分组的行调用 onSelectRenderOutcome，携带正确的 outcome 值", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    const onSelectRenderOutcome = vi.fn();
    renderCard({ onSelectRenderOutcome });

    fireEvent.click(screen.getByText("Completed"));
    expect(onSelectRenderOutcome).toHaveBeenCalledWith("render_completed");

    // "Upstream failed" 同时出现在 opaque 分组和 render 分组——用"点击后
    // 调用了哪个回调"反推点的是哪一行，而不是假设文本唯一。
    const upstreamFailedCandidates = screen.getAllByText("Upstream failed");
    fireEvent.click(upstreamFailedCandidates[upstreamFailedCandidates.length - 1]);
    expect(onSelectRenderOutcome).toHaveBeenCalledWith("upstream_failed");
  });

  it("★★ 消歧义：activeOutcome='upstream_failed' 但 activeCompactPath 不是 'fallback_render' 时，只高亮 opaque 分组那一行，不误伤 render 分组", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        by_request: breakdown({ upstream_failed: 2, total: 12 }),
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard({ activeOutcome: "upstream_failed", activeCompactPath: "opaque" });

    const upstreamFailedCandidates = screen.getAllByText("Upstream failed");
    expect(upstreamFailedCandidates).toHaveLength(2);
    const opaqueRow = upstreamFailedCandidates[0].closest("div")!;
    const renderRow = upstreamFailedCandidates[1].closest("div")!;
    expect(opaqueRow.className).toContain("border-primary/40");
    expect(renderRow.className).not.toContain("border-primary/40");
  });

  it("★★ 消歧义反过来：activeCompactPath='fallback_render' 时只高亮 render 分组那一行，不误伤 opaque 分组", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        by_request: breakdown({ upstream_failed: 2, total: 12 }),
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard({ activeOutcome: "upstream_failed", activeCompactPath: "fallback_render" });

    const upstreamFailedCandidates = screen.getAllByText("Upstream failed");
    const opaqueRow = upstreamFailedCandidates[0].closest("div")!;
    const renderRow = upstreamFailedCandidates[1].closest("div")!;
    expect(opaqueRow.className).not.toContain("border-primary/40");
    expect(renderRow.className).toContain("border-primary/40");
  });

  it("activeOutcome='render_completed' 时 render 分组的'Completed'行高亮", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard({ activeOutcome: "render_completed", activeCompactPath: "fallback_render" });

    const row = screen.getByText("Completed").closest("div")!;
    expect(row.className).toContain("border-primary/40");
  });

  it("不传 onSelectRenderOutcome 时 render 分组的行不可点击（不报错）", () => {
    mockCompactOutcomes.useCompactOutcomeStats.mockReturnValue({
      stats: makeStats({
        render: {
          by_request: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
          by_session: renderBreakdown({ render_completed: 3, upstream_failed: 1, total: 4 }),
        },
      }),
      loading: false,
    });
    renderCard();
    expect(() => fireEvent.click(screen.getByText("Completed"))).not.toThrow();
  });
});
