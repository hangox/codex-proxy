/** @vitest-environment jsdom */
/**
 * Compact-fallback banner on the Errors page — the Dashboard-side half of
 * "事后可查" for silent root-compact degradation (the other half is the
 * `x-codex-proxy-compact-fallback` response header, see `messages.ts`).
 *
 * Deliberately reuses the existing `/admin/error-logs` grouped data
 * (`useErrorLogs()`) instead of a new endpoint — `recordOpaqueCompactFallback`
 * already writes `error.name: "OpaqueCompactFallback"` records into
 * `error-log.jsonl`, and `groupErrorLog` already folds them into one group
 * with `count`/`last_seen`/`sample_context`. This file tests both the pure
 * extraction logic (`computeCompactFallbackSummary`) and that the page
 * actually renders it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../shared/i18n/context";
import type { ErrorGroup } from "../../../../shared/hooks/use-error-logs";

const mockErrorLogs = vi.hoisted(() => ({
  useErrorLogs: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-error-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../shared/hooks/use-error-logs")>();
  return { ...actual, useErrorLogs: mockErrorLogs.useErrorLogs };
});

import { ErrorsPage, computeCompactFallbackSummary } from "../ErrorsPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function errorLogsState(groups: ErrorGroup[]) {
  return {
    groups,
    count: { total: groups.reduce((n, g) => n + g.count, 0), unread: 0 },
    loading: false,
    error: null,
    refresh: vi.fn(),
    markAllSeen: vi.fn(),
    clearAll: vi.fn(),
  };
}

function fallbackGroup(overrides: Partial<ErrorGroup> = {}): ErrorGroup {
  return {
    signature: "OpaqueCompactFallback|",
    name: "OpaqueCompactFallback",
    message: "CompactServiceError",
    count: 3,
    first_seen: "2026-07-28T10:00:00.000Z",
    last_seen: "2026-07-28T12:00:00.000Z",
    source: "server",
    sample_context: {
      rid: "rid-abcdef12",
      model: "claude-opus-4",
      input_items: 42,
      error_name: "CompactServiceError",
      error_message: "Codex API error (0): peer closed connection without sending TLS close_notify",
      retry_count: 2,
    },
    ...overrides,
  };
}

function renderPage() {
  render(
    <I18nProvider>
      <ErrorsPage />
    </I18nProvider>,
  );
}

describe("computeCompactFallbackSummary", () => {
  it("returns null when there is no OpaqueCompactFallback group", () => {
    expect(computeCompactFallbackSummary([])).toBeNull();
    expect(computeCompactFallbackSummary([
      { ...fallbackGroup(), name: "SomeOtherError", signature: "SomeOtherError|" },
    ])).toBeNull();
  });

  it("extracts count/lastSeen/model/input_items/error_message/retry_count from the most recent event's context", () => {
    const summary = computeCompactFallbackSummary([fallbackGroup()]);
    expect(summary).toEqual({
      count: 3,
      lastSeen: "2026-07-28T12:00:00.000Z",
      lastModel: "claude-opus-4",
      lastInputItems: 42,
      lastErrorMessage: "Codex API error (0): peer closed connection without sending TLS close_notify",
      lastRetryCount: 2,
    });
  });

  it("degrades gracefully when sample_context is missing or fields have unexpected types", () => {
    expect(computeCompactFallbackSummary([
      fallbackGroup({ sample_context: undefined }),
    ])).toEqual({
      count: 3,
      lastSeen: "2026-07-28T12:00:00.000Z",
      lastModel: null,
      lastInputItems: null,
      lastErrorMessage: null,
      lastRetryCount: null,
    });

    expect(computeCompactFallbackSummary([
      fallbackGroup({ sample_context: { model: 42, input_items: "forty-two", error_message: null, retry_count: "two" } }),
    ])).toEqual({
      count: 3,
      lastSeen: "2026-07-28T12:00:00.000Z",
      lastModel: null,
      lastInputItems: null,
      lastErrorMessage: null,
      lastRetryCount: null,
    });
  });
});

describe("ErrorsPage compact-fallback banner", () => {
  it("does not render the banner when there are no OpaqueCompactFallback events", () => {
    mockErrorLogs.useErrorLogs.mockReturnValue(errorLogsState([
      { ...fallbackGroup(), name: "TypeError", signature: "TypeError|at foo" },
    ]));
    renderPage();
    expect(screen.queryByText(/Compact silently fell back/i)).toBeNull();
  });

  it("renders the banner with count, relative time, model, scale, retries, and reason when present", () => {
    mockErrorLogs.useErrorLogs.mockReturnValue(errorLogsState([fallbackGroup()]));
    renderPage();

    expect(screen.getByText(/Compact silently fell back to full generation/i)).toBeTruthy();
    expect(screen.getByText(/3 time\(s\)/)).toBeTruthy();
    expect(screen.getByText("claude-opus-4")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/peer closed connection without sending TLS close_notify/)).toBeTruthy();
  });

  it("does not crash and simply omits optional rows when context fields are absent", () => {
    mockErrorLogs.useErrorLogs.mockReturnValue(errorLogsState([
      fallbackGroup({ sample_context: { rid: "rid-only" } }),
    ]));
    renderPage();
    expect(screen.getByText(/Compact silently fell back to full generation/i)).toBeTruthy();
    expect(screen.queryByText(/Reason:/)).toBeNull();
  });
});
