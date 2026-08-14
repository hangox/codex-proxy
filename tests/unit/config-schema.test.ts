/**
 * Unit tests for config-schema.ts — Zod schema validation and defaults.
 */

import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  FingerprintSchema,
  ROTATION_STRATEGIES,
} from "@src/config-schema.js";

describe("ROTATION_STRATEGIES", () => {
  it("contains expected values", () => {
    expect(ROTATION_STRATEGIES).toEqual(["least_used", "round_robin", "sticky"]);
  });
});

describe("ConfigSchema", () => {
  it("parses minimal input with all defaults", () => {
    // All top-level required keys with empty objects
    const result = ConfigSchema.parse({
      api: {},
      client: {},
      model: {},
      auth: {},
      server: {},
      session: {},
    });

    expect(result.api.base_url).toBe("https://chatgpt.com/backend-api");
    expect(result.api.timeout_seconds).toBe(60);
    expect(result.server.port).toBe(8080);
    expect(result.server.host).toBe("127.0.0.1");
    expect(result.server.proxy_api_key).toBeNull();
    expect(result.auth.rotation_strategy).toBe("least_used");
    expect(result.auth.refresh_concurrency).toBe(2);
    expect(result.auth.max_concurrent_per_account).toBe(3);
    expect(result.auth.request_interval_ms).toBe(50);
    expect(result.model.default).toBe("gpt-5.6-sol");
    expect(result.model.default_reasoning_effort).toBeNull();
    expect(result.model.aliases).toEqual({});
    expect(result.model.custom_models).toEqual([]);
    expect(result.model.allow_client_system_prompt_strategy).toBe(false);
    expect(result.tls.force_http11).toBe(false);
    expect(result.tls.health_check_url).toBe("https://api.ipify.org?format=json");
    expect(result.usage_stats.snapshot_interval_minutes).toBe(5);
    expect(result.usage_stats.history_retention_days).toBeNull();
    expect(result.usage_stats.credits_per_usd).toBe(25);
    expect(result.quota.refresh_interval_minutes).toBe(5);
    expect(result.quota.warning_thresholds.primary).toEqual([80, 90]);
    expect(result.quota.skip_exhausted).toBe(true);
    expect(result.update.auto_update).toBe(true);
    expect(result.update.show_update_dialog).toBe(false);
    expect(result.update.allow_prerelease).toBe(false);
    expect(result.session.ttl_minutes).toBe(1440);
    expect(result.ollama).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 11434,
      version: "0.18.3",
      disable_vision: false,
    });
    expect(result.official_agent).toEqual({
      enabled: false,
      api_key: null,
      app_server_url: "ws://127.0.0.1:4500",
      request_timeout_ms: 30000,
      auth: { type: "none" },
    });
    // ★ 8.20（生产事故复盘）：默认从 720（12h）改成 10080（7 天）——12h
    // 对"会话开着过夜、隔天接着干"这种正常使用场景必然踩中 TTL 过期，
    // 见 `config-schema.ts` 里 `ttl_minutes` 字段的完整注释。
    expect(result.opaque_compact_state.ttl_minutes).toBe(10080);
    // ★ 8.20 续：TTL 放长到 7 天之后的连带修正，capacity 1024→4096、
    // max_bytes 64MiB→256MiB（配平——单独提高 capacity 不提高 max_bytes，
    // 一旦均值字节数超过 max_bytes/capacity 就变成字节先触顶）。
    expect(result.opaque_compact_state.capacity).toBe(4096);
    expect(result.opaque_compact_state.max_bytes).toBe(256 * 1024 * 1024);
    expect(result.opaque_compact_state.keyring_file).toBeNull();
  });

  it("respects overridden values", () => {
    const result = ConfigSchema.parse({
      api: { timeout_seconds: 120 },
      client: { platform: "linux" },
      model: {
        default: "gpt-5.4",
        aliases: {
          "claude-opus-4-7": "gpt-5.5",
          "my-openai": "openai:gpt-4o",
        },
        custom_models: [
          "local-simple",
          {
            id: "local-rich",
            display_name: "Local Rich",
            description: "Local rich model",
            supported_reasoning_efforts: ["low", "high"],
            default_reasoning_effort: "high",
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            supports_personality: true,
            context_window: 12345,
            max_context_window: 23456,
            max_output_tokens: 3456,
            truncation_policy_limit: 4567,
          },
        ],
      },
      auth: { rotation_strategy: "round_robin", max_concurrent_per_account: null },
      server: { port: 3000, proxy_api_key: "sk-test" },
      session: { ttl_minutes: 120 },
      tls: { force_http11: true, health_check_url: "https://my-health.org" },
      providers: {
        openai: { api_key: "sk-openai-key" },
        anthropic: { api_key: "sk-anthropic-key", base_url: "https://my-anthropic.com/v1" },
        gemini: { api_key: "sk-gemini-key", base_url: "https://my-gemini.com" },
      },
      quota: { skip_exhausted: false },
      update: { auto_update: false, show_update_dialog: true, allow_prerelease: true },
      ollama: {
        enabled: true,
        host: "0.0.0.0",
        port: 11435,
        version: "0.20.1",
        disable_vision: true,
      },
      official_agent: {
        enabled: true,
        api_key: "agent-key",
        app_server_url: "ws://127.0.0.1:4777",
        request_timeout_ms: 5000,
        auth: { type: "capability_token", token_file: "/tmp/codex-token" },
      },
    });

    expect(result.api.timeout_seconds).toBe(120);
    expect(result.client.platform).toBe("linux");
    expect(result.model.default).toBe("gpt-5.4");
    expect(result.model.aliases).toEqual({
      "claude-opus-4-7": "gpt-5.5",
      "my-openai": "openai:gpt-4o",
    });
    expect(result.model.custom_models).toEqual([
      "local-simple",
      {
        id: "local-rich",
        display_name: "Local Rich",
        description: "Local rich model",
        supported_reasoning_efforts: ["low", "high"],
        default_reasoning_effort: "high",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supports_personality: true,
        context_window: 12345,
        max_context_window: 23456,
        max_output_tokens: 3456,
        truncation_policy_limit: 4567,
      },
    ]);
    expect(result.auth.rotation_strategy).toBe("round_robin");
    expect(result.auth.max_concurrent_per_account).toBeNull();
    expect(result.server.port).toBe(3000);
    expect(result.server.proxy_api_key).toBe("sk-test");
    expect(result.tls.force_http11).toBe(true);
    expect(result.tls.health_check_url).toBe("https://my-health.org");
    expect(result.providers?.anthropic?.base_url).toBe("https://my-anthropic.com/v1");
    expect(result.providers?.gemini?.base_url).toBe("https://my-gemini.com");
    expect(result.quota.skip_exhausted).toBe(false);
    expect(result.update.auto_update).toBe(false);
    expect(result.update.show_update_dialog).toBe(true);
    expect(result.update.allow_prerelease).toBe(true);
    expect(result.ollama).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 11435,
      version: "0.20.1",
      disable_vision: true,
    });
    expect(result.official_agent.enabled).toBe(true);
    expect(result.official_agent.api_key).toBe("agent-key");
    expect(result.official_agent.app_server_url).toBe("ws://127.0.0.1:4777");
    expect(result.official_agent.auth).toEqual({ type: "capability_token", token_file: "/tmp/codex-token" });
  });

  it("rejects non-websocket official agent URLs", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      official_agent: { app_server_url: "http://127.0.0.1:4500" },
    });
    expect(result.success).toBe(false);
  });

  it("requires official agent capability token material", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      official_agent: { auth: { type: "capability_token" } },
    });
    expect(result.success).toBe(false);
  });

  it("requires official agent signed bearer secret material", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      official_agent: { auth: { type: "signed_bearer_token" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects port out of range", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: { port: 0 }, session: {},
    });
    expect(result.success).toBe(false);

    const result2 = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: { port: 70000 }, session: {},
    });
    expect(result2.success).toBe(false);
  });

  it("rejects Ollama bridge port out of range", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { port: 0 },
    });
    expect(result.success).toBe(false);

    const result2 = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { port: 70000 },
    });
    expect(result2.success).toBe(false);
  });

  it("trims and validates Ollama bridge version", () => {
    const result = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: " 0.20.1 " },
    });
    expect(result.ollama.version).toBe("0.20.1");

    const empty = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: "   " },
    });
    expect(empty.success).toBe(false);

    const tooLong = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, ollama: { version: "x".repeat(65) },
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects invalid rotation strategy", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: { rotation_strategy: "random" }, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_seconds < 1", () => {
    const result = ConfigSchema.safeParse({
      api: { timeout_seconds: 0 }, client: {}, model: {}, auth: {}, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects refresh_concurrency < 1", () => {
    const result = ConfigSchema.safeParse({
      api: {}, client: {}, model: {}, auth: { refresh_concurrency: 0 }, server: {}, session: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts tls/quota/update as optional (uses defaults)", () => {
    const result = ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
    });
    expect(result.quota.concurrency).toBe(10);
    expect(result.update.auto_update).toBe(true);
    expect(result.update.show_update_dialog).toBe(false);
  });

  // ★ 8.20（生产事故复盘）：opaque_compact_state.ttl_minutes 默认从 12h
  // 改成 7 天，max 上限相应从 24h 放宽到 30 天——否则新默认值本身就会
  // 超出 schema 自己声明的 max，是这次改动里最容易漏掉的一步（改
  // default 忘了同步改 max）。
  describe("opaque_compact_state.ttl_minutes", () => {
    it("默认值是 10080（7 天），不是旧的 720（12h）", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      });
      expect(result.opaque_compact_state.ttl_minutes).toBe(10080);
    });

    it("接受最长 30 天（43200 分钟）的显式配置", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
        opaque_compact_state: { ttl_minutes: 30 * 24 * 60 },
      });
      expect(result.opaque_compact_state.ttl_minutes).toBe(43200);
    });

    it("拒绝超过 30 天的配置——上限不是无限放开", () => {
      const result = ConfigSchema.safeParse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
        opaque_compact_state: { ttl_minutes: 30 * 24 * 60 + 1 },
      });
      expect(result.success).toBe(false);
    });

    it("仍然接受比新默认值短的显式配置（比如旧的 720）——只是不再是默认值", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
        opaque_compact_state: { ttl_minutes: 720 },
      });
      expect(result.opaque_compact_state.ttl_minutes).toBe(720);
    });
  });

  // ★ 8.20 续：TTL 放长到 7 天后 predecessor state 存量累积量级变大
  // （~14 倍），capacity/max_bytes 跟着一起改——"配平"是这两个字段的
  // 核心不变量：capacity × 平均 byte_size 不能超过 max_bytes，否则字节
  // 预算会先于条数触顶，capacity 那次改动就白改了。
  describe("opaque_compact_state.capacity / max_bytes（8.20 续，配平）", () => {
    it("默认值是 capacity=4096、max_bytes=256MiB，不是旧的 1024/64MiB", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      });
      expect(result.opaque_compact_state.capacity).toBe(4096);
      expect(result.opaque_compact_state.max_bytes).toBe(268_435_456);
    });

    it("配平不变量：新默认值组合下，capacity × 实测均值 byte_size(48785) 不超过 max_bytes——否则 bytes 会先于 capacity 触顶", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      });
      const measuredAvgByteSize = 48_785; // tests/e2e/opaque-compact-state-byte-size.test.ts 的实测值。
      expect(result.opaque_compact_state.capacity * measuredAvgByteSize).toBeLessThanOrEqual(result.opaque_compact_state.max_bytes);
    });

    it("capacity 仍然接受旧的 1024（只是不再是默认值），上限 10_000 不变", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
        opaque_compact_state: { capacity: 1024 },
      });
      expect(result.opaque_compact_state.capacity).toBe(1024);
    });

    it("max_bytes 仍然接受旧的 64MiB（只是不再是默认值），下限 64KB 不变", () => {
      const result = ConfigSchema.parse({
        api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
        opaque_compact_state: { max_bytes: 64 * 1024 * 1024 },
      });
      expect(result.opaque_compact_state.max_bytes).toBe(67_108_864);
    });
  });
});

describe("FingerprintSchema", () => {
  it("parses valid fingerprint config", () => {
    const result = FingerprintSchema.parse({
      user_agent_template: "Codex/{version}",
      auth_domains: ["chatgpt.com"],
      auth_domain_exclusions: [],
      header_order: ["Authorization", "Content-Type"],
    });
    expect(result.user_agent_template).toBe("Codex/{version}");
    expect(result.default_headers).toEqual({});
  });

  it("rejects missing required fields", () => {
    const result = FingerprintSchema.safeParse({
      user_agent_template: "Codex/{version}",
      // Missing auth_domains, auth_domain_exclusions, header_order
    });
    expect(result.success).toBe(false);
  });
});
