/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/preact";
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
    claude_code_opaque_compact_experimental: false,
    opaque_compact_token_budget_overrides: {},
    opaque_compact_budget_allowed_models: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "my-experimental-model",
    ],
    opaque_compact_budgets: [
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
    ],
    allow_client_system_prompt_strategy: false,
    system_prompt_strategy: "instructions",
    default_model: "gpt-5.4",
    default_reasoning_effort: null,
    image_host_model: "gpt-5.5",
    image_host_model_allowed_models: ["gpt-5.4", "gpt-5.5", "img-fast"],
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

  it("saves multiple opaque compact budget overrides in one request", () => {
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
    fireEvent.input(screen.getByLabelText("gpt-5.6-sol Override"), { target: { value: "880000" } });
    fireEvent.input(screen.getByLabelText("gpt-5.5 Override"), { target: { value: "340000" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000, "gpt-5.5": 340_000 },
    });
  });

  it("resets one override to automatic without dropping another edited model", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData({
        opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000, "gpt-5.5": 340_000 },
        opaque_compact_budgets: [
          {
            model: "gpt-5.6-sol",
            recommended_tokens: 900_000,
            override_tokens: 880_000,
            effective_tokens: 880_000,
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
            override_tokens: 340_000,
            effective_tokens: 340_000,
            verified_success_tokens: 340_081,
            first_failure_tokens: 350_000,
            experimental: false,
          },
        ],
      }),
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
    fireEvent.click(screen.getAllByText("Reset")[0]);
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      opaque_compact_token_budget_overrides: { "gpt-5.5": 340_000 },
    });
  });

  it("adds a registered custom model to the same save payload", () => {
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
    fireEvent.input(screen.getByLabelText("Add custom model"), { target: { value: "my-experimental-model" } });
    fireEvent.input(screen.getByLabelText("Override"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Add"));
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      opaque_compact_token_budget_overrides: { "my-experimental-model": 123_456 },
    });
  });

  it("rejects an unregistered custom model before creating a draft", () => {
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData({
        opaque_compact_budget_allowed_models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
      }),
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
    fireEvent.input(screen.getByLabelText("Add custom model"), { target: { value: "not-registered-model" } });
    fireEvent.input(screen.getByLabelText("Override"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Add"));

    expect(screen.getByText(/not routable yet/)).toBeTruthy();
    expect(screen.queryByText("not-registered-model")).toBeNull();
    expect(mockGeneralSettings.save).not.toHaveBeenCalled();
  });

  it("blocks a calibrated override at the first failure boundary", () => {
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
    fireEvent.input(screen.getByLabelText("gpt-5.6-sol Override"), { target: { value: "925000" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).not.toHaveBeenCalled();
    expect(screen.getAllByText(/first verified failure boundary/).length).toBeGreaterThan(0);
  });

  it("keeps budget drafts when the backend rejects the save", async () => {
    const save = vi.fn().mockResolvedValue(false);
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData({
        opaque_compact_budget_allowed_models: [
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "gpt-5.5",
          "my-experimental-model",
        ],
      }),
      saving: false,
      saved: false,
      error: "budget rejected",
      restartRequired: false,
      save,
    });

    render(
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("General Settings"));
    fireEvent.input(screen.getByLabelText("gpt-5.6-sol Override"), { target: { value: "880000" } });
    fireEvent.input(screen.getByLabelText("Add custom model"), { target: { value: "my-experimental-model" } });
    fireEvent.input(screen.getByLabelText("Override"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Add"));
    fireEvent.click(screen.getByText("Submit"));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      opaque_compact_token_budget_overrides: {
        "gpt-5.6-sol": 880_000,
        "my-experimental-model": 123_456,
      },
    }));
    expect((screen.getByLabelText("gpt-5.6-sol Override") as HTMLInputElement).value).toBe("880000");
    expect(screen.getByText("my-experimental-model")).toBeTruthy();
    expect((screen.getByLabelText("my-experimental-model Override") as HTMLInputElement).value).toBe("123456");
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

  it("renders the current image host model and saves a new selection", () => {
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
    const input = screen.getByLabelText("Images API Host Model") as HTMLInputElement;
    expect(input.value).toBe("gpt-5.5");

    fireEvent.input(input, { target: { value: "gpt-5.4" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).toHaveBeenCalledWith({
      image_host_model: "gpt-5.4",
    });
  });

  it("keeps the image host model draft when the backend rejects the save", async () => {
    const save = vi.fn().mockResolvedValue(false);
    mockGeneralSettings.useGeneralSettings.mockReturnValue({
      data: makeGeneralSettingsData(),
      saving: false,
      saved: false,
      error: "image host model rejected",
      restartRequired: false,
      save,
    });

    render(
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("General Settings"));
    const input = screen.getByLabelText("Images API Host Model") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "gpt-5.4" } });
    fireEvent.click(screen.getByText("Submit"));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ image_host_model: "gpt-5.4" }));
    expect((screen.getByLabelText("Images API Host Model") as HTMLInputElement).value).toBe("gpt-5.4");
  });

  it("blocks an image host model that is not in the allowed list before saving", () => {
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
    const input = screen.getByLabelText("Images API Host Model") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "not-in-allowed-list" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(mockGeneralSettings.save).not.toHaveBeenCalled();
    expect(screen.getByText(/not an available Images host model/)).toBeTruthy();
    expect((screen.getByLabelText("Images API Host Model") as HTMLInputElement).value).toBe("not-in-allowed-list");
  });
});
