/**
 * Tests for relay account support in AccountPool.
 *
 * Relay accounts use a simple API key + custom base URL instead of
 * ChatGPT JWT tokens. They skip JWT parsing, refresh, and quota fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetModelPlanTypes = vi.fn<(id: string) => string[]>(() => []);

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: (...args: unknown[]) => mockGetModelPlanTypes(args[0] as string),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    server: { account_strategy: "round_robin" },
    auth: { jwt_token: "", rotation_strategy: "least_used", rate_limit_backoff_seconds: 60 },
  })),
}));

let profileForToken: Record<string, { chatgpt_plan_type: string; email: string }> = {};

vi.mock("../../auth/jwt-utils.js", () => ({
  isTokenExpired: vi.fn(() => false),
  decodeJwtPayload: vi.fn(() => ({})),
  extractChatGptAccountId: vi.fn((token: string) => `aid-${token}`),
  extractUserProfile: vi.fn((token: string) => profileForToken[token] ?? null),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ accounts: [] })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { AccountPool } from "../account-pool.js";

describe("account-pool relay accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileForToken = {};
  });

  // ── addRelayAccount ──────────────────────────────────────────

  it("creates a relay account with correct fields", () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay-123",
      baseUrl: "https://relay.example.com/backend-api",
      label: "My Relay",
    });

    const entry = pool.getEntry(id);
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("relay");
    expect(entry!.token).toBe("sk-relay-123");
    expect(entry!.baseUrl).toBe("https://relay.example.com/backend-api");
    expect(entry!.label).toBe("My Relay");
    expect(entry!.allowedModels).toBeNull();
    expect(entry!.email).toBeNull();
    expect(entry!.accountId).toBeNull();
    expect(entry!.planType).toBeNull();
    expect(entry!.refreshToken).toBeNull();
    expect(entry!.status).toBe("active");
    expect(entry!.proxyApiKey).toMatch(/^codex-proxy-/);
  });

  it("creates relay with allowedModels", () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay-123",
      baseUrl: "https://relay.example.com/backend-api",
      label: "My Relay",
      allowedModels: ["gpt-5.2-codex", "gpt-5.4"],
    });

    const entry = pool.getEntry(id);
    expect(entry!.allowedModels).toEqual(["gpt-5.2-codex", "gpt-5.4"]);
  });

  it("deduplicates by baseUrl + apiKey", () => {
    const pool = new AccountPool();
    const id1 = pool.addRelayAccount({
      apiKey: "sk-relay-123",
      baseUrl: "https://relay.example.com/backend-api",
      label: "Relay v1",
    });
    const id2 = pool.addRelayAccount({
      apiKey: "sk-relay-123",
      baseUrl: "https://relay.example.com/backend-api",
      label: "Relay v2",
    });

    expect(id1).toBe(id2);
    expect(pool.getEntry(id1)!.label).toBe("Relay v2"); // Updated
  });

  it("does NOT deduplicate when apiKey differs", () => {
    const pool = new AccountPool();
    const id1 = pool.addRelayAccount({
      apiKey: "sk-relay-AAA",
      baseUrl: "https://relay.example.com/backend-api",
      label: "Relay A",
    });
    const id2 = pool.addRelayAccount({
      apiKey: "sk-relay-BBB",
      baseUrl: "https://relay.example.com/backend-api",
      label: "Relay B",
    });

    expect(id1).not.toBe(id2);
  });

  // ── acquire ──────────────────────────────────────────────────

  it("acquires relay account when no model filter", () => {
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.type).toBe("relay");
    expect(acquired!.baseUrl).toBe("https://relay.example.com");
  });

  it("acquires relay account with null allowedModels for any model", () => {
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
      // no allowedModels → accepts all
    });

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.type).toBe("relay");
  });

  it("acquires relay account when model is in allowedModels", () => {
    mockGetModelPlanTypes.mockReturnValue(["team"]);
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
      allowedModels: ["gpt-5.4", "gpt-5.2-codex"],
    });

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).not.toBeNull();
    expect(acquired!.type).toBe("relay");
  });

  it("skips relay account when model is NOT in allowedModels", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
      allowedModels: ["gpt-5.2-codex"],
    });

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).toBeNull();
  });

  it("mixed pool: relay + native rotate together", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    profileForToken = { "tok-native": { chatgpt_plan_type: "free", email: "test@test.com" } };

    const pool = new AccountPool();
    pool.addAccount("tok-native");
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    // Both should be available (least-used picks the one with fewer requests)
    const a1 = pool.acquire();
    expect(a1).not.toBeNull();
    const a2 = pool.acquire();
    expect(a2).not.toBeNull();
    expect(a1!.entryId).not.toBe(a2!.entryId);

    // One should be native, the other relay
    const types = [a1!.type, a2!.type].sort();
    expect(types).toEqual(["native", "relay"]);
  });

  it("relay with allowedModels filtered out when model has plan requirements", () => {
    // Model requires "team" plan, relay only allows gpt-5.2-codex
    mockGetModelPlanTypes.mockReturnValue(["team"]);

    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
      allowedModels: ["gpt-5.2-codex"], // does NOT include gpt-5.4
    });

    const acquired = pool.acquire({ model: "gpt-5.4" });
    expect(acquired).toBeNull();
  });

  // ── refreshStatus ────────────────────────────────────────────

  it("relay accounts do NOT expire via JWT check", async () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    // Even though isTokenExpired is mocked to return false by default,
    // if we change it to return true, relay should still be active
    const { isTokenExpired } = await import("../../auth/jwt-utils.js");
    vi.mocked(isTokenExpired).mockReturnValue(true);

    // Trigger refreshStatus via acquire
    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(pool.getEntry(id)!.status).toBe("active");

    // Restore
    vi.mocked(isTokenExpired).mockReturnValue(false);
  });

  it("relay accounts can still be rate limited and recover", () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    pool.markRateLimited(id, { retryAfterSec: 0.001 });
    expect(pool.getEntry(id)!.status).toBe("rate_limited");

    // Wait for recovery
    const entry = pool.getEntry(id)!;
    entry.usage.rate_limit_until = new Date(Date.now() - 1000).toISOString();

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(pool.getEntry(id)!.status).toBe("active");
  });

  // ── toInfo ───────────────────────────────────────────────────

  it("toInfo returns relay fields correctly", () => {
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "My Relay",
      allowedModels: ["gpt-5.4"],
    });

    const accounts = pool.getAccounts();
    const relay = accounts.find((a) => a.type === "relay");
    expect(relay).toBeDefined();
    expect(relay!.label).toBe("My Relay");
    expect(relay!.baseUrl).toBe("https://relay.example.com");
    expect(relay!.allowedModels).toEqual(["gpt-5.4"]);
    expect(relay!.expiresAt).toBeNull(); // No JWT expiry
    expect(relay!.email).toBeNull();
  });

  // ── getDistinctPlanAccounts ──────────────────────────────────

  it("getDistinctPlanAccounts excludes relay accounts", () => {
    profileForToken = { "tok-team": { chatgpt_plan_type: "team", email: "team@test.com" } };

    const pool = new AccountPool();
    pool.addAccount("tok-team");
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    const planAccounts = pool.getDistinctPlanAccounts();
    expect(planAccounts.length).toBe(1);
    expect(planAccounts[0].planType).toBe("team");

    // Release locks
    for (const pa of planAccounts) pool.releaseWithoutCounting(pa.entryId);
  });

  // ── native accounts have correct type ────────────────────────

  it("native accounts added via addAccount have type='native'", () => {
    profileForToken = { "tok-1": { chatgpt_plan_type: "free", email: "test@test.com" } };
    const pool = new AccountPool();
    const id = pool.addAccount("tok-1");

    const entry = pool.getEntry(id);
    expect(entry!.type).toBe("native");
    expect(entry!.baseUrl).toBeNull();
    expect(entry!.label).toBeNull();
    expect(entry!.allowedModels).toBeNull();
    expect(entry!.format).toBeNull();

    const acquired = pool.acquire();
    expect(acquired!.type).toBe("native");
    expect(acquired!.baseUrl).toBeNull();
    expect(acquired!.format).toBeNull();
  });

  // ── format support ──────────────────────────────────────────

  it("creates relay with format field", () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://api.example.com/v1",
      label: "OpenAI Relay",
      format: "openai",
    });

    const entry = pool.getEntry(id);
    expect(entry!.format).toBe("openai");
  });

  it("defaults format to codex when not specified", () => {
    const pool = new AccountPool();
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Default Relay",
    });

    const entry = pool.getEntry(id);
    expect(entry!.format).toBe("codex");
  });

  it("acquire({ format }) prefers matching relay", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    profileForToken = { "tok-native": { chatgpt_plan_type: "free", email: "test@test.com" } };

    const pool = new AccountPool();
    pool.addAccount("tok-native");
    pool.addRelayAccount({
      apiKey: "sk-openai",
      baseUrl: "https://api.example.com/v1",
      label: "OpenAI",
      format: "openai",
    });

    // With format preference → should pick the openai relay
    const acquired = pool.acquire({ format: "openai" });
    expect(acquired).not.toBeNull();
    expect(acquired!.format).toBe("openai");
    expect(acquired!.type).toBe("relay");
  });

  it("acquire({ format }) falls back when no format match", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    profileForToken = { "tok-native": { chatgpt_plan_type: "free", email: "test@test.com" } };

    const pool = new AccountPool();
    pool.addAccount("tok-native");
    pool.addRelayAccount({
      apiKey: "sk-codex",
      baseUrl: "https://relay.example.com",
      label: "Codex Relay",
      format: "codex",
    });

    // Request anthropic format but none exists → should still return an account
    const acquired = pool.acquire({ format: "anthropic" });
    expect(acquired).not.toBeNull();
    // Falls back to native or codex relay
    expect(acquired!.format).not.toBe("anthropic");
  });

  it("acquire returns format in AcquiredAccount", () => {
    mockGetModelPlanTypes.mockReturnValue([]);
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://api.example.com",
      label: "Anthropic",
      format: "anthropic",
    });

    const acquired = pool.acquire();
    expect(acquired!.format).toBe("anthropic");
  });

  it("toInfo returns format field", () => {
    const pool = new AccountPool();
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://api.example.com",
      label: "OpenAI",
      format: "openai",
    });

    const accounts = pool.getAccounts();
    const relay = accounts.find((a) => a.type === "relay");
    expect(relay!.format).toBe("openai");
  });
});
