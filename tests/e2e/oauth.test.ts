/**
 * E2E tests for the OAuth PKCE flows (/auth/login-start, /auth/code-relay,
 * /auth/callback, /auth/device-login, /auth/device-poll/:deviceCode).
 *
 * Following the repo E2E convention, only the external identity-provider
 * boundary is mocked: `curlFetchPost` in @src/tls/curl-fetch.js (the function
 * that actually talks to Auth0/OpenAI over the TLS transport). The Hono app,
 * route handlers, AccountPool, RefreshScheduler, and oauth-pkce session logic
 * all run unmodified.
 *
 * Note: these OAuth routes are intentionally public login entry-points — they
 * are mounted with no apiKeyAuth gate (only /v1 and /admin are key-protected),
 * so they return 200 without any key. See the first describe block for the
 * no-authentication-required happy path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import "@helpers/e2e-setup.js";
import { createValidJwt } from "@helpers/jwt.js";

// Mock the external identity-provider boundary before importing @src modules.
const mockCurlFetch = vi.hoisted(() => ({
  curlFetchPost: vi.fn<(url: string, contentType: string, body: string) => Promise<{
    status: number;
    body: string;
    ok: boolean;
  }>>(),
}));

vi.mock("@src/tls/curl-fetch.js", () => ({
  curlFetchPost: mockCurlFetch.curlFetchPost,
  curlFetchGet: vi.fn(async () => ({ status: 200, body: "{}", ok: true })),
}));

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createAuthRoutes } from "@src/routes/auth.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { createOAuthSession } from "@src/auth/oauth-pkce.js";

// ── Provider response builders ────────────────────────────────────

interface ProviderResponse {
  status: number;
  body: string;
  ok: boolean;
}

function tokenProviderResponse(accountId: string, email = "oauth@test.com"): ProviderResponse {
  return {
    status: 200,
    body: JSON.stringify({
      access_token: createValidJwt({ accountId, email }),
      refresh_token: "rt-" + accountId,
      token_type: "Bearer",
      expires_in: 3600,
    }),
    ok: true,
  };
}

function deviceCodeProviderResponse(): ProviderResponse {
  return {
    status: 200,
    body: JSON.stringify({
      device_code: "device-code-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expires_in: 1800,
      interval: 5,
    }),
    ok: true,
  };
}

/** Default provider impl: route to the device/code or token endpoint. */
function defaultProviderImpl(url: string, _contentType: string, _body: string): ProviderResponse {
  if (url.includes("/device/code")) {
    return deviceCodeProviderResponse();
  }
  return tokenProviderResponse("acct-oauth", "oauth@test.com");
}

let app: Hono;
let pool: AccountPool;
let scheduler: RefreshScheduler;

beforeAll(() => {
  pool = new AccountPool();
  scheduler = new RefreshScheduler(pool);

  app = new Hono();
  app.use("*", requestId);
  app.onError(errorHandler);
  app.route("/", createAuthRoutes(pool, scheduler));
});

afterAll(() => {
  scheduler.destroy();
  pool.destroy();
});

beforeEach(() => {
  pool.clearToken();
  mockCurlFetch.curlFetchPost.mockReset();
  mockCurlFetch.curlFetchPost.mockImplementation(defaultProviderImpl);
});

describe("POST /auth/login-start", () => {
  it("starts an OAuth flow without any API key (public login entry point)", async () => {
    const res = await app.request("/auth/login-start", {
      method: "POST",
      headers: { Host: "localhost:8080", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { authUrl: string; state: string };
    expect(typeof body.state).toBe("string");
    expect(body.state.length).toBeGreaterThan(0);
    expect(body.authUrl).toContain("https://auth.openai.com/oauth/authorize");
    expect(body.authUrl).toContain("client_id=app_test");
    expect(body.authUrl).toContain(`state=${body.state}`);
  });
});

describe("POST /auth/code-relay", () => {
  function buildCallbackUrl(state: string): string {
    return `http://localhost:1455/auth/callback?code=AUTH_CODE_1&state=${state}`;
  }

  it("rejects a request without callbackUrl (400)", async () => {
    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid callbackUrl (400)", async () => {
    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a callbackUrl missing code and state (400)", async () => {
    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://localhost:1455/auth/callback" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a callbackUrl carrying an OAuth error (400)", async () => {
    const callbackUrl = "http://localhost:1455/auth/callback?error=access_denied&error_description=User%20denied";
    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown/expired session (400)", async () => {
    const callbackUrl = buildCallbackUrl("unknown-state");
    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl }),
    });
    expect(res.status).toBe(400);
  });

  it("exchanges the code and adds the account on success (200)", async () => {
    const { state } = createOAuthSession("localhost:8080", "login");

    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: buildCallbackUrl(state) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(pool.isAuthenticated()).toBe(true);
    expect(pool.getPoolSummary().total).toBe(1);
  });

  it("returns 500 when the provider token exchange fails", async () => {
    const { state } = createOAuthSession("localhost:8080", "login");
    mockCurlFetch.curlFetchPost.mockImplementation(async () => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
      ok: false,
    }));

    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: buildCallbackUrl(state) }),
    });
    expect(res.status).toBe(500);
    expect(pool.isAuthenticated()).toBe(false);
  });

  it("treats a second exchange with the same state as success (idempotent)", async () => {
    const { state } = createOAuthSession("localhost:8080", "login");

    const first = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: buildCallbackUrl(state) }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: buildCallbackUrl(state) }),
    });
    expect(second.status).toBe(200);
    expect(pool.getPoolSummary().total).toBe(1);
  });
});

