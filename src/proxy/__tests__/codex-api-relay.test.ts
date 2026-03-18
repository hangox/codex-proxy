/**
 * Tests that CodexApi correctly switches between native (fingerprint) and
 * relay (simple Bearer) header modes based on baseUrlOverride.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexApi } from "../codex-api.js";

// Capture transport calls
const mockPost = vi.fn();
const mockGet = vi.fn();

vi.mock("../../tls/transport.js", () => ({
  getTransport: () => ({
    post: mockPost,
    get: mockGet,
    isImpersonate: () => false,
  }),
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { originator: "codex", app_version: "1.0.0", platform: "macOS", arch: "arm64", chromium_version: "136" },
  }),
}));

vi.mock("../../fingerprint/manager.js", () => ({
  buildHeaders: vi.fn((token: string, accountId: string | null) => ({
    "Authorization": `Bearer ${token}`,
    "ChatGPT-Account-Id": accountId ?? "",
    "originator": "codex",
    "User-Agent": "Mozilla/5.0 Chrome/136",
    "sec-ch-ua": '"Chromium";v="136"',
  })),
  buildHeadersWithContentType: vi.fn((token: string, accountId: string | null) => ({
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": accountId ?? "",
    "originator": "codex",
    "User-Agent": "Mozilla/5.0 Chrome/136",
    "sec-ch-ua": '"Chromium";v="136"',
  })),
}));

describe("CodexApi relay mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isRelay returns false for native (no baseUrlOverride)", () => {
    const api = new CodexApi("jwt-token", "acct-123");
    expect(api.isRelay).toBe(false);
  });

  it("isRelay returns true when baseUrlOverride is set", () => {
    const api = new CodexApi("sk-relay", null, null, null, null, "https://relay.example.com");
    expect(api.isRelay).toBe(true);
  });

  it("native mode uses fingerprint headers for GET", async () => {
    mockGet.mockResolvedValue({ body: JSON.stringify({ rate_limit: { allowed: true, limit_reached: false, primary_window: null, secondary_window: null } }), status: 200 });

    const api = new CodexApi("jwt-token", "acct-123");
    await api.getUsage();

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, headers] = mockGet.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/usage");
    // Native mode: includes fingerprint headers
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(headers["originator"]).toBe("codex");
    expect(headers["User-Agent"]).toContain("Chrome");
  });

  it("relay mode uses simple Bearer headers for GET", async () => {
    mockGet.mockResolvedValue({ body: JSON.stringify({ rate_limit: { allowed: true, limit_reached: false, primary_window: null, secondary_window: null } }), status: 200 });

    const api = new CodexApi("sk-relay-key", null, null, null, null, "https://relay.example.com");
    await api.getUsage();

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, headers] = mockGet.mock.calls[0];
    // Uses relay base URL
    expect(url).toBe("https://relay.example.com/codex/usage");
    // Simple Bearer auth — no fingerprint
    expect(headers["Authorization"]).toBe("Bearer sk-relay-key");
    expect(headers["Accept"]).toBe("application/json");
    // Must NOT have fingerprint headers
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
    expect(headers["originator"]).toBeUndefined();
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["sec-ch-ua"]).toBeUndefined();
  });

  it("relay mode sends to relay base URL for HTTP SSE", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.completed\ndata: {}\n\n"));
        controller.close();
      },
    });
    mockPost.mockResolvedValue({
      status: 200,
      headers: {},
      body: mockStream,
      setCookieHeaders: [],
    });

    const api = new CodexApi("sk-relay-key", null, null, null, null, "https://relay.example.com");
    await api.createResponse({
      model: "gpt-5.2-codex",
      instructions: "test",
      input: [],
      stream: true,
      store: false,
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, headers] = mockPost.mock.calls[0];
    expect(url).toBe("https://relay.example.com/codex/responses");
    // Simple Bearer auth
    expect(headers["Authorization"]).toBe("Bearer sk-relay-key");
    expect(headers["Content-Type"]).toBe("application/json");
    // No fingerprint headers
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
    expect(headers["originator"]).toBeUndefined();
    // No OpenAI-Beta header for relay
    expect(headers["OpenAI-Beta"]).toBeUndefined();
  });

  it("native mode uses config base URL", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    mockPost.mockResolvedValue({
      status: 200,
      headers: {},
      body: mockStream,
      setCookieHeaders: [],
    });

    const api = new CodexApi("jwt-token", "acct-123");
    await api.createResponse({
      model: "gpt-5.2-codex",
      instructions: "test",
      input: [],
      stream: true,
      store: false,
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, headers] = mockPost.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    // Has fingerprint headers
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(headers["originator"]).toBe("codex");
    expect(headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
  });
});
