/**
 * reviewer 复审 `7c807cc`（store_unavailable 生产事故的 detail 落日志修复）
 * 时数出的第三个 sink：`opaque-compact-runtime.ts` 里 `recover_unreadable`
 * 分支（冷启动全库 AEAD 校验发现不可读记录 → 整体 quarantine）此前只调用
 * `setOpaqueCompactStateUnavailable("state_corrupt")`（不带 detail），也没有
 * 调用新增的 `recordOpaqueCompactRuntimeFault`——`OpaqueCompactRuntimeFault`
 * 这个结构化事件因此只覆盖了两条路径（启动 `fail()` + 运行时
 * `reportOpaqueCompactStoreFault`），第三条真实存在的掉线路径完全不出现
 * 在里面。一个只覆盖 2/3 场景的"新信号"比没有信号更危险：以后有人盯着
 * 这个事件名找"store 什么时候掉线"，会被这一类漏掉，且不会意识到自己
 * 漏看了。
 *
 * 这里不重复测 quarantine 机制本身（隔离是否真的移动了文件、sentinel/marker
 * 语义等，不是这次要补的范围），只测这个分支补上的 detail/结构化日志
 * 契约：用真实的 bit-flip（不是 mock）让 `recover()` 真的发现一条不可读
 * 记录，断言 `getOpaqueCompactStateReadiness().detail` 与新增的
 * `OpaqueCompactRuntimeFault` 日志都带上了诊断信息，且内容只是计数/布尔值
 * （不含任何路径、密文、marker 原文）。
 *
 * 不需要子进程（不同于 `opaque-compact-fault-injection.test.ts` 那批真实
 * SIGKILL 用例）：`recover()` 只在冷启动时跑一次，直接在同一进程里
 * 关闭第一个 runtime、用 `node:sqlite` 直接改一个字节、再启动第二个
 * runtime 指向同一目录，就能真实触发这条路径。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let tmpDataDir = "";
let dir = "";
let keyDir = "";

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
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-quarantine-detail-data-"));
  dir = mkdtempSync(resolve(tmpdir(), "opaque-quarantine-detail-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-quarantine-detail-keys-"));
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
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

describe("opaque compact runtime — recover_unreadable quarantine 分支的 detail/结构化日志", () => {
  it("bit-flip 一条真实记录的 ciphertext 后冷启动：readiness.detail 与新增的 OpaqueCompactRuntimeFault 日志都带上诊断信息（计数/布尔值，无路径/密文/marker 原文）", async () => {
    const { startOpaqueCompactRuntime } = await import("@src/routes/shared/opaque-compact-runtime.js");
    const { getOpaqueCompactStateReadiness, getOpaqueCompactStateStore } = await import(
      "@src/routes/shared/opaque-compact-state.js"
    );

    const config = {
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
      allowKeyringBootstrap: true,
    };

    const first = startOpaqueCompactRuntime(config);
    expect(first.ready).toBe(true);

    // 种一条真实记录——真实 save()，不是手工拼字节，这样接下来 bit-flip
    // 破坏的是一段真实密文，而不是伪造的占位数据。
    const saved = getOpaqueCompactStateStore().save({
      output: [{ type: "reasoning", encrypted_content: "quarantine-detail-seed", summary: [] }],
      sessionId: "session-quarantine-detail",
      model: "codex",
      accountEntryId: "acct-quarantine-detail",
      compactInputDigest: "digest-quarantine-detail",
    });
    expect(saved.marker).toContain("codex-opaque-state:v1");
    first.close();

    // 真实 bit-flip：直接改 opaque_states 表里那一行的 ciphertext BLOB
    // 一个字节，长度不变（byte_size MAC 因此还能对上，真正暴露问题的是
    // AEAD 认证失败，即注释里"bit flip 在这里就会被抓到"那一步）。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array }
      | undefined;
    expect(row).toBeDefined();
    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, row!.lookup_digest);
    db.close();

    // 冷启动：recover() 对这条记录做 AEAD 认证，失败 → unreadable=1 →
    // quarantine 分支触发。
    const second = startOpaqueCompactRuntime(config);
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("state_corrupt");

    // 决定性断言 1：readiness 的 detail 不再是 undefined——此前这个分支
    // 调用 setOpaqueCompactStateUnavailable() 时压根没传 detail 参数。
    expect(getOpaqueCompactStateReadiness()).toEqual({
      ready: false,
      reason: "state_corrupt",
      detail: expect.stringContaining("unreadable=1"),
    });
    // detail 只含计数/布尔值，不含任何路径、密文、原始文件名。
    const readinessDetail = getOpaqueCompactStateReadiness().detail!;
    expect(readinessDetail).toContain("quarantine_ok=true");
    expect(readinessDetail).not.toContain(dir);
    expect(readinessDetail).not.toContain(keyDir);

    // 决定性断言 2：新增的 OpaqueCompactRuntimeFault 结构化日志真的被这条
    // 分支调用了——此前这里完全没有调用 recordOpaqueCompactRuntimeFault，
    // 是 reviewer 数出来的漏覆盖。
    const lines = readErrorLogLines();
    const runtimeFaultLines = lines.filter(
      (l) => (l.error as Record<string, unknown> | undefined)?.name === "OpaqueCompactRuntimeFault",
    );
    expect(runtimeFaultLines).toHaveLength(1);
    const entry = runtimeFaultLines[0]!;
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.reason).toBe("state_corrupt");
    expect(ctx.phase).toBe("startup");
    expect(typeof ctx.detail).toBe("string");
    expect((ctx.detail as string)).toContain("unreadable=1");
    expect((ctx.detail as string)).toContain("quarantine_ok=true");

    // 隐私护栏：整条落盘的原始文件不含临时目录路径、真实 marker、密文原文。
    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain(keyDir);
    expect(raw).not.toContain(saved.marker);

    second.close();
  });
});
