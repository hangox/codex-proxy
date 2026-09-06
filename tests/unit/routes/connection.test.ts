import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPool } from "../../../src/auth/account-pool.js";
import { createConnectionRoutes } from "../../../src/routes/admin/connection.js";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  baseUrl: "https://chatgpt.com/backend-api",
}));
vi.mock("../../../src/config.js", () => ({
  getConfig: () => ({ api: { base_url: mocks.baseUrl } }),
}));
vi.mock("../../../src/tls/transport.js", () => ({
  getTransport: () => ({ get: mocks.get }),
  getTransportInfo: () => ({ initialized: true, type: "native", impersonate: false }),
}));
vi.mock("../../../src/fingerprint/manager.js", () => ({
  buildHeaders: () => ({ Authorization: "Bearer test-token" }),
}));

function setup(active = true) {
  const pool = {
    getPoolSummary: () => ({ active: active ? 1 : 0, total: 1 }),
    acquire: vi.fn(() => ({ token: "test-token", accountId: "account", entryId: "entry" })),
    releaseWithoutCounting: vi.fn(),
  };
  const app = createConnectionRoutes(pool as unknown as AccountPool);
  return { pool, request: () => app.request("/admin/test-connection", { method: "POST" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
  mocks.baseUrl = "https://chatgpt.com/backend-api";
});

describe("connection test usage endpoints", () => {
  it("passes via wham when the legacy endpoint would return a challenge", async () => {
    mocks.get.mockImplementation(async (url: string) => url.endsWith("/wham/usage")
      ? { status: 200, body: "{}" }
      : { status: 403, body: "Enable JavaScript and cookies to continue" });
    const { pool, request } = setup();
    const body = await (await request()).json();
    expect(body.overall).toBe("pass");
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      "https://chatgpt.com/backend-api/wham/usage",
      { Authorization: "Bearer test-token" }, 15,
    );
    expect(pool.releaseWithoutCounting).toHaveBeenCalledExactlyOnceWith("entry");
  });

  it.each(["http", "transport"])("falls back after a %s failure", async (failure) => {
    if (failure === "http") mocks.get.mockResolvedValueOnce({ status: 404, body: "" });
    else mocks.get.mockRejectedValueOnce(new Error("timeout"));
    mocks.get.mockResolvedValueOnce({ status: 200, body: "{}" });
    const { request } = setup();
    expect((await (await request()).json()).overall).toBe("pass");
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/codex/usage",
    ]);
  });

  it("supports custom base URLs and strips trailing slashes", async () => {
    mocks.baseUrl = "https://proxy.example///";
    mocks.get.mockResolvedValueOnce({ status: 404, body: "" });
    mocks.get.mockResolvedValueOnce({ status: 200, body: "{}" });
    const { request } = setup();
    expect((await (await request()).json()).overall).toBe("pass");
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([
      "https://proxy.example/api/codex/usage",
      "https://proxy.example/codex/usage",
    ]);
  });

  it("reports upstream HTTP failures and releases the account", async () => {
    mocks.get.mockResolvedValue({ status: 403, body: "Forbidden" });
    const { pool, request } = setup();
    const body = await (await request()).json();
    expect(body.overall).toBe("fail");
    expect(body.checks.find((check: { name: string }) => check.name === "upstream"))
      .toMatchObject({ status: "fail", detail: "HTTP 403", error: "Upstream returned 403" });
    expect(pool.releaseWithoutCounting).toHaveBeenCalledExactlyOnceWith("entry");
  });

  it("reports transport failures and releases the account", async () => {
    mocks.get.mockRejectedValue(new Error("connection refused"));
    const { pool, request } = setup();
    const body = await (await request()).json();
    expect(body.overall).toBe("fail");
    expect(body.checks.find((check: { name: string }) => check.name === "upstream"))
      .toMatchObject({ status: "fail", error: "connection refused" });
    expect(pool.releaseWithoutCounting).toHaveBeenCalledExactlyOnceWith("entry");
  });

  it("skips upstream requests when there are no active accounts", async () => {
    const { pool, request } = setup(false);
    const body = await (await request()).json();
    expect(body.overall).toBe("fail");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
  });
});