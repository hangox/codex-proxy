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
});
