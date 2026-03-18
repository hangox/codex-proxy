/**
 * Tests for relay account endpoints.
 * POST /auth/accounts/relay — add relay account (API key + base URL)
 * GET  /auth/accounts       — list includes relay accounts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
  })),
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("../../models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
}));

import { Hono } from "hono";
import { AccountPool } from "../../auth/account-pool.js";
import { createAccountRoutes } from "../../routes/accounts.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

describe("relay account routes", () => {
  let pool: AccountPool;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new AccountPool();
    const routes = createAccountRoutes(pool, mockScheduler as never);
    app = new Hono();
    app.route("/", routes);
  });

  // ── POST /auth/accounts/relay ────────────────────────────────

  it("creates a relay account with valid input", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://relay.example.com/backend-api",
        label: "Test Relay",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.account.type).toBe("relay");
    expect(data.account.label).toBe("Test Relay");
    expect(data.account.baseUrl).toBe("https://relay.example.com/backend-api");
    expect(data.account.allowedModels).toBeNull();
    expect(data.account.email).toBeNull();
    expect(data.account.expiresAt).toBeNull();
  });

  it("creates relay with allowedModels", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://relay.example.com/backend-api",
        label: "Test Relay",
        allowedModels: ["gpt-5.2-codex"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.allowedModels).toEqual(["gpt-5.2-codex"]);
  });

  it("does NOT call scheduler.scheduleOne for relay", async () => {
    await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://relay.example.com/backend-api",
        label: "Test Relay",
      }),
    });

    expect(mockScheduler.scheduleOne).not.toHaveBeenCalled();
  });

  it("returns 400 for missing apiKey", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://relay.example.com",
        label: "Test Relay",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 400 for missing baseUrl", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        label: "Test Relay",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing label", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://relay.example.com",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid baseUrl", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "not-a-url",
        label: "Bad URL",
      }),
    });

    expect(res.status).toBe(400);
  });

  // ── GET /auth/accounts ──────────────────────────────────────

  it("lists relay accounts alongside native accounts", async () => {
    // Add a native account
    pool.addAccount("jwt-native-token-1234");
    // Add a relay account
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "My Relay",
    });

    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts.length).toBe(2);

    const native = data.accounts.find((a: Record<string, unknown>) => a.type === "native");
    const relay = data.accounts.find((a: Record<string, unknown>) => a.type === "relay");

    expect(native).toBeDefined();
    expect(native.email).toBeTruthy();

    expect(relay).toBeDefined();
    expect(relay.label).toBe("My Relay");
    expect(relay.baseUrl).toBe("https://relay.example.com");
    expect(relay.email).toBeNull();
    expect(relay.expiresAt).toBeNull();
  });

  // ── GET /auth/accounts/:id/quota ────────────────────────────

  it("returns 400 for quota on relay account", async () => {
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    const res = await app.request(`/auth/accounts/${id}/quota`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("relay");
  });

  // ── DELETE /auth/accounts/:id ───────────────────────────────

  it("deletes a relay account", async () => {
    const id = pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.com",
      label: "Relay",
    });

    const res = await app.request(`/auth/accounts/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    expect(pool.getEntry(id)).toBeUndefined();
  });

  // ── Format support ──────────────────────────────────────────

  it("creates relay with format field", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://api.example.com/v1",
        label: "OpenAI Relay",
        format: "openai",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.format).toBe("openai");
  });

  it("defaults format to codex", async () => {
    const res = await app.request("/auth/accounts/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-relay-test",
        baseUrl: "https://relay.example.com",
        label: "Default",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.format).toBe("codex");
  });

  it("returns format in account list", async () => {
    pool.addRelayAccount({
      apiKey: "sk-relay",
      baseUrl: "https://api.example.com/v1",
      label: "OpenAI",
      format: "openai",
    });

    const res = await app.request("/auth/accounts");
    const data = await res.json();
    const relay = data.accounts.find((a: Record<string, unknown>) => a.type === "relay");
    expect(relay.format).toBe("openai");
  });
});
