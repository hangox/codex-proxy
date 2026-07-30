/**
 * `recordOpaqueCompactRuntimeFault`——opaque compact runtime 转入 store 级
 * 致命故障时的结构化落盘（排查生产事故新补：单个会话 49 分钟内撞了 77 次
 * 同一个 `store_unavailable` 409，原始异常从未落进结构化日志，根因永久
 * 查不到）。
 *
 * 这里只测这个函数本身的白名单/脱敏契约，不重复
 * `opaque-compact-runtime.test.ts`（如果存在）里对 `fail()`/
 * `reportOpaqueCompactRuntimeFault()` 触发时机本身的覆盖。
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
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-runtime-fault-log-"));
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

const MARKER_TOKEN =
  `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;

describe("recordOpaqueCompactRuntimeFault", () => {
  it("落盘 phase/reason/detail，detail 原样保留（已脱敏但本身不含敏感内容时不变）", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    recordOpaqueCompactRuntimeFault({
      reason: "store_unavailable",
      detail: "OpaqueCompactRepositoryError: SQLITE_CORRUPT: database disk image is malformed",
      phase: "runtime",
    });

    const lines = readErrorLogLines();
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.source).toBe("server");
    const err = entry.error as Record<string, unknown>;
    expect(err.name).toBe("OpaqueCompactRuntimeFault");
    // 顶层 error.message 不过 redactJson，只放受控分类字符串（reason）。
    expect(err.message).toBe("store_unavailable");

    const ctx = entry.context as Record<string, unknown>;
    expect(Object.keys(ctx).sort()).toEqual(["detail", "phase", "reason"].sort());
    expect(ctx.phase).toBe("runtime");
    expect(ctx.reason).toBe("store_unavailable");
    expect(ctx.detail).toBe("OpaqueCompactRepositoryError: SQLITE_CORRUPT: database disk image is malformed");
  });

  it("phase 区分 startup 和 runtime", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    recordOpaqueCompactRuntimeFault({ reason: "key_unavailable", detail: "keyring file is not valid JSON", phase: "startup" });

    const lines = readErrorLogLines();
    expect((lines[0]!.context as Record<string, unknown>).phase).toBe("startup");
  });

  it("detail 缺省时是 null，不是省略键", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    recordOpaqueCompactRuntimeFault({ reason: "store_locked", phase: "startup" });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    expect(ctx.detail).toBeNull();
  });

  it("detail 里嵌的 opaque marker 不会原样落盘（经 sanitizeFreeTextForLog 脱敏）", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    recordOpaqueCompactRuntimeFault({
      reason: "state_corrupt",
      detail: `payload validation failed near ${MARKER_TOKEN} boundary`,
      phase: "runtime",
    });

    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(MARKER_TOKEN);
    expect(raw).not.toContain("A".repeat(32));
    expect(raw).toContain("codex-opaque-state:***");
  });

  it("超长 detail 被截断，不会把整段底层异常文本原样落盘", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    const longDetail = "z".repeat(5000);
    recordOpaqueCompactRuntimeFault({ reason: "store_unavailable", detail: longDetail, phase: "runtime" });

    const lines = readErrorLogLines();
    const ctx = lines[0]!.context as Record<string, unknown>;
    const stored = ctx.detail as string;
    expect(stored.length).toBeLessThan(longDetail.length);
    expect(stored).toContain("truncated");
  });

  it("落盘失败（写入抛错）不向调用方冒泡", async () => {
    const { recordOpaqueCompactRuntimeFault } = await import(
      "@src/routes/shared/opaque-compact-runtime-fault-log.js"
    );
    tmpDataDir = "/nonexistent-root-path-for-test/does-not-exist";
    expect(() =>
      recordOpaqueCompactRuntimeFault({ reason: "store_unavailable", detail: "boom", phase: "runtime" }),
    ).not.toThrow();
  });
});
