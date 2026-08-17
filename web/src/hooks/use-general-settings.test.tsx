/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGeneralSettings, type GeneralSettingsData } from "../../../shared/hooks/use-general-settings";
import { useState } from "preact/hooks";

const budgetRows = [
  {
    model: "gpt-5.6-sol",
    recommended_tokens: 900_000,
    override_tokens: null,
    effective_tokens: 900_000,
    verified_success_tokens: 920_038,
    first_failure_tokens: 925_000,
    experimental: false,
  },
  {
    model: "gpt-5.6-terra",
    recommended_tokens: 900_000,
    override_tokens: null,
    effective_tokens: 900_000,
    verified_success_tokens: 920_038,
    first_failure_tokens: 925_000,
    experimental: false,
  },
  {
    model: "gpt-5.6-luna",
    recommended_tokens: 900_000,
    override_tokens: null,
    effective_tokens: 900_000,
    verified_success_tokens: 920_038,
    first_failure_tokens: 925_000,
    experimental: false,
  },
  {
    model: "gpt-5.5",
    recommended_tokens: 320_000,
    override_tokens: null,
    effective_tokens: 320_000,
    verified_success_tokens: 340_081,
    first_failure_tokens: 350_000,
    experimental: false,
  },
];

function makeSettings(overrides: Partial<GeneralSettingsData> = {}): GeneralSettingsData {
  return {
    port: 8080,
    proxy_url: null,
    force_http11: false,
    inject_desktop_context: false,
    suppress_desktop_directives: true,
    claude_code_opaque_compact_experimental: false,
    opaque_compact_token_budget_overrides: {},
    opaque_compact_budget_allowed_models: budgetRows.map((row) => row.model),
    opaque_compact_budgets: budgetRows,
    allow_client_system_prompt_strategy: false,
    system_prompt_strategy: "instructions",
    default_model: "gpt-5.4",
    default_reasoning_effort: null,
    model_aliases: {},
    refresh_enabled: true,
    refresh_margin_seconds: 300,
    refresh_concurrency: 2,
    max_concurrent_per_account: 3,
    request_interval_ms: 50,
    auto_update: true,
    auto_download: false,
    show_update_dialog: false,
    logs_enabled: false,
    logs_capacity: 2000,
    logs_capture_body: false,
    logs_llm_only: true,
    usage_history_retention_days: null,
    credits_per_usd: 25,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function requireLatest(state: ReturnType<typeof useGeneralSettings> | null): ReturnType<typeof useGeneralSettings> {
  if (!state) throw new Error("hook state is not ready");
  return state;
}

describe("useGeneralSettings", () => {
  it("loads the opaque budget rows and preserves them after a hot save", async () => {
    const updated = makeSettings({
      opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 },
      opaque_compact_budgets: budgetRows.map((row) => row.model === "gpt-5.6-sol"
        ? { ...row, override_tokens: 880_000, effective_tokens: 880_000 }
        : row),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(makeSettings()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...updated, success: true, restart_required: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    let latest: ReturnType<typeof useGeneralSettings> | null = null;
    function Harness() {
      const state = useGeneralSettings("secret");
      latest = state;
      const [renderCount] = useState(0);
      return <span data-testid="row-count">{state.data?.opaque_compact_budgets.length ?? renderCount}</span>;
    }

    render(<Harness />);
    await waitFor(() => expect(requireLatest(latest).data?.opaque_compact_budgets).toHaveLength(4));
    expect(requireLatest(latest).data?.opaque_compact_budgets[0]?.model).toBe("gpt-5.6-sol");

    await requireLatest(latest).save({ opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 } });
    await waitFor(() => expect(requireLatest(latest).data?.opaque_compact_budgets[0]?.override_tokens).toBe(880_000));
    expect(fetchMock).toHaveBeenLastCalledWith("/admin/general-settings", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      body: JSON.stringify({ opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 } }),
    }));
  });

  it("returns false and keeps loaded budget data when a save is rejected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(makeSettings()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "budget rejected" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    let latest: ReturnType<typeof useGeneralSettings> | null = null;
    function Harness() {
      latest = useGeneralSettings("secret");
      return null;
    }

    render(<Harness />);
    await waitFor(() => expect(requireLatest(latest).data?.opaque_compact_budgets).toHaveLength(4));

    const result = await requireLatest(latest).save({
      opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 925_000 },
    });

    expect(result).toBe(false);
    await waitFor(() => expect(requireLatest(latest).error).toBe("budget rejected"));
    expect(requireLatest(latest).saved).toBe(false);
    expect(requireLatest(latest).data?.opaque_compact_token_budget_overrides).toEqual({});
    expect(fetchMock).toHaveBeenLastCalledWith("/admin/general-settings", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 925_000 } }),
    }));
  });
});
