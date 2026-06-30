/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../shared/i18n/context";

const mockSettings = vi.hoisted(() => ({
  useSettings: vi.fn(() => ({ apiKey: "pwd" })),
}));

const mockGeneralSettings = vi.hoisted(() => ({
  save: vi.fn(),
  useGeneralSettings: vi.fn(),
}));

vi.mock("../../../shared/hooks/use-settings", () => ({
  useSettings: mockSettings.useSettings,
}));

vi.mock("../../../shared/hooks/use-general-settings", () => ({
  useGeneralSettings: mockGeneralSettings.useGeneralSettings,
}));

import { GeneralSettings } from "./GeneralSettings";

function makeGeneralSettingsData(overrides: Record<string, unknown> = {}) {
  return {
    port: 8080,
    proxy_url: null,
    force_http11: false,
    inject_desktop_context: false,
    suppress_desktop_directives: true,
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
  vi.clearAllMocks();
});

describe("GeneralSettings", () => {
  it("disables system prompt strategy selector when the client switch is off", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData(),
      saving: false,
      saved: false,
      error: null,
      restartRequired: false,
      save: mockGeneralSettings.save,
    });

    render(
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("General Settings"));
    const select = screen.getByLabelText("System Prompt Strategy") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("enables system prompt strategy selector immediately after checking the client switch", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData(),
      saving: false,
      saved: false,
      error: null,
      restartRequired: false,
      save: mockGeneralSettings.save,
    });

    render(
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("General Settings"));
    fireEvent.click(screen.getByLabelText("Allow Client System Prompt Strategy"));
    const select = screen.getByLabelText("System Prompt Strategy") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "developer_inline" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      allow_client_system_prompt_strategy: true,
      system_prompt_strategy: "developer_inline",
    });
  });

  it("allows selecting system prompt strategy when the persisted client switch is on", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData({ allow_client_system_prompt_strategy: true }),
      saving: false,
      saved: false,
      error: null,
      restartRequired: false,
      save: mockGeneralSettings.save,
    });

    render(
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("General Settings"));
    const select = screen.getByLabelText("System Prompt Strategy") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "developer_inline" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      system_prompt_strategy: "developer_inline",
    });
  });
});
