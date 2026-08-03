/**
 * Tests for `compact-outcome-log.ts`（8.10：Dashboard 快速压缩成功率）。
 *
 * 覆盖：写入（含四种 outcome 各自的字段）、按字节数轮转、读取（newest-first）、
 * 统计聚合（按请求 vs 按会话去重，成功率计算，recent_budget_exceeded）。
 * 按 `tests/unit/logs/error-log.test.ts` 的既有模式写（同一套 mock 手法：
 * mock `@src/paths.js`/`@src/config.js`，用 `VITEST_FORCE_APPEND_ERROR_LOG`
 * 逃生舱打开真实写入）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

interface MockConfig {
  observability: {
    local_error_log: boolean;
    max_log_bytes: number;
    compact_outcomes_max_bytes: number;
  };
  client: { app_version: string };
}

const mockConfig: MockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024, compact_outcomes_max_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

async function importModule() {
  return await import("@src/routes/shared/compact-outcome-log.js");
}

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "compact-outcomes-"));
  mockConfig.observability.local_error_log = true;
  mockConfig.observability.compact_outcomes_max_bytes = 10 * 1024 * 1024;
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

describe("recordCompactOutcome", () => {
  it("writes a success event with ts/rid/conv_hash/model/outcome", async () => {
    const { recordCompactOutcome } = await importModule();
    recordCompactOutcome({
      requestId: "rid-abcdef01",
      clientConversationId: "session-a",
      model: "gpt-5.6-sol",
      outcome: "success",
      replayed: false,
    });

    const file = resolve(tmpDataDir, "compact-outcomes.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.rid).toBe("rid-abcd"); // requestId.slice(0,8) — 注意包含连字符
    expect(entry.model).toBe("gpt-5.6-sol");
    expect(entry.outcome).toBe("success");
    expect(entry.replayed).toBe(false);
    expect(typeof entry.ts).toBe("string");
    expect(new Date(entry.ts as string).toString()).not.toBe("Invalid Date");
    // conv_hash 不可逆——不能是原始 clientConversationId。
    expect(entry.conv_hash).not.toBe("session-a");
    expect(typeof entry.conv_hash).toBe("string");
    expect((entry.conv_hash as string).length).toBeGreaterThan(0);
  });

  it("conv_hash is stable for the same session within a process, and null when no session", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "session-x", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "session-x", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: null, model: "m", outcome: "denied", reason: "missing_session_context" });

    const events = readCompactOutcomeLog();
    const [e3, e2, e1] = events; // newest-first
    expect(e1.conv_hash).toBe(e2.conv_hash);
    expect(e3.conv_hash).toBeNull();
  });

  it("budget_exceeded carries estimated_tokens/budget_tokens; other outcomes omit them", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog } = await importModule();
    recordCompactOutcome({
      requestId: "rid1",
      clientConversationId: "s1",
      model: "gpt-5.6-terra",
      outcome: "budget_exceeded",
      estimatedTokens: 448457,
      budgetTokens: 390000,
    });
    const [entry] = readCompactOutcomeLog();
    expect(entry.estimated_tokens).toBe(448457);
    expect(entry.budget_tokens).toBe(390000);
    expect(entry.replayed).toBeUndefined();
  });

  it("no-ops when observability.local_error_log is false", async () => {
    mockConfig.observability.local_error_log = false;
    const { recordCompactOutcome } = await importModule();
    recordCompactOutcome({ requestId: "r", clientConversationId: null, model: "m", outcome: "success" });
    expect(existsSync(resolve(tmpDataDir, "compact-outcomes.jsonl"))).toBe(false);
  });

  it("rotates to compact-outcomes.1.jsonl when current file exceeds compact_outcomes_max_bytes", async () => {
    // 单份备份设计（和 error-log.ts 同一套机制）：多次触发轮转会覆盖上一次
    // 的备份，导致更早的记录丢失——这是既有、已知、文档化的行为，不是这次
    // 新增的缺陷。这里选一个只会触发**恰好一次**轮转的组合（8 条、每条约
    // 130 字节，阈值 512 字节，累计约 1040 字节只够跨越阈值一次），验证
    // "轮转确实发生了、两个文件合起来数量不丢"，不去验证多次轮转的丢失
    // 行为（那是 error-log.ts 既有设计的一部分，不是这个模块要单独覆盖的）。
    mockConfig.observability.compact_outcomes_max_bytes = 512;
    const { recordCompactOutcome } = await importModule();
    for (let i = 0; i < 8; i++) {
      recordCompactOutcome({ requestId: `rid-${i}`, clientConversationId: `session-${i}`, model: "m", outcome: "success" });
    }
    const backup = resolve(tmpDataDir, "compact-outcomes.1.jsonl");
    expect(existsSync(backup)).toBe(true);
    const currentLines = readFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), "utf-8").trim().split("\n");
    const backupLines = readFileSync(backup, "utf-8").trim().split("\n");
    expect(currentLines.length + backupLines.length).toBe(8);
    expect(currentLines.length).toBeLessThan(8); // rotation actually happened
  });
});

describe("readCompactOutcomeLog", () => {
  it("returns entries newest-first across current + backup files", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s", model: "m", outcome: "denied", reason: "store_unavailable" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s", model: "m", outcome: "budget_exceeded" });

    const events = readCompactOutcomeLog();
    expect(events.map((e) => e.rid)).toEqual(["r3", "r2", "r1"]);
  });

  it("respects the limit parameter", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog } = await importModule();
    for (let i = 0; i < 5; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s", model: "m", outcome: "success" });
    }
    expect(readCompactOutcomeLog(2)).toHaveLength(2);
  });
});

describe("clearCompactOutcomeLog", () => {
  it("removes both current and backup files", async () => {
    mockConfig.observability.compact_outcomes_max_bytes = 512;
    const { recordCompactOutcome, clearCompactOutcomeLog } = await importModule();
    for (let i = 0; i < 15; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s", model: "m", outcome: "success" });
    }
    expect(existsSync(resolve(tmpDataDir, "compact-outcomes.1.jsonl"))).toBe(true);
    clearCompactOutcomeLog();
    expect(existsSync(resolve(tmpDataDir, "compact-outcomes.jsonl"))).toBe(false);
    expect(existsSync(resolve(tmpDataDir, "compact-outcomes.1.jsonl"))).toBe(false);
  });
});

describe("getCompactOutcomeStats", () => {
  it("按请求：原始事件计数，不去重", async () => {
    const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
    // 同一个会话内，模拟客户端退避重试：多次 budget_exceeded，最后一次 success。
    for (let i = 0; i < 5; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s1", model: "m", outcome: "budget_exceeded", estimatedTokens: 1, budgetTokens: 1 });
    }
    recordCompactOutcome({ requestId: "r-final", clientConversationId: "s1", model: "m", outcome: "success" });

    const stats = getCompactOutcomeStats("all");
    expect(stats.by_request.total).toBe(6);
    expect(stats.by_request.budget_exceeded).toBe(5);
    expect(stats.by_request.success).toBe(1);
    expect(stats.by_request.success_rate).toBeCloseTo(1 / 6, 5);
  });

  it("★ 按会话去重：取窗口内每个会话最后一条事件——198 次失败后 1 次成功，会话算成功", async () => {
    const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
    for (let i = 0; i < 5; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s1", model: "m", outcome: "budget_exceeded" });
    }
    recordCompactOutcome({ requestId: "r-final", clientConversationId: "s1", model: "m", outcome: "success" });

    const stats = getCompactOutcomeStats("all");
    // 按会话只有 1 个会话（s1），它最后一条事件是 success，所以按会话
    // 成功率是 100%——即便按请求成功率只有 1/6。
    expect(stats.by_session.total).toBe(1);
    expect(stats.by_session.success).toBe(1);
    expect(stats.by_session.budget_exceeded).toBe(0);
    expect(stats.by_session.success_rate).toBe(1);
  });

  it("按会话去重：反过来——先成功后又失败，会话算最后一次的失败", async () => {
    const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s1", model: "m", outcome: "denied", reason: "store_unavailable" });

    const stats = getCompactOutcomeStats("all");
    expect(stats.by_session.total).toBe(1);
    expect(stats.by_session.denied).toBe(1);
    expect(stats.by_session.success).toBe(0);
  });

  it("多会话：按会话正确分开统计，不同会话互不影响", async () => {
    const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "upstream_failed", reason: "CompactServiceError" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "m", outcome: "denied", reason: "store_unavailable" });

    const stats = getCompactOutcomeStats("all");
    expect(stats.by_session.total).toBe(3);
    expect(stats.by_session.success).toBe(1);
    expect(stats.by_session.upstream_failed).toBe(1);
    expect(stats.by_session.denied).toBe(1);
    expect(stats.by_session.success_rate).toBeCloseTo(1 / 3, 5);
  });

  it("total 为 0 时 success_rate 是 0，不是 NaN", async () => {
    const { getCompactOutcomeStats } = await importModule();
    const stats = getCompactOutcomeStats("all");
    expect(stats.by_request.total).toBe(0);
    expect(stats.by_request.success_rate).toBe(0);
    expect(stats.by_session.total).toBe(0);
    expect(stats.by_session.success_rate).toBe(0);
    expect(Number.isNaN(stats.by_request.success_rate)).toBe(false);
  });

  it("windowHours 过滤窗口外的事件", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog, getCompactOutcomeStats } = await importModule();
    recordCompactOutcome({ requestId: "r-old", clientConversationId: "s1", model: "m", outcome: "success" });

    // 手工把这一条的 ts 改到 48 小时前，模拟"窗口外的历史事件"。
    const events = readCompactOutcomeLog();
    const rewritten = events.map((e) => ({ ...e, ts: new Date(Date.now() - 48 * 3600_000).toISOString() }));
    const { writeFileSync } = await import("fs");
    writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    recordCompactOutcome({ requestId: "r-new", clientConversationId: "s2", model: "m", outcome: "success" });

    const stats24h = getCompactOutcomeStats(24);
    expect(stats24h.by_request.total).toBe(1); // 只有 r-new 落在 24 小时窗口内

    const statsAll = getCompactOutcomeStats("all");
    expect(statsAll.by_request.total).toBe(2); // "all" 不过滤
  });

  it("recent_budget_exceeded 只含 budget_exceeded 事件，按 limit 截断，字段完整", async () => {
    const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-terra", outcome: "budget_exceeded", estimatedTokens: 448457, budgetTokens: 390000 });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "budget_exceeded", estimatedTokens: 400000, budgetTokens: 390000 });

    const stats = getCompactOutcomeStats("all", 1);
    expect(stats.recent_budget_exceeded).toHaveLength(1);
    // newest-first：最近一条是 r3。
    expect(stats.recent_budget_exceeded[0].rid).toBe("r3");
    expect(stats.recent_budget_exceeded[0].model).toBe("gpt-5.6-terra");
    expect(stats.recent_budget_exceeded[0].estimated_tokens).toBe(400000);
    expect(stats.recent_budget_exceeded[0].budget_tokens).toBe(390000);
  });

  // ★ 8.17：压缩明细面板要求汇总区和明细列表用同一套筛选参数（含型号），
  // 否则用户按型号筛列表后，上面汇总的数字还是全部型号的合计，会造成
  // "看到 4 次降级、列表里对不上"这种误判——见 compact-detail-panel-design.md
  // 2.5 节。这里锁住 `model` 参数确实按精确匹配过滤，且不传时行为不变。
  describe("★ 8.17 model 参数", () => {
    it("传 model 时只统计该型号的事件", async () => {
      const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "budget_exceeded" });
      recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "success" });

      const solStats = getCompactOutcomeStats("all", 10, "gpt-5.6-sol");
      expect(solStats.by_request.total).toBe(2);
      expect(solStats.by_request.success).toBe(1);
      expect(solStats.by_request.budget_exceeded).toBe(1);

      const terraStats = getCompactOutcomeStats("all", 10, "gpt-5.6-terra");
      expect(terraStats.by_request.total).toBe(1);
    });

    it("不传 model（undefined）时行为和之前完全一样——不筛选", async () => {
      const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

      const stats = getCompactOutcomeStats("all");
      expect(stats.by_request.total).toBe(2);
    });

    it("传空字符串 model 等同于不筛选（不是一个永远匹配不到的过滤条件）", async () => {
      const { recordCompactOutcome, getCompactOutcomeStats } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });

      const stats = getCompactOutcomeStats("all", 10, "");
      expect(stats.by_request.total).toBe(1);
    });

    it("model 筛选和时间窗口筛选组合生效", async () => {
      const { recordCompactOutcome, readCompactOutcomeLog, getCompactOutcomeStats } = await importModule();
      recordCompactOutcome({ requestId: "r-old", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
      const events = readCompactOutcomeLog();
      const rewritten = events.map((e) => ({ ...e, ts: new Date(Date.now() - 48 * 3600_000).toISOString() }));
      const { writeFileSync } = await import("fs");
      writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
      recordCompactOutcome({ requestId: "r-new", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });
      recordCompactOutcome({ requestId: "r-new-other-model", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "success" });

      const stats = getCompactOutcomeStats(24, 10, "gpt-5.6-sol");
      expect(stats.by_request.total).toBe(1); // 只有 r-new：窗口内 + 型号匹配
    });
  });
});

describe("queryCompactOutcomeEvents", () => {
  it("newest-first，默认 limit=50、offset=0", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s", model: "m", outcome: "denied", reason: "store_unavailable" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s", model: "m", outcome: "budget_exceeded" });

    const page = queryCompactOutcomeEvents({ windowHours: "all" });
    expect(page.events.map((e) => e.rid)).toEqual(["r3", "r2", "r1"]);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it("分页：limit/offset 生效，total 是过滤后、分页前的总数", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
    for (let i = 0; i < 5; i++) {
      recordCompactOutcome({ requestId: `r${i}`, clientConversationId: "s", model: "m", outcome: "success" });
    }
    const page1 = queryCompactOutcomeEvents({ windowHours: "all", limit: 2, offset: 0 });
    expect(page1.events).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page2 = queryCompactOutcomeEvents({ windowHours: "all", limit: 2, offset: 2 });
    expect(page2.events).toHaveLength(2);
    // 两页不重叠
    expect(page1.events.map((e) => e.rid)).not.toEqual(page2.events.map((e) => e.rid));
    const page3 = queryCompactOutcomeEvents({ windowHours: "all", limit: 2, offset: 4 });
    expect(page3.events).toHaveLength(1); // 最后一页只剩 1 条
  });

  it("按 outcome 精确筛选", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "m", outcome: "budget_exceeded" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "m", outcome: "budget_exceeded" });

    const page = queryCompactOutcomeEvents({ windowHours: "all", outcome: "budget_exceeded" });
    expect(page.total).toBe(2);
    expect(page.events.every((e) => e.outcome === "budget_exceeded")).toBe(true);
  });

  it("按 model 精确筛选", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-terra", outcome: "success" });

    const page = queryCompactOutcomeEvents({ windowHours: "all", model: "gpt-5.6-sol" });
    expect(page.total).toBe(1);
    expect(page.events[0].model).toBe("gpt-5.6-sol");
  });

  it("outcome + model 同时筛选，AND 逻辑", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "budget_exceeded" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "budget_exceeded" });

    const page = queryCompactOutcomeEvents({ windowHours: "all", outcome: "budget_exceeded", model: "gpt-5.6-sol" });
    expect(page.total).toBe(1);
    expect(page.events[0].rid).toBe("r1");
  });

  it("窗口外的事件不计入 total", async () => {
    const { recordCompactOutcome, readCompactOutcomeLog, queryCompactOutcomeEvents } = await importModule();
    recordCompactOutcome({ requestId: "r-old", clientConversationId: "s1", model: "m", outcome: "success" });
    const events = readCompactOutcomeLog();
    const rewritten = events.map((e) => ({ ...e, ts: new Date(Date.now() - 48 * 3600_000).toISOString() }));
    const { writeFileSync } = await import("fs");
    writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    recordCompactOutcome({ requestId: "r-new", clientConversationId: "s2", model: "m", outcome: "success" });

    const page24h = queryCompactOutcomeEvents({ windowHours: 24 });
    expect(page24h.total).toBe(1);
    const pageAll = queryCompactOutcomeEvents({ windowHours: "all" });
    expect(pageAll.total).toBe(2);
  });

  it("★ 和 getCompactOutcomeStats 用同一套过滤顺序，同一组条件下 total 应该和聚合的 by_request.total 一致", async () => {
    const { recordCompactOutcome, queryCompactOutcomeEvents, getCompactOutcomeStats } = await importModule();
    recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "budget_exceeded" });
    recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });
    recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-terra", outcome: "success" });

    const stats = getCompactOutcomeStats("all", 10, "gpt-5.6-sol");
    const page = queryCompactOutcomeEvents({ windowHours: "all", model: "gpt-5.6-sol" });
    // 这正是设计文档 2.5 节要保证的那条不变量：汇总区的按请求总数和明细
    // 列表在同一组筛选条件下的 total 必须相等，否则就是用户担心的"数字
    // 对不上"。
    expect(page.total).toBe(stats.by_request.total);
  });

  it("空数据：total=0，events 是空数组，不抛错", async () => {
    const { queryCompactOutcomeEvents } = await importModule();
    const page = queryCompactOutcomeEvents({ windowHours: "all" });
    expect(page.total).toBe(0);
    expect(page.events).toEqual([]);
    expect(page.availableModels).toEqual([]);
  });

  // ★ 8.18：型号筛选下拉框的数据来源——不能硬编码，见字段头部注释。
  describe("★ 8.18 availableModels", () => {
    it("去重、按字母序返回时间窗口内出现过的型号", async () => {
      const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-terra", outcome: "success" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });
      recordCompactOutcome({ requestId: "r3", clientConversationId: "s3", model: "gpt-5.6-sol", outcome: "budget_exceeded" }); // 重复型号

      const page = queryCompactOutcomeEvents({ windowHours: "all" });
      expect(page.availableModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]); // 去重 + 字母序
    });

    it("★ 不因为当前 outcome 筛选而收窄——切换结果类型筛选时型号选项不应该消失", async () => {
      const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-terra", outcome: "success" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "budget_exceeded" });

      // 筛 outcome=success 时，availableModels 依然要包含 gpt-5.6-sol
      // （它只有 budget_exceeded 记录，没有 success 记录）——否则用户切换
      // 结果类型筛选时会看到型号选项莫名其妙地变化。
      const page = queryCompactOutcomeEvents({ windowHours: "all", outcome: "success" });
      expect(page.availableModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
      expect(page.events).toHaveLength(1); // 但实际返回的记录仍然只有 success 那条
    });

    it("★ 不因为当前 model 筛选而塌缩成只剩一个——否则选中型号后下拉框就切不回别的型号了", async () => {
      const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "gpt-5.6-terra", outcome: "success" });
      recordCompactOutcome({ requestId: "r2", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });

      const page = queryCompactOutcomeEvents({ windowHours: "all", model: "gpt-5.6-sol" });
      expect(page.availableModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
      expect(page.events).toHaveLength(1); // 实际返回的记录仍然只有筛中的那个型号
    });

    it("只按时间窗口过滤——窗口外的型号不出现在列表里", async () => {
      const { recordCompactOutcome, readCompactOutcomeLog, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r-old", clientConversationId: "s1", model: "gpt-5.6-old-model", outcome: "success" });
      const events = readCompactOutcomeLog();
      const rewritten = events.map((e) => ({ ...e, ts: new Date(Date.now() - 48 * 3600_000).toISOString() }));
      const { writeFileSync } = await import("fs");
      writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
      recordCompactOutcome({ requestId: "r-new", clientConversationId: "s2", model: "gpt-5.6-sol", outcome: "success" });

      const page24h = queryCompactOutcomeEvents({ windowHours: 24 });
      expect(page24h.availableModels).toEqual(["gpt-5.6-sol"]); // 窗口外的 gpt-5.6-old-model 不出现
      const pageAll = queryCompactOutcomeEvents({ windowHours: "all" });
      expect(pageAll.availableModels).toEqual(["gpt-5.6-old-model", "gpt-5.6-sol"]);
    });
  });

  // ★ 8.19（reviewer2 P2，真崩溃 bug）：conv_hash 缺字段（不是 null，是
  // undefined）时会话搜索不能让整个请求 500。
  describe("★ 8.19 conv_hash 缺字段时会话前缀搜索不崩", () => {
    it("conv_hash 字段完全缺失（旧格式/截断写入）的记录，按前缀搜索时被安全跳过，不抛错", async () => {
      const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r-good", clientConversationId: "s1", model: "m", outcome: "success" });

      // 直接往落盘文件里追加一条没有 conv_hash 字段的"脏"记录，模拟旧格式
      // 事件或写入中途被截断的行——不能只在测试里用 recordCompactOutcome
      // 构造，因为它总会写出合法的 conv_hash（null 或字符串），构造不出
      // "字段整个不存在"这种真实生产可能出现的脏数据形状。
      const { appendFileSync } = await import("fs");
      const dirty = { ts: new Date().toISOString(), rid: "dirty001", model: "m", outcome: "success" }; // 没有 conv_hash 字段
      appendFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), JSON.stringify(dirty) + "\n", "utf-8");

      expect(() => queryCompactOutcomeEvents({ windowHours: "all", convHashPrefix: "anything" })).not.toThrow();
      const page = queryCompactOutcomeEvents({ windowHours: "all", convHashPrefix: "anything" });
      expect(page.total).toBe(0); // 脏记录和正常记录都不匹配这个前缀，但不崩才是这条测试的重点
    });

    it("conv_hash 为 null（正常的'无会话'语义）时按前缀搜索依旧安全跳过，不抛错，行为和缺字段一致", async () => {
      const { recordCompactOutcome, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r-null-session", clientConversationId: null, model: "m", outcome: "denied", reason: "missing_session_context" });

      expect(() => queryCompactOutcomeEvents({ windowHours: "all", convHashPrefix: "a3f9" })).not.toThrow();
      expect(queryCompactOutcomeEvents({ windowHours: "all", convHashPrefix: "a3f9" }).total).toBe(0);
    });
  });

  // ★ 8.19（reviewer2 P2）：cutoff 计算此前在两个函数里各自独立调用
  // `Date.now()`，理论上可能导致同一组筛选条件在 `/summary` 和 `/events`
  // 两次独立请求之间对窗口边界的事件判断不一致。这里验证"给两个函数传
  // 同一个 `nowMs`，一定算出完全一致的窗口过滤结果"——这是这次改动实际
  // 能消除、也能被单元测试覆盖到的那部分（两次独立 HTTP 请求本身的轮询
  // 间隔落差不是这次改动的范围，见 `resolveWindowCutoffMs` 头部注释）。
  describe("★ 8.19 nowMs 确定性：同一个 nowMs 传给两个函数，cutoff 判断必须一致", () => {
    it("卡在窗口边界上的事件，给定同一个 nowMs 时 getCompactOutcomeStats 和 queryCompactOutcomeEvents 的判断完全一致", async () => {
      const { recordCompactOutcome, readCompactOutcomeLog, getCompactOutcomeStats, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r-boundary", clientConversationId: "s1", model: "gpt-5.6-sol", outcome: "success" });

      // 把这条事件的时间戳精确设成"nowMs 减 24 小时再加 1 毫秒"——刚好落在
      // 24 小时窗口的边界内侧（含），是最容易因为两次独立 Date.now() 调用
      // 而被错误地一边算进一边算不进的那种事件。
      const nowMs = Date.now();
      const boundaryTs = new Date(nowMs - 24 * 3600_000 + 1).toISOString();
      const events = readCompactOutcomeLog().map((e) => ({ ...e, ts: boundaryTs }));
      const { writeFileSync } = await import("fs");
      writeFileSync(resolve(tmpDataDir, "compact-outcomes.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

      const stats = getCompactOutcomeStats(24, 10, "gpt-5.6-sol", nowMs);
      const page = queryCompactOutcomeEvents({ windowHours: 24, model: "gpt-5.6-sol", nowMs });
      expect(stats.by_request.total).toBe(1);
      expect(page.total).toBe(1);
      expect(page.total).toBe(stats.by_request.total); // 同一个 nowMs 下，两边对这条边界事件的判断必须一致
    });

    it("不传 nowMs 时默认行为不变（仍然用真实 Date.now()）", async () => {
      const { recordCompactOutcome, getCompactOutcomeStats, queryCompactOutcomeEvents } = await importModule();
      recordCompactOutcome({ requestId: "r1", clientConversationId: "s1", model: "m", outcome: "success" });

      const stats = getCompactOutcomeStats("all");
      const page = queryCompactOutcomeEvents({ windowHours: "all" });
      expect(stats.by_request.total).toBe(1);
      expect(page.total).toBe(1);
    });
  });
});
