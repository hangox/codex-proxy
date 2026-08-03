/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";

const mockLogs = vi.hoisted(() => ({
  useLogs: vi.fn(),
}));

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: null })),
}));

const mockGeneralSettings = vi.hoisted(() => ({
  useGeneralSettings: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-logs", () => ({
  useLogs: mockLogs.useLogs,
}));

vi.mock("../../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: mockGeneralSettings.useGeneralSettings,
}));

import { LogsPage } from "../LogsPage";

function makeGeneralSettings(overrides: Record<string, unknown> = {}) {
  return {
    data: { logs_llm_only: true },
    saving: false,
    save: vi.fn(),
    ...overrides,
  };
}

function makeLogsState(overrides: Partial<ReturnType<typeof mockLogs.useLogs>> = {}) {
  return {
    records: [
      {
        id: "1",
        requestId: "r1",
        direction: "ingress",
        ts: "2026-04-15T00:00:01.000Z",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        latencyMs: 10,
      },
    ],
    total: 1,
    loading: false,
    state: { enabled: true, paused: false },
    setLogState: vi.fn(),
    selected: null,
    selectLog: vi.fn(),
    direction: "all",
    setDirection: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    page: 0,
    pageSize: 50,
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    hasPrev: false,
    hasNext: true,
    ...overrides,
  };
}

function renderLogsPage() {
  return render(
    <I18nProvider>
      <LogsPage embedded />
    </I18nProvider>,
  );
}

function hasAncestorClass(element: Element, className: string): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.classList.contains(className)) return true;
    current = current.parentElement;
  }
  return false;
}

afterEach(() => {
  cleanup();
  // URL 同步测试会真的调用 history.replaceState/location.hash——不清理会
  // 让上一条测试的 search 参数泄漏到下一条，产生假阳性/假阴性（同款
  // CompactDetailPage 测试文件里的既有做法，见那边 afterEach 的注释）。
  history.replaceState(null, "", "/");
});

describe("LogsPage", () => {
  it("renders pagination controls and invokes page handlers", () => {
    const nextPage = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState({ nextPage, hasNext: true }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("1 logs")).toBeTruthy();
    expect(screen.getByText("1 total · 1-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(nextPage).toHaveBeenCalledTimes(1);
  });

  it("shows selected log details and clears to hint when nothing is selected", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: { id: "1", path: "/v1/messages" } }));
    const { rerender } = renderLogsPage();
    expect(screen.getByText(/"path": "\/v1\/messages"/)).toBeTruthy();

    mockLogs.useLogs.mockReturnValue(makeLogsState({ selected: null }));
    rerender(
      <I18nProvider>
        <LogsPage embedded />
      </I18nProvider>,
    );
    expect(screen.getByText("Select a log to view details")).toBeTruthy();
  });

  it("renders zero latency as 0ms", () => {
    mockLogs.useLogs.mockReturnValue(
      makeLogsState({
        records: [
          {
            id: "1",
            requestId: "r1",
            direction: "ingress",
            ts: "2026-04-15T00:00:01.000Z",
            method: "GET",
            path: "/v1/models",
            status: 200,
            latencyMs: 0,
          },
        ],
      }),
    );
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(screen.getByText("0ms")).toBeTruthy();
  });

  it("renders and toggles the logs mode button", () => {
    const save = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState());
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings({ save }));

    renderLogsPage();

    fireEvent.click(screen.getByText("Only record LLM logs (click to toggle)"));
    expect(save).toHaveBeenCalledWith({ logs_llm_only: false });
  });

  it("keeps the log list constrained on narrow screens", () => {
    mockLogs.useLogs.mockReturnValue(makeLogsState());
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    const timeHeader = screen.getByText("Time");
    expect(hasAncestorClass(timeHeader, "overflow-x-auto")).toBe(true);
    expect(hasAncestorClass(timeHeader, "min-w-[520px]")).toBe(true);

    const detailsPanel = screen.getByText("Details").parentElement?.parentElement;
    expect(detailsPanel?.className).toContain("w-full");
    expect(detailsPanel?.className).toContain("lg:w-[360px]");
  });
});

// ★ 压缩明细面板的"跳转日志页"链接原来只是一个裸链接，用户得自己复制
// 请求 ID、切页、手动粘进搜索框——这个页面此前完全不读 location.search，
// 是那个跳转补不齐的另一半。这里锁住"进入这个 tab 时如果 URL 带着
// ?search=xxx，搜索框直接是筛好的状态"，不需要用户再做任何一步。
describe("LogsPage — URL 状态同步", () => {
  it("挂载时如果 URL 带 ?search=xxx，调用 logs.setSearch 用这个值预填搜索框", () => {
    history.replaceState(null, "", "/?search=39587bd5#/logs");
    const setSearch = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState({ setSearch }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(setSearch).toHaveBeenCalledWith("39587bd5");
  });

  it("URL 没有 search 参数时不调用 setSearch（不覆盖用户已经在输的搜索词）", () => {
    history.replaceState(null, "", "/#/logs");
    const setSearch = vi.fn();
    mockLogs.useLogs.mockReturnValue(makeLogsState({ setSearch }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(setSearch).not.toHaveBeenCalled();
  });

  it("logs.search 变化时写回 location.search 的 search 参数，不碰 location.hash", () => {
    history.replaceState(null, "", "/#/logs");
    mockLogs.useLogs.mockReturnValue(makeLogsState({ search: "target-rid" }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(new URLSearchParams(location.search).get("search")).toBe("target-rid");
    expect(location.hash).toBe("#/logs");
  });

  it("logs.search 清空时从 URL 里删掉 search 参数，不留下空值", () => {
    history.replaceState(null, "", "/?search=old#/logs");
    mockLogs.useLogs.mockReturnValue(makeLogsState({ search: "" }));
    mockGeneralSettings.useGeneralSettings.mockReturnValue(makeGeneralSettings());

    renderLogsPage();

    expect(new URLSearchParams(location.search).has("search")).toBe(false);
  });
});
