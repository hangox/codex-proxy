/**
 * `startOpaqueCompactRuntime()` 的 keyring 缺失分支此前统一用一句
 * "opaque compact keyring is missing while persisted state exists"，但这句
 * 话只在真的存在既有 state（`firstInit=false`，sentinel 已 ready，密钥
 * 确实丢了）时才准确。`9b2763a` 之后 `allowKeyringBootstrap` 在生产代码
 * 路径上永远不可达（见 `scripts/build/opaque-keyring-bootstrap.ts` 的
 * 文档），所以"从未引导过"（`firstInit=true`）这条路径每次都会命中同一句
 * 误导性文案——它会把运维导向"数据损坏"，而实际情况是"什么都还没有，
 * 只是不允许自动创建"。
 *
 * 这里验证两种情形拿到的是不同的、各自准确的文案，且没有互相污染：
 *   1. 真正从未引导过（无 sentinel）→ 新文案，指向 bootstrap 脚本，不提
 *      "persisted state"。
 *   2. 真的丢了 keyring 但既有 state 还在（sentinel 已 ready）→ 保留原始
 *      的报警文案，这条真正危险的路径不能被这次改动削弱。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-msg-data-"));
  dir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-msg-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-msg-keys-"));
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

describe("keyring 缺失时的错误文案——firstInit 区分「从未引导」与「真的丢了」", () => {
  it("从未引导过（无 sentinel，allowKeyringBootstrap 未开）：新文案指向 bootstrap 脚本，不提 persisted state", async () => {
    const { startOpaqueCompactRuntime } = await import("@src/routes/shared/opaque-compact-runtime.js");
    const { getOpaqueCompactStateReadiness } = await import("@src/routes/shared/opaque-compact-state.js");

    const result = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
      // 刻意不传 allowKeyringBootstrap——生产代码路径本来就永远不会传它。
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("key_unavailable");

    const detail = getOpaqueCompactStateReadiness().detail ?? "";
    expect(detail).toContain("opaque:bootstrap-keyring");
    expect(detail).toContain("never been created");
    expect(detail).not.toContain("persisted state exists");
  });

  it("真的丢了 keyring 但既有 state 还在（sentinel 已 ready）：保留原始报警文案", async () => {
    const { startOpaqueCompactRuntime, forgetOpaqueCompactRuntimeForTesting } = await import(
      "@src/routes/shared/opaque-compact-runtime.js"
    );
    const { getOpaqueCompactStateReadiness } = await import("@src/routes/shared/opaque-compact-state.js");

    const config = {
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
      allowKeyringBootstrap: true,
    };

    // 先真实走一遍完整初始化，让 sentinel 提交成 ready、keyring 真实落盘。
    const first = startOpaqueCompactRuntime(config);
    expect(first.ready).toBe(true);
    first.close();
    forgetOpaqueCompactRuntimeForTesting();

    // 模拟"keyring 丢了"：真实删除文件，sentinel/DB 原封不动。
    rmSync(resolve(keyDir, "keyring.json"), { force: true });

    // 第二次启动：不再传 allowKeyringBootstrap（模拟真实生产路径），
    // 且此时 sentinel 已经 ready，firstInit=false。
    const second = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile: resolve(keyDir, "keyring.json"),
    });

    expect(second.ready).toBe(false);
    expect(second.reason).toBe("key_unavailable");

    const detail = getOpaqueCompactStateReadiness().detail ?? "";
    expect(detail).toContain("persisted state exists");
    expect(detail).not.toContain("opaque:bootstrap-keyring");
  });
});
