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

  // ★ 8.17
  it("接受 model 参数并按型号过滤统计结果", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/summary?hours=all&model=gpt-5.6-sol");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_request.total).toBe(1);
  });

  it("不带 model 参数时行为不变（全部型号）", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/summary?hours=all");
    const body = await res.json();
    expect(body.by_request.total).toBe(2);
  });

  // ★ #108：不带 compact_path 参数时，默认排除 fallback_render——保住既有
  // "opaque 压缩成功率"卡片的数字不被这次改动稀释，见 compact-outcome-log.ts
  // 的 CompactPath / getCompactOutcomeStats 头部注释。
  describe("★ #108 compact_path 参数", () => {
    it("不带 compact_path 时，默认排除 fallback_render（既有口径不变）", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/summary?hours=all");
      const body = await res.json();
      expect(body.by_request.total).toBe(1);
    });

    // ★ #108（team-lead 批准附加条件）：/summary 必须在默认排除
    // fallback_render 的同时，额外并列一个 render 键——不然"方便对比"这个
    // 用户诉求会落空（明细列表逐条数记录不叫"方便对比"，需要一个汇总数字）。
    describe("★ #108 /summary 并列的 render 组", () => {
      it("默认调用（不带 compact_path）时，响应体里同时有主口径（排除 render）和并列的 render 组", async () => {
        const { Hono } = await import("hono");
        const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
        const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

        recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
        recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });
        recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "m", outcome: "upstream_failed", compactPath: "fallback_render" });

        const app = new Hono();
        app.route("/", createCompactOutcomesRoutes());
        const res = await app.request("/admin/compact-outcomes/summary?hours=all");
        const body = await res.json();

        // 主口径不变：只有 opaque 那一条，render 事件被排除在外——这是
        // 既有"opaque 压缩成功率"卡片的数字，不能被这次改动稀释。
        expect(body.by_request.total).toBe(1);
        // 并列的 render 组：单独统计 fallback_render 的两条事件，不占用
        // 主口径的分母。
        expect(body.render).toBeDefined();
        expect(body.render.by_request.total).toBe(2);
        expect(body.render.by_request.render_completed).toBe(1);
        expect(body.render.by_request.upstream_failed).toBe(1);
        expect(body.render.by_session).toBeDefined();
        // render 组不需要 recent_budget_exceeded——fallback_render 路径
        // 不会产生这个 outcome，塞一个恒为空数组的字段没有信息量。
        expect(body.render.recent_budget_exceeded).toBeUndefined();
      });

      it("render 组和主口径共享同一套 hours/model 筛选条件，不会出现两组数字用了不同筛选范围", async () => {
        const { Hono } = await import("hono");
        const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
        const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

        recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "render_completed", compactPath: "fallback_render" });
        recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "render_completed", compactPath: "fallback_render" });

        const app = new Hono();
        app.route("/", createCompactOutcomesRoutes());
        const res = await app.request("/admin/compact-outcomes/summary?hours=all&model=gpt-5.6-sol");
        const body = await res.json();
        // render 组只统计 gpt-5.6-sol，跟主口径用的是同一个 model 参数。
        expect(body.render.by_request.total).toBe(1);
      });

      it("即便显式传了 compact_path=fallback_render，render 组依然存在（跟主口径数字一致，冗余但不出错）", async () => {
        const { Hono } = await import("hono");
        const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
        const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

        recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

        const app = new Hono();
        app.route("/", createCompactOutcomesRoutes());
        const res = await app.request("/admin/compact-outcomes/summary?hours=all&compact_path=fallback_render");
        const body = await res.json();
        expect(body.by_request.total).toBe(1);
        expect(body.render.by_request.total).toBe(1);
      });
    });

    it("compact_path=fallback_render 时只统计 fallback_render 事件", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/summary?hours=all&compact_path=fallback_render");
      const body = await res.json();
      expect(body.by_request.total).toBe(1);
      expect(body.by_request.render_completed).toBe(1);
    });

    it("compact_path=all 时三类全部计入", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/summary?hours=all&compact_path=all");
      const body = await res.json();
      expect(body.by_request.total).toBe(2);
    });

    it("非法 compact_path 值返回 400", async () => {
      const { Hono } = await import("hono");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());

      const res = await app.request("/admin/compact-outcomes/summary?hours=all&compact_path=not_a_real_path");
      expect(res.status).toBe(400);
    });
  });
});

