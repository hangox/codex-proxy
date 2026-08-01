/**
 * Tests for the compact outcomes API route (8.12 — Dashboard 快速压缩成功率)。
 *
 * 只测这个路由文件本身（参数解析、HTTP 状态码、把结果原样透传）——
 * `getCompactOutcomeStats` 的统计逻辑（按会话去重、成功率计算等）已经在
 * `compact-outcome-log.test.ts` 里覆盖过，不在这里重复。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024, compact_outcomes_max_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "compact-outcomes-route-"));
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

describe("GET /admin/compact-outcomes/summary", () => {
  it("默认窗口(hours=24)返回空统计时 total 为 0、success_rate 为 0", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    const res = await app.request("/admin/compact-outcomes/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_request.total).toBe(0);
    expect(body.by_session.total).toBe(0);
    expect(body.recent_budget_exceeded).toEqual([]);
  });

  it("透传真实落盘的事件到统计结果里", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({
      requestId: "r2",
      clientConversationId: "s2",
      model: "gpt-5.6-terra",
      outcome: "budget_exceeded",
      estimatedTokens: 448457,
      budgetTokens: 390000,
    });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/summary?hours=all");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_request.total).toBe(2);
    expect(body.by_request.success).toBe(1);
    expect(body.by_request.budget_exceeded).toBe(1);
    expect(body.recent_budget_exceeded).toHaveLength(1);
    expect(body.recent_budget_exceeded[0].estimated_tokens).toBe(448457);
    expect(body.recent_budget_exceeded[0].budget_tokens).toBe(390000);
  });

  it("hours=all 时接受字符串 'all'", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    const res = await app.request("/admin/compact-outcomes/summary?hours=all");
    expect(res.status).toBe(200);
  });

  it("拒绝非法 hours 参数（非正整数、非 'all'）", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    for (const bad of ["0", "-5", "not-a-number", "1.5"]) {
      const res = await app.request(`/admin/compact-outcomes/summary?hours=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("接受数字 hours 并按窗口过滤", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome, readCompactOutcomeLog } = await import("@src/routes/shared/compact-outcome-log.js");
    const { writeFileSync } = await import("fs");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

    recordCompactOutcome({ requestId: "r-old", clientConversationId: "s1", model: "m", outcome: "success" });
    const events = readCompactOutcomeLog();
    const rewritten = events.map((e) => ({ ...e, ts: new Date(Date.now() - 48 * 3600_000).toISOString() }));
    writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    recordCompactOutcome({ requestId: "r-new", clientConversationId: "s2", model: "m", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/summary?hours=24");
    const body = await res.json();
    expect(body.by_request.total).toBe(1);
  });
});
