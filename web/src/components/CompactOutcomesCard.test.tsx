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