// ★ 8.17：压缩明细面板的列表数据源。
describe("GET /admin/compact-outcomes/events", () => {
  it("默认窗口(hours=24)、无数据时返回空列表，total=0", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    const res = await app.request("/admin/compact-outcomes/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("透传真实落盘的事件，newest-first", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "denied", reason: "store_unavailable" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/events?hours=all");
    const body = await res.json();
    expect(body.events.map((e: { rid: string }) => e.rid)).toEqual(["r2", "r1"]);
    expect(body.total).toBe(2);
  });

  it("支持 limit/offset 分页", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    for (let i = 0; i < 5; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s", model: "m", outcome: "success" });
    }

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/events?hours=all&limit=2&offset=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(2);
  });

  it("按 outcome 过滤，非法 outcome 值返回 400", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "budget_exceeded" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    const okRes = await app.request("/admin/compact-outcomes/events?hours=all&outcome=budget_exceeded");
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody.total).toBe(1);

    const badRes = await app.request("/admin/compact-outcomes/events?hours=all&outcome=not_a_real_outcome");
    expect(badRes.status).toBe(400);
  });

  it("按 model 过滤", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/events?hours=all&model=gpt-5.6-sol");
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.events[0].model).toBe("gpt-5.6-sol");
  });

  it("★ 8.18：端点透传 availableModels，且不因 model 筛选而塌缩——驱动前端型号下拉框", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const res = await app.request("/admin/compact-outcomes/events?hours=all&model=gpt-5.6-sol");
    const body = await res.json();
    expect(body.availableModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]); // 即便筛了 model，选项列表仍然完整
  });

  it("拒绝非法 hours 参数（和 /summary 共用同一套校验）", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    const res = await app.request("/admin/compact-outcomes/events?hours=-5");
    expect(res.status).toBe(400);
  });

  it("拒绝非法 limit（超过 200 上限、非正整数）", async () => {
    const { Hono } = await import("hono");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());

    for (const bad of ["0", "-1", "201", "not-a-number"]) {
      const res = await app.request(`/admin/compact-outcomes/events?limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("★ 和 /summary 用同一组筛选条件时，events 的 total 应该等于 summary 的 by_request.total（设计文档 2.5 节的核心不变量）", async () => {
    const { Hono } = await import("hono");
    const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
    const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "budget_exceeded" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "success" });

    const app = new Hono();
    app.route("/", createCompactOutcomesRoutes());
    const summaryRes = await app.request("/admin/compact-outcomes/summary?hours=all&model=gpt-5.6-sol");
    const summaryBody = await summaryRes.json();
    const eventsRes = await app.request("/admin/compact-outcomes/events?hours=all&model=gpt-5.6-sol");
    const eventsBody = await eventsRes.json();

    expect(eventsBody.total).toBe(summaryBody.by_request.total);
  });

  // ★ #108：默认展示全部三条路径（跟 /summary 默认排除 fallback_render
  // 刻意相反），可选按 compact_path 精确筛选。
  describe("★ #108 compact_path 参数", () => {
    it("不带 compact_path 时不过滤——opaque/fallback_decision/fallback_render 全部展示", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "upstream_failed", compactPath: "fallback_decision" });
      recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/events?hours=all");
      const body = await res.json();
      expect(body.total).toBe(3);
    });

    it("按 compact_path 精确筛选", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/events?hours=all&compact_path=fallback_render");
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.events[0].compact_path).toBe("fallback_render");
    });

    it("非法 compact_path 值返回 400（/events 不接受 'all' 哨兵——本来就不过滤）", async () => {
      const { Hono } = await import("hono");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");
      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());

      const res = await app.request("/admin/compact-outcomes/events?hours=all&compact_path=not_a_real_path");
      expect(res.status).toBe(400);
    });

    it("★ 8.18 同款：端点透传 availableCompactPaths，供前端路径筛选下拉框", async () => {
      const { Hono } = await import("hono");
      const { recordCompactOutcome } = await import("@src/routes/shared/compact-outcome-log.js");
      const { createCompactOutcomesRoutes } = await import("@src/routes/admin/compact-outcomes.js");

      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success", compactPath: "opaque" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "render_completed", compactPath: "fallback_render" });

      const app = new Hono();
      app.route("/", createCompactOutcomesRoutes());
      const res = await app.request("/admin/compact-outcomes/events?hours=all&compact_path=opaque");
      const body = await res.json();
      expect(body.availableCompactPaths).toEqual(["opaque", "fallback_render"]); // 即便筛了 path，选项列表仍然完整
    });
  });
});
