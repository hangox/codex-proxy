/**
 * 8.6：opaque compact 409 / fail-closed 结构化日志的隐私合同 + 白名单穷举。
 *
 * 事故复盘（交接文档 6.4）：事故窗口内 opaque 相关的 409 零条结构化证据，
 * 直接导致 malformed 的具体触发方式永久无法定论。`recordOpaqueCompactDenial`
 * 就是补这个洞——但补洞本身不能开一个新的泄漏通道，所以这里既测"确实落盘
 * 了"，也测"落盘的只有白名单字段，raw marker/session/account 原文
 * 一个字符都不出现"。
 *
 * `detail` 字段（排查另一次生产事故新补——单个会话 49 分钟内撞了 77 次
 * `store_unavailable` 409，根因永久查不到，因为原始异常从未落进结构化
 * 日志）是白名单里唯一的自由文本例外，额外测它的脱敏/截断行为，见文件
 * 下方专门的用例。
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
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-denial-log-"));
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

// 真实长度的 canary（32/43/43），假 canary 会让"截断也不泄漏"这类断言产生假阴性。
const MARKER_TOKEN =
  `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;
const SESSION_ID = "claude-session-canary-6f10ab";
const ACCOUNT_ENTRY_ID = "entry-account-canary-9f31cd";

describe("recordOpaqueCompactDenial", () => {
  it("落盘的 context 只含白名单八个字段，rid/reason/detail/cause 原样保留（detail 已脱敏）", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-abcdef12",
      reason: "expired",
      clientConversationId: SESSION_ID,
      marker: MARKER_TOKEN,
      accountEntryId: ACCOUNT_ENTRY_ID,
      generation: 3,
      detail: "OpaqueCompactRepositoryError: SQLITE_CORRUPT: database disk image is malformed",
      // ★ #83：cause 是新增字段，只在 recompact_failed_original_account
      // 这类聚合 reason 上才会传，这里用真实枚举值验证它原样落盘、不受
      // sanitizeFreeTextForLog 影响（不是自由文本，不需要脱敏）。
      cause: "rate_limited",
    });

    const lines = readErrorLogLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.source).toBe("server");
    const err = entry.error as Record<string, unknown>;
    expect(err.name).toBe("OpaqueCompactDenied");
    expect(err.message).toBe("expired");

    const ctx = entry.context as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(
      ["account_hash", "cause", "detail", "generation", "marker_length", "reason", "rid", "conv_hash"].sort(),
    );
    expect(ctx.rid).toBe("rid-abcdef12");
    expect(ctx.reason).toBe("expired");
    expect(ctx.cause).toBe("rate_limited");
    expect(ctx.marker_length).toBe(MARKER_TOKEN.length);
    expect(ctx.generation).toBe(3);
    expect(typeof ctx.conv_hash).toBe("string");
    expect((ctx.conv_hash as string)).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof ctx.account_hash).toBe("string");
    expect((ctx.account_hash as string)).toMatch(/^[0-9a-f]{8}$/);
    expect(ctx.detail).toBe("OpaqueCompactRepositoryError: SQLITE_CORRUPT: database disk image is malformed");
  });

  it("cause 缺省时是 null，不是省略键也不是空字符串", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-no-cause",
      reason: "session_mismatch",
      clientConversationId: null,
      marker: null,
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    expect(ctx.cause).toBeNull();
  });

  it("detail 缺省时是 null，不是省略键也不是空字符串", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-no-detail",
      reason: "session_mismatch",
      clientConversationId: null,
      marker: null,
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    expect(ctx.detail).toBeNull();
  });

  it("detail 里嵌的 opaque marker 不会原样落盘（经 sanitizeFreeTextForLog 脱敏）", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-detail-marker",
      reason: "store_unavailable",
      clientConversationId: null,
      marker: null,
      detail: `some raw error text mentioning ${MARKER_TOKEN} inline`,
    });

    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(MARKER_TOKEN);
    expect(raw).not.toContain("A".repeat(32));
    expect(raw).toContain("codex-opaque-state:***");
  });

  it("超长 detail 被截断，不会把整段底层异常文本原样落盘", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    const longDetail = "x".repeat(5000);
    recordOpaqueCompactDenial({
      requestId: "rid-long-detail",
      reason: "store_unavailable",
      clientConversationId: null,
      marker: null,
      detail: longDetail,
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    const stored = ctx.detail as string;
    expect(stored.length).toBeLessThan(longDetail.length);
    expect(stored).toContain("truncated");
  });

  it("硬禁止：整条落盘的 JSON 行不包含 raw marker 的任意一段、session id 原文、account id 原文", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-privacy-scan",
      reason: "invalid_marker",
      clientConversationId: SESSION_ID,
      marker: MARKER_TOKEN,
      accountEntryId: ACCOUNT_ENTRY_ID,
      generation: 1,
    });

    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(MARKER_TOKEN);
    expect(raw).not.toContain("A".repeat(32));
    expect(raw).not.toContain("B".repeat(43));
    expect(raw).not.toContain("C".repeat(43));
    expect(raw).not.toContain(SESSION_ID);
    expect(raw).not.toContain(ACCOUNT_ENTRY_ID);
    // payload/token/cookie 这类字段名本身也不该出现——函数签名里压根没有
    // 能装下它们的位置，这里再断言一次防止未来有人加字段时绕开签名。
    expect(raw).not.toMatch(/payload|token|cookie/i);
  });

  it("session/account 缺省时对应 hash 字段是 null，不是省略键也不是空字符串", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-no-session",
      reason: "missing_session_context",
      clientConversationId: null,
      marker: null,
    });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    expect(ctx.conv_hash).toBeNull();
    expect(ctx.account_hash).toBeNull();
    expect(ctx.marker_length).toBeNull();
    expect(ctx.generation).toBeNull();
  });

  it("同一 session/account 两次调用产出相同 hash（可关联），不同输入产出不同 hash", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-1",
      reason: "expired",
      clientConversationId: SESSION_ID,
      marker: null,
    });
    recordOpaqueCompactDenial({
      requestId: "rid-2",
      reason: "not_found",
      clientConversationId: SESSION_ID,
      marker: null,
    });
    recordOpaqueCompactDenial({
      requestId: "rid-3",
      reason: "not_found",
      clientConversationId: "a-different-session",
      marker: null,
    });

    const lines = readErrorLogLines();
    const hashes = lines.map((l) => (l.context as Record<string, unknown>).conv_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("落盘失败（写入抛错）不向调用方冒泡", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    // 指向一个不存在盘符/非法路径，逼 appendErrorLog 内部的 try/catch 生效；
    // 该函数已经文档化"绝不抛出"。
    tmpDataDir = "/nonexistent-root-path-for-test/does-not-exist";
    expect(() =>
      recordOpaqueCompactDenial({
        requestId: "rid-fail",
        reason: "expired",
        clientConversationId: null,
        marker: null,
      }),
    ).not.toThrow();
  });

  // ★ 8.10：Dashboard 快速压缩成功率——recordOpaqueCompactDenial 现在顺带
  // 把 outcome=denied 落进独立的 compact-outcomes.jsonl，见
  // compact-outcome-log.ts 头部注释（409/fail-closed 语义和"悄悄降级但
  // 仍然成功"完全不同，刻意单独一类）。
  it("顺带落一条 outcome=denied 到 compact-outcomes.jsonl，reason 透传", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-denied-outcome",
      reason: "store_unavailable",
      clientConversationId: SESSION_ID,
      marker: null,
      model: "gpt-5.6-sol",
    });

    const path = resolve(tmpDataDir, "compact-outcomes.jsonl");
    expect(existsSync(path)).toBe(true);
    const [entry] = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entry.outcome).toBe("denied");
    expect(entry.reason).toBe("store_unavailable");
    expect(entry.model).toBe("gpt-5.6-sol");
  });

  it("model 缺省时 compact-outcomes.jsonl 里落 \"unknown\"，不强凑/不报错", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-no-model",
      reason: "missing_session_context",
      clientConversationId: null,
      marker: null,
    });

    const path = resolve(tmpDataDir, "compact-outcomes.jsonl");
    const [entry] = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entry.model).toBe("unknown");
  });

  // ★ #88：durationMs/upstreamMs 只喂进 compact-outcomes.jsonl，不进
  // error-log.jsonl 的白名单 context（那份字段集合这次没变，见上面
  // "白名单八个字段" 那条测试）。
  it("durationMs/upstreamMs 透传到 compact-outcomes.jsonl，但不出现在 error-log.jsonl 的 context 里", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-denial-timed",
      reason: "recompact_failed_original_account",
      clientConversationId: SESSION_ID,
      marker: null,
      cause: "rate_limited",
      durationMs: 350,
      upstreamMs: 210,
    });

    const outcomePath = resolve(tmpDataDir, "compact-outcomes.jsonl");
    const [outcomeEntry] = readFileSync(outcomePath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(outcomeEntry.duration_ms).toBe(350);
    expect(outcomeEntry.upstream_ms).toBe(210);

    const errorLogLines = readErrorLogLines();
    const ctx = errorLogLines[0]!.context as Record<string, unknown>;
    expect("duration_ms" in ctx).toBe(false);
    expect("upstream_ms" in ctx).toBe(false);
  });

  it("denial 缺省 durationMs/upstreamMs 时，compact-outcomes.jsonl 里省略键，不补 0", async () => {
    const { recordOpaqueCompactDenial } = await import(
      "@src/routes/shared/opaque-compact-denial-log.js"
    );
    recordOpaqueCompactDenial({
      requestId: "rid-denial-untimed",
      reason: "missing_session_context",
      clientConversationId: null,
      marker: null,
    });

    const outcomePath = resolve(tmpDataDir, "compact-outcomes.jsonl");
    const [outcomeEntry] = readFileSync(outcomePath, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect("duration_ms" in outcomeEntry).toBe(false);
    expect("upstream_ms" in outcomeEntry).toBe(false);
  });
});
