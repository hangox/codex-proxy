/**
 * Tests for general settings endpoints.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = {
  server: { port: 8080, proxy_api_key: null as string | null },
  tls: { proxy_url: null as string | null, force_http11: false },
  model: {
    default: "gpt-5.4",
    default_reasoning_effort: null as string | null,
    image_host_model: "gpt-5.5",
    aliases: {} as Record<string, string>,
    inject_desktop_context: false,
    suppress_desktop_directives: true,
    claude_code_compact_bridge: false,
    claude_code_opaque_compact_experimental: false,
    opaque_compact_token_budget_overrides: {} as Record<string, number>,
    custom_models: [] as Array<string | { id: string }>,
    allow_client_system_prompt_strategy: false,
    system_prompt_strategy: "instructions",
  },
  quota: {
    refresh_interval_minutes: 5,
    warning_thresholds: { primary: [80, 90], secondary: [80, 90] },
    skip_exhausted: true,
  },
  auth: {
    rotation_strategy: "least_used",
    refresh_enabled: true,
    refresh_margin_seconds: 300,
    refresh_concurrency: 2,
    max_concurrent_per_account: 3 as number | null,
    request_interval_ms: 50 as number | null,
  },
  update: { auto_update: true, auto_download: false, show_update_dialog: false },
  logs: { enabled: false, capacity: 2000, capture_body: false, llm_only: true },
  usage_stats: {
    history_retention_days: null as number | null,
    credits_per_usd: 25,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

const mockLogStore = vi.hoisted(() => ({
  setState: vi.fn(),
}));

const mockRoutableModelResolver = vi.hoisted(() => ({
  resolveRoutableCodexHostModel: vi.fn<(input: string) => string | null>(),
  getRoutableCodexHostModelAllowedModels: vi.fn<() => string[]>(),
  isImageHostModelClientId: vi.fn<(input: string) => boolean>(
    (input: string) => input.trim().toLowerCase() === "gpt-image-2",
  ),
}));

vi.mock("@src/models/routable-model-resolver.js", () => ({
  resolveRoutableCodexHostModel: mockRoutableModelResolver.resolveRoutableCodexHostModel,
  getRoutableCodexHostModelAllowedModels: mockRoutableModelResolver.getRoutableCodexHostModelAllowedModels,
  isImageHostModelClientId: mockRoutableModelResolver.isImageHostModelClientId,
  IMAGE_HOST_MODEL_CLIENT_ID: "gpt-image-2",
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@src/logs/store.js", () => ({
  logStore: mockLogStore,
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("@src/update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({})),
  checkForUpdate: vi.fn(),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/self-update.js", () => ({
  getProxyInfo: vi.fn(() => ({})),
  canSelfUpdate: vi.fn(() => false),
  checkProxySelfUpdate: vi.fn(),
  applyProxySelfUpdate: vi.fn(),
  isProxyUpdateInProgress: vi.fn(() => false),
  getCachedProxyUpdateResult: vi.fn(() => null),
  getDeployMode: vi.fn(() => "git"),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => vi.fn()),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

import { createWebRoutes } from "@src/routes/web.js";
import { mutateYaml } from "@src/utils/yaml-mutate.js";
import { reloadAllConfigs } from "@src/config.js";

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

const mockUsageStats = {} as unknown as Parameters<typeof createWebRoutes>[1];

function makeApp() {
  return createWebRoutes(mockPool, mockUsageStats);
}

describe("GET /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.logs.llm_only = true;
    mockConfig.usage_stats.history_retention_days = null;
    mockConfig.usage_stats.credits_per_usd = 25;
    mockConfig.model.allow_client_system_prompt_strategy = false;
    mockConfig.model.system_prompt_strategy = "instructions";
    mockConfig.model.aliases = {};
    mockConfig.model.custom_models = [];
    mockRoutableModelResolver.resolveRoutableCodexHostModel.mockReturnValue(null);
    mockRoutableModelResolver.getRoutableCodexHostModelAllowedModels.mockReturnValue([]);
  });

  it("returns current values including logs_llm_only and credits_per_usd", async () => {
    mockConfig.usage_stats.credits_per_usd = 40;
    const app = makeApp();
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      port: 8080,
      proxy_url: null,
      force_http11: false,
      claude_code_compact_bridge: false,
      claude_code_opaque_compact_experimental: false,
      opaque_compact_token_budget_overrides: {},
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
      model_aliases: {},
      refresh_enabled: true,
      auto_update: true,
      auto_download: false,
      show_update_dialog: false,
      logs_enabled: false,
      logs_capacity: 2000,
      logs_capture_body: false,
      logs_llm_only: true,
      usage_history_retention_days: null,
      credits_per_usd: 40,
    });
  });

  it("returns image_host_model and its allowed models", async () => {
    mockRoutableModelResolver.getRoutableCodexHostModelAllowedModels.mockReturnValue(["gpt-5.4", "gpt-5.5"]);
    const app = makeApp();
    const res = await app.request("/admin/general-settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.image_host_model).toBe("gpt-5.5");
    expect(data.image_host_model_allowed_models).toEqual(["gpt-5.4", "gpt-5.5"]);
  });
});

describe("POST /admin/general-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.logs.llm_only = true;
    mockConfig.usage_stats.history_retention_days = null;
    mockConfig.usage_stats.credits_per_usd = 25;
    mockConfig.model.allow_client_system_prompt_strategy = false;
    mockConfig.model.system_prompt_strategy = "instructions";
    mockConfig.model.aliases = {};
    mockConfig.model.custom_models = [];
    mockConfig.model.opaque_compact_token_budget_overrides = {};
    mockRoutableModelResolver.resolveRoutableCodexHostModel.mockReturnValue(null);
    mockRoutableModelResolver.getRoutableCodexHostModelAllowedModels.mockReturnValue([]);
  });

  it("persists compact bridge without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_code_compact_bridge: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { claude_code_compact_bridge: true },
    });
  });

  it("persists the experimental opaque compact switch without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_code_opaque_compact_experimental: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { claude_code_opaque_compact_experimental: true },
    });
  });

  it("persists opaque compact budgets without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 } }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 } },
    });
  });

  it("rejects invalid opaque compact budget overrides", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 1_000_001 } }),
    });

    expect(res.status).toBe(400);
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("rejects a calibrated override at or above the first verified failure boundary", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opaque_compact_token_budget_overrides: {
          "gpt-5.6-sol": 925_000,
          "gpt-5.5": 340_000,
        },
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("gpt-5.6-sol");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("accepts registered custom model overrides within the generic range", async () => {
    mockConfig.model.custom_models = ["my-experimental-model"];
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opaque_compact_token_budget_overrides: {
          "my-experimental-model": 1,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { opaque_compact_token_budget_overrides: { "my-experimental-model": 1 } },
    });
  });

  it("rejects an unregistered custom model override", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opaque_compact_token_budget_overrides: { "not-registered-model": 123_456 },
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a routable Codex model");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("normalizes an alias override to the routable catalog model", async () => {
    mockConfig.model.aliases = { "compact-sol": "gpt-5.6-sol" };
    mockConfig.model.opaque_compact_token_budget_overrides = { "gpt-5.6-sol": 880_000 };
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opaque_compact_token_budget_overrides: { "compact-sol": 880_000 },
      }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).opaque_compact_token_budget_overrides).toEqual({ "gpt-5.6-sol": 880_000 });
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { opaque_compact_token_budget_overrides: { "gpt-5.6-sol": 880_000 } },
    });
  });

  it("persists logs_llm_only without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs_llm_only: false }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
  });

  it("persists show_update_dialog without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_update_dialog: true }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      update: { show_update_dialog: true },
    });
  });

  it("rejects system prompt strategy updates while the client switch is disabled", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt_strategy: "developer_inline" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("allow_client_system_prompt_strategy");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("persists enabling the client switch and changing system prompt strategy in the same request", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allow_client_system_prompt_strategy: true,
        system_prompt_strategy: "developer_inline",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: {
        allow_client_system_prompt_strategy: true,
        system_prompt_strategy: "developer_inline",
      },
    });
  });

  it("rejects disabling the client switch and changing system prompt strategy in the same request", async () => {
    mockConfig.model.allow_client_system_prompt_strategy = true;
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allow_client_system_prompt_strategy: false,
        system_prompt_strategy: "developer_inline",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("allow_client_system_prompt_strategy");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("rejects invalid system prompt strategy", async () => {
    mockConfig.model.allow_client_system_prompt_strategy = true;
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt_strategy: "invalid" }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("system_prompt_strategy");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it.each(["instructions", "developer_inline", "system_inline"])("persists system prompt strategy %s when the persisted client switch is enabled", async (strategy) => {
    mockConfig.model.allow_client_system_prompt_strategy = true;
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt_strategy: strategy }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { system_prompt_strategy: strategy },
    });
  });

  it.each([true, false])("persists client system prompt strategy switch %s by itself", async (enabled) => {
    mockConfig.model.allow_client_system_prompt_strategy = !enabled;
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_client_system_prompt_strategy: enabled }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { allow_client_system_prompt_strategy: enabled },
    });
  });

  it("persists custom model aliases into local model aliases", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_aliases: {
          "sonnet-local": "gpt-5.4",
          "openai-fast": "openai:gpt-4o",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: {
        aliases: {
          "sonnet-local": "gpt-5.4",
          "openai-fast": "openai:gpt-4o",
        },
      },
    });
  });

  it("rejects empty custom model alias names", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_aliases: { "  ": "gpt-5.4" } }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("model_aliases");
  });

  it("persists finite usage history retention without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: 30 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { history_retention_days: 30 },
    });
  });

  it("persists unlimited usage history retention as null", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: null }),
    });

    expect(res.status).toBe(200);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { history_retention_days: null },
    });
  });

  it("persists dashboard credit USD conversion rate without requiring restart", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits_per_usd: 40 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.restart_required).toBe(false);
    expect(mutateYaml).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      usage_stats: { credits_per_usd: 40 },
    });
  });

  it("rejects invalid dashboard credit USD conversion rate", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits_per_usd: -1 }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("credits_per_usd");
  });

  it("rejects invalid usage history retention", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usage_history_retention_days: 0 }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("usage_history_retention_days");
  });

  it("syncs log store when logs_enabled changes", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs_enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(mockLogStore.setState).toHaveBeenCalledWith({ enabled: true });
  });

  it("persists a routable image host model into model.image_host_model", async () => {
    mockRoutableModelResolver.resolveRoutableCodexHostModel.mockImplementation((input: string) =>
      input === "gpt-5.4" ? "gpt-5.4" : null);
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: "gpt-5.4" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.image_host_model).toBe("gpt-5.4");
    expect(mutateYaml).toHaveBeenCalledOnce();
    expect(reloadAllConfigs).toHaveBeenCalledOnce();
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { image_host_model: "gpt-5.4" },
    });
  });

  it("normalizes an alias image host model to its canonical catalog model", async () => {
    mockRoutableModelResolver.resolveRoutableCodexHostModel.mockImplementation((input: string) =>
      input === "img-fast" ? "gpt-5.4" : null);
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: "img-fast" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).image_host_model).toBe("gpt-5.4");
    const mutate = vi.mocked(mutateYaml).mock.calls[0]?.[1];
    const localConfig: Record<string, unknown> = {};
    mutate?.(localConfig);
    expect(localConfig).toEqual({
      model: { image_host_model: "gpt-5.4" },
    });
  });

  it("rejects an empty image host model", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: "   " }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("image_host_model");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("rejects a non-string image host model with 400 instead of crashing", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: 12345 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("image_host_model");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("rejects gpt-image-2 as image host model case-insensitively", async () => {
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: "GPT-IMAGE-2" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("gpt-image-2");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });

  it("rejects an unknown image host model", async () => {
    // resolveRoutableCodexHostModel defaults to null (set in beforeEach).
    const app = makeApp();
    const res = await app.request("/admin/general-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_host_model: "not-a-routable-model" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a routable Codex model");
    expect(mutateYaml).not.toHaveBeenCalled();
    expect(reloadAllConfigs).not.toHaveBeenCalled();
  });
});