describe("GET /auth/callback", () => {
  function callbackUrl(state: string): string {
    return `/auth/callback?code=AUTH_CODE_2&state=${state}`;
  }

  it("rejects a request missing code and state (400)", async () => {
    const res = await app.request("/auth/callback");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing code or state parameter");
  });

  it("renders an error page when the provider returns an error", async () => {
    const res = await app.request("/auth/callback?error=access_denied&error_description=Denied");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OAuth error");
  });

  it("rejects an unknown/expired session (400)", async () => {
    const res = await app.request(callbackUrl("unknown-state"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });

  it("exchanges the code, adds the account, and redirects to the return host", async () => {
    const { state } = createOAuthSession("localhost:8080", "login");

    const res = await app.request(callbackUrl(state));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:8080/");
    expect(pool.isAuthenticated()).toBe(true);
    expect(pool.getPoolSummary().total).toBe(1);
  });

  it("renders an error page (500) when the provider token exchange fails", async () => {
    const { state } = createOAuthSession("localhost:8080", "login");
    mockCurlFetch.curlFetchPost.mockImplementation(async () => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
      ok: false,
    }));

    const res = await app.request(callbackUrl(state));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Token exchange failed");
    expect(pool.isAuthenticated()).toBe(false);
  });
});

describe("POST /auth/device-login", () => {
  it("requests a device code and returns the verification payload (200)", async () => {
    const res = await app.request("/auth/device-login", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      deviceCode: string;
      expiresIn: number;
      interval: number;
    };
    expect(body.userCode).toBe("ABCD-EFGH");
    expect(body.deviceCode).toBe("device-code-123");
    expect(body.verificationUri).toContain("https://auth.example.com/device");
    expect(body.expiresIn).toBe(1800);
    expect(body.interval).toBe(5);
  });

  it("returns 500 when the provider device-code request fails", async () => {
    mockCurlFetch.curlFetchPost.mockImplementation(async () => ({
      status: 502,
      body: JSON.stringify({ error: "server_error" }),
      ok: false,
    }));

    const res = await app.request("/auth/device-login", { method: "POST" });
    expect(res.status).toBe(500);
    expect(pool.isAuthenticated()).toBe(false);
  });
});

describe("GET /auth/device-poll/:deviceCode", () => {
  it("returns pending while authorization is not yet complete", async () => {
    mockCurlFetch.curlFetchPost.mockImplementation(async () => ({
      status: 400,
      body: JSON.stringify({
        error: "authorization_pending",
        error_description: "Authorization pending",
      }),
      ok: false,
    }));

    const res = await app.request("/auth/device-poll/device-code-123");
    expect(res.status).toBe(200);
    const body = await res.json() as { pending: boolean; code: string };
    expect(body.pending).toBe(true);
    expect(body.code).toBe("authorization_pending");
    expect(pool.isAuthenticated()).toBe(false);
  });

  it("adds the account on success (200)", async () => {
    const res = await app.request("/auth/device-poll/device-code-123");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(pool.isAuthenticated()).toBe(true);
    expect(pool.getPoolSummary().total).toBe(1);
  });

  it("returns 400 for a hard provider poll error", async () => {
    mockCurlFetch.curlFetchPost.mockImplementation(async () => ({
      status: 400,
      body: JSON.stringify({
        error: "expired_token",
        error_description: "The device code has expired",
      }),
      ok: false,
    }));

    const res = await app.request("/auth/device-poll/device-code-123");
    expect(res.status).toBe(400);
    expect(pool.isAuthenticated()).toBe(false);
  });
});