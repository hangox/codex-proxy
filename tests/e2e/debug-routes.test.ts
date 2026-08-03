/**
 * E2E tests for debug/diagnostics routes.
 *
 * - GET /debug/fingerprint
 * - GET /debug/diagnostics
 */

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";

// ── Mock control ──────────────────────────────────────────────────

let mockRemoteAddress = "127.0.0.1";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: mockRemoteAddress } })),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    client: {
      app_version: "1.2024.0",
      build_number: "1",
      platform: "darwin",
      arch: "arm64",
      originator: "desktop",
    },
    api: { base_url: "https://chatgpt.com/backend-api" },
    // claude_code_opaque_compact_experimental 显式给 false（不是留空靠
    // undefined 兜底）——undefined 值的 key 会被 JSON.stringify 直接
    // 丢弃，那样 /health 测试里就断言不到 `enabled` 这个 key 本身存在。
    model: { default: "gpt-5.4", claude_code_opaque_compact_experimental: false },
    server: { proxy_api_key: null },
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
  })),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version} ({platform}; {arch})",
    header_order: [],
    auth_domains: ["chatgpt.com"],
    auth_domain_exclusions: [],
    default_headers: {},
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/codex-e2e-debug/config"),
  getDataDir: vi.fn(() => "/tmp/codex-e2e-debug/data"),
  getBinDir: vi.fn(() => "/tmp/codex-e2e-debug/bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransportInfo: vi.fn(() => ({
    type: "native",
    initialized: true,
    impersonate: false,
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn(() => ({
    email: "test@test.com",
    chatgpt_plan_type: "free",
    chatgpt_user_id: "uid-test",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

// ── Imports ──────────────────────────────────────────────────────

import { Hono } from "hono";
import { createHealthRoutes } from "@src/routes/admin/health.js";
import { AccountPool } from "@src/auth/account-pool.js";

// ── Helpers ──────────────────────────────────────────────────────

function buildApp(): { app: Hono; pool: AccountPool } {
  const pool = new AccountPool();
  const routes = createHealthRoutes(pool);
  const app = new Hono();
  app.route("/", routes);
  return { app, pool };
}

// ── Tests ────────────────────────────────────────────────────────

let app: Hono;
let pool: AccountPool;
const origEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  mockRemoteAddress = "127.0.0.1";
  process.env.NODE_ENV = "development";
  ({ app, pool } = buildApp());
});

afterEach(() => {
  pool?.destroy();
});

afterAll(() => {
  process.env.NODE_ENV = origEnv;
});

// ★ 8.20（reviewer 复审发现）：`/health` 在 `dashboard-auth.ts` 的豁免
// 名单里是刻意设计（Docker/nginx 健康检查不能要求登录），生产经 nginx
// 对外暴露，因此是匿名可读的。opaque-compact 的容量明细（当前条数/字节
// 数/离 capacity·maxBytes 上限多远）不是凭据，但是运营信息，一度被错误
// 地加进了这个免鉴权端点——这里锁住"不会再发生"，不只是"这次改对了"：
// 光挪走字段不够，得有测试断言 `/health` 的响应体里确实没有这个字段，
// 否则以后有人往 `/health` 里加新字段时，同样的问题会重来。
describe("GET /health", () => {
  it("不返回 opaque-compact 容量明细（count/bytes/capacity/maxBytes）——那是运营信息，只能出现在受鉴权的 /admin/general-settings", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      opaque_compact_state: Record<string, unknown>;
    };
    // 只保留 readiness 布尔值——enabled/ready/reason（+ 可能的 detail），
    // 不应该出现 capacity/count/bytes/maxBytes 这类容量字段。
    expect(body.opaque_compact_state).not.toHaveProperty("capacity");
    expect(body.opaque_compact_state).not.toHaveProperty("count");
    expect(body.opaque_compact_state).not.toHaveProperty("bytes");
    expect(body.opaque_compact_state).not.toHaveProperty("maxBytes");
    expect(Object.keys(body.opaque_compact_state).sort()).toEqual(["enabled", "ready", "reason"].sort());
  });
});

describe("GET /debug/fingerprint", () => {
  it("returns fingerprint data from localhost", async () => {
    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      headers: { "User-Agent": string };
      client: { app_version: string };
      model: { default: string };
    };
    expect(body.headers["User-Agent"]).toContain("Codex/");
    expect(body.client.app_version).toBe("1.2024.0");
    expect(body.model.default).toBe("gpt-5.4");
  });

  it("returns 404 in production from non-localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "203.0.113.1";

    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(404);
  });

  it("allows access in production from localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "127.0.0.1";

    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(200);
  });
});

describe("GET /debug/diagnostics", () => {
  it("returns diagnostic info", async () => {
    const res = await app.request("/debug/diagnostics");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      transport: { type: string; initialized: boolean; impersonate: boolean };
      accounts: { total: number };
      paths: { bin: string; config: string; data: string };
      runtime: { platform: string; node_version: string };
    };
    expect(body.transport.type).toBe("native");
    expect(body.transport.initialized).toBe(true);
    expect(body.transport.impersonate).toBe(false);
    expect(typeof body.accounts.total).toBe("number");
    expect(body.paths.bin).toBe("/tmp/codex-e2e-debug/bin");
    expect(body.runtime.node_version).toContain("v");
  });

  it("returns 404 in production from non-localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "203.0.113.1";

    const res = await app.request("/debug/diagnostics");
    expect(res.status).toBe(404);
  });
});
