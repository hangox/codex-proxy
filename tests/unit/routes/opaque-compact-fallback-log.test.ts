/**
 * root compact 静默降级为普通生成事件的结构化落盘（`recordOpaqueCompactFallback`）。
 *
 * 背景与设计取舍见 `src/routes/shared/opaque-compact-fallback-log.ts` 头部
 * 注释：这是与 8.6 `recordOpaqueCompactDenial` 并列的新收口点（不是复用/
 * 改名），因为这次记录的核心字段 `error_message` 是上游自由文本，而
 * `recordOpaqueCompactDenial` 的白名单设计明确不接受自由文本。
 *
 * 测试覆盖两条主线：
 * 1. 白名单穷举 + hash 字段行为，镜像 `opaque-compact-denial-log.test.ts`
 *    的既有模式。
 * 2. error_message 专属：marker 不会通过这个字段泄漏、超长文本会被截断、
 *    顶层 error.message（不过 redactJson）绝不能装原始自由文本。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-fallback-log-"));
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

function readErrorLogLines(): Array<Record<string, unknown>> {
  const path = resolve(tmpDataDir, "error-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readCompactOutcomeLines(): Array<Record<string, unknown>> {
  const path = resolve(tmpDataDir, "compact-outcomes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// 真实长度的 canary（32/43/43），假 canary 会让"截断也不泄漏"这类断言产生假阴性。
const MARKER_TOKEN =
  `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;
const SESSION_ID = "claude-session-canary-6f10ab";
const ACCOUNT_ENTRY_ID = "entry-account-canary-9f31cd";

describe("recordOpaqueCompactFallback", () => {
  it("落盘的 context 只含白名单字段，rid/model/input_items/error_name 原样保留", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    recordOpaqueCompactFallback({
      requestId: "rid-abcdef12",
      model: "claude-opus-4",
      inputItems: 42,
      clientConversationId: SESSION_ID,
      accountEntryId: ACCOUNT_ENTRY_ID,
      generation: 3,
      errorName: "CompactServiceError",
      errorMessage: "Codex API error (503): upstream unavailable",
      retryCount: 2,
    });

    const lines = readErrorLogLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.source).toBe("server");
    const err = entry.error as Record<string, unknown>;
    expect(err.name).toBe("OpaqueCompactFallback");
    // 顶层 error.message 不过 redactJson，因此只允许受控分类字符串
    // （error.name 的值），绝不允许上游自由文本落在这个不被脱敏的字段里。
    expect(err.message).toBe("CompactServiceError");

    const ctx = entry.context as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(
      [
        "account_hash",
        "conv_hash",
        "error_message",
        "error_name",
        "generation",
        "input_items",
        "model",
        "retry_count",
        "rid",
      ].sort(),
    );
    expect(ctx.rid).toBe("rid-abcdef12");
    expect(ctx.model).toBe("claude-opus-4");
    expect(ctx.input_items).toBe(42);
    expect(ctx.error_name).toBe("CompactServiceError");
    expect(ctx.error_message).toBe("Codex API error (503): upstream unavailable");
    expect(ctx.generation).toBe(3);
    expect(ctx.retry_count).toBe(2);
    expect(typeof ctx.conv_hash).toBe("string");
    expect((ctx.conv_hash as string)).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof ctx.account_hash).toBe("string");
    expect((ctx.account_hash as string)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("session/account 缺省时对应 hash 字段是 null，不是省略键也不是空字符串", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    recordOpaqueCompactFallback({
      requestId: "rid-no-session",
      model: "claude-sonnet-4",
      inputItems: 0,
      clientConversationId: null,
      errorName: "CompactServiceError",
      errorMessage: "no available accounts",
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    expect(ctx.conv_hash).toBeNull();
    expect(ctx.account_hash).toBeNull();
    expect(ctx.generation).toBeNull();
    expect(ctx.retry_count).toBeNull();
  });

  it("error_message 里嵌的 opaque marker 不会原样落盘（经 sanitizeFreeTextForLog 脱敏）", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    recordOpaqueCompactFallback({
      requestId: "rid-marker-in-message",
      model: "claude-opus-4",
      inputItems: 5,
      clientConversationId: null,
      errorName: "CompactServiceError",
      errorMessage: `upstream echoed previous state ${MARKER_TOKEN} back in the error body`,
    });

    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(MARKER_TOKEN);
    expect(raw).not.toContain("A".repeat(32));
    expect(raw).not.toContain("B".repeat(43));
    expect(raw).not.toContain("C".repeat(43));
  });

  it("超长 error_message 被截断，不会把整段上游 body 原样落盘", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    const longMessage = "z".repeat(5000);
    recordOpaqueCompactFallback({
      requestId: "rid-long-message",
      model: "claude-opus-4",
      inputItems: 1,
      clientConversationId: null,
      errorName: "CompactServiceError",
      errorMessage: longMessage,
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    const stored = ctx.error_message as string;
    expect(stored.length).toBeLessThan(longMessage.length);
    expect(stored).toContain("truncated");
  });

  it("硬禁止：整条落盘的 JSON 行不包含 session id 原文、account id 原文", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    recordOpaqueCompactFallback({
      requestId: "rid-privacy-scan",
      model: "claude-opus-4",
      inputItems: 3,
      clientConversationId: SESSION_ID,
      accountEntryId: ACCOUNT_ENTRY_ID,
      errorName: "CompactServiceError",
      errorMessage: "plain classification message",
    });

    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(SESSION_ID);
    expect(raw).not.toContain(ACCOUNT_ENTRY_ID);
  });

  it("同一 session/account 两次调用产出相同 hash（可关联），不同输入产出不同 hash", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    recordOpaqueCompactFallback({
      requestId: "rid-1",
      model: "claude-opus-4",
      inputItems: 1,
      clientConversationId: SESSION_ID,
      errorName: "CompactServiceError",
      errorMessage: "a",
    });
    recordOpaqueCompactFallback({
      requestId: "rid-2",
      model: "claude-opus-4",
      inputItems: 1,
      clientConversationId: SESSION_ID,
      errorName: "CompactServiceError",
      errorMessage: "b",
    });
    recordOpaqueCompactFallback({
      requestId: "rid-3",
      model: "claude-opus-4",
      inputItems: 1,
      clientConversationId: "a-different-session",
      errorName: "CompactServiceError",
      errorMessage: "c",
    });

    const lines = readErrorLogLines();
    const hashes = lines.map((l) => (l.context as Record<string, unknown>).conv_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("落盘失败（写入抛错）不向调用方冒泡", async () => {
    const { recordOpaqueCompactFallback } = await import(
      "@src/routes/shared/opaque-compact-fallback-log.js"
    );
    tmpDataDir = "/nonexistent-root-path-for-test/does-not-exist";
    expect(() =>
      recordOpaqueCompactFallback({
        requestId: "rid-fail",
        model: "claude-opus-4",
        inputItems: 1,
        clientConversationId: null,
        errorName: "CompactServiceError",
        errorMessage: "boom",
      }),
    ).not.toThrow();
  });

  // ★ 8.10：Dashboard 快速压缩成功率——recordOpaqueCompactFallback 现在
  // 顺带把 outcome 落进独立的 compact-outcomes.jsonl（budget_exceeded vs
  // upstream_failed，靠 classification.skippedUpstream 区分），见
  // compact-outcome-log.ts。这里只验证路由对不对，字段/隐私细节已经在
  // compact-outcome-log.test.ts 里覆盖过，不重复。
  describe("compact-outcomes.jsonl 落盘（8.10）", () => {
    it("classification.skippedUpstream=true → outcome=budget_exceeded，带上 estimated/budget tokens", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-budget",
        model: "gpt-5.6-terra",
        inputItems: 500,
        clientConversationId: SESSION_ID,
        errorName: "CompactServiceError",
        errorMessage: "Estimated compact input (~448457 tokens) exceeds the context window budget (~390000 tokens)",
        classification: { skippedUpstream: true, estimatedTokens: 448457, budgetTokens: 390000 },
      });
      const [entry] = readCompactOutcomeLines();
      expect(entry.outcome).toBe("budget_exceeded");
      expect(entry.estimated_tokens).toBe(448457);
      expect(entry.budget_tokens).toBe(390000);
    });

    // ★ #97（用户原话："这个为什么是降级？"——team-lead 排查这条具体记录
    // 时发现的观测缺口）：estimateSource/processedFraction/cheapEstimateTokens
    // 三件套原样透传到 compact-outcomes.jsonl，锁住 recordOpaqueCompactFallback
    // 这一段链路，不重复 compact-outcome-log.test.ts 已经覆盖的字段级细节。
    it("classification 带 estimateSource/processedFraction/cheapEstimateTokens 时原样透传（precise_extrapolated 场景）", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-budget-extrapolated",
        model: "gpt-5.6-sol",
        inputItems: 500,
        clientConversationId: SESSION_ID,
        errorName: "CompactServiceError",
        errorMessage: "Estimated compact input (~417000 tokens) exceeds the context window budget (~390000 tokens)",
        classification: {
          skippedUpstream: true,
          estimatedTokens: 417000,
          budgetTokens: 390000,
          estimateSource: "precise_extrapolated",
          processedFraction: 0.42,
          cheapEstimateTokens: 620000,
        },
      });
      const [entry] = readCompactOutcomeLines();
      expect(entry.outcome).toBe("budget_exceeded");
      expect(entry.estimate_source).toBe("precise_extrapolated");
      expect(entry.processed_fraction).toBe(0.42);
      expect(entry.cheap_estimate_tokens).toBe(620000);
    });

    it("classification 不带 estimateSource 等三个新字段时，compact-outcomes.jsonl 里省略键，不补默认值", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-budget-legacy",
        model: "gpt-5.6-sol",
        inputItems: 500,
        clientConversationId: SESSION_ID,
        errorName: "CompactServiceError",
        errorMessage: "Estimated compact input (~300000 tokens) exceeds the context window budget (~260000 tokens)",
        classification: { skippedUpstream: true, estimatedTokens: 300000, budgetTokens: 260000 },
      });
      const [entry] = readCompactOutcomeLines();
      expect("estimate_source" in entry).toBe(false);
      expect("processed_fraction" in entry).toBe(false);
      expect("cheap_estimate_tokens" in entry).toBe(false);
    });

    it("classification.skippedUpstream=false → outcome=upstream_failed", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-upstream",
        model: "gpt-5.6-sol",
        inputItems: 10,
        clientConversationId: SESSION_ID,
        errorName: "CompactServiceError",
        errorMessage: "Codex API error (400): Prompt is too long",
        classification: { skippedUpstream: false },
      });
      const [entry] = readCompactOutcomeLines();
      expect(entry.outcome).toBe("upstream_failed");
      expect(entry.estimated_tokens).toBeUndefined();
    });

    it("没有 classification（非 CompactServiceError 的调用方）→ 保守当作 upstream_failed", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-no-classification",
        model: "m",
        inputItems: 1,
        clientConversationId: null,
        errorName: "UnexpectedError",
        errorMessage: "something else broke",
      });
      const [entry] = readCompactOutcomeLines();
      expect(entry.outcome).toBe("upstream_failed");
    });

    // ★ #88：classification.durationMs/upstreamMs 透传到 compact-outcomes.jsonl。
    it("classification.durationMs/upstreamMs 原样透传给 duration_ms/upstream_ms", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-timed",
        model: "gpt-5.6-sol",
        inputItems: 10,
        clientConversationId: SESSION_ID,
        errorName: "CompactServiceError",
        errorMessage: "Codex API error (429): rate limited",
        classification: { skippedUpstream: false, durationMs: 1234, upstreamMs: 980 },
      });
      const [entry] = readCompactOutcomeLines();
      expect(entry.duration_ms).toBe(1234);
      expect(entry.upstream_ms).toBe(980);
    });

    it("没有 durationMs/upstreamMs 时省略键，不补 0", async () => {
      const { recordOpaqueCompactFallback } = await import(
        "@src/routes/shared/opaque-compact-fallback-log.js"
      );
      recordOpaqueCompactFallback({
        requestId: "rid-untimed",
        model: "m",
        inputItems: 1,
        clientConversationId: null,
        errorName: "CompactServiceError",
        errorMessage: "boom",
        classification: { skippedUpstream: true, estimatedTokens: 1, budgetTokens: 1 },
      });
      const [entry] = readCompactOutcomeLines();
      expect("duration_ms" in entry).toBe(false);
      expect("upstream_ms" in entry).toBe(false);
    });
  });
});
