/**
 * 用户产品决定（"不用那么复杂呀，你直接初始化不就好了？开启后直接帮忙
 * 初始化？"）：`startOpaqueCompactRuntime()` 里 `allowCreate` 从
 * `firstInit && allowKeyringBootstrap === true` 简化成 `firstInit`，
 * `allowKeyringBootstrap` 这道生产从来读不到的第二个开关整体删除。
 *
 * 这不是削弱 `9b2763a` 的安全加固，是把它的意图重新对齐：那次真正要挡的
 * 是"有任何已存在 state 时悄悄用新 key 顶替"，而这正是 `firstInit`
 * 单独就能保证的事——sentinel 严格两阶段提交（`lock→sentinel→keyring→DB`），
 * `firstInit=true` 时 DB 这一步在时间线上根本还没发生过，不可能有依赖
 * 这把 key 的密文已经落盘。"用户在 Dashboard 里主动打开一个默认关闭的
 * 实验开关"本身就是一次刻意的人工操作，闸门的意图被满足了，只是按钮从
 * 命令行换到了开关上。
 *
 * 桌面版（.dmg 不打包 `scripts/`、没有终端、没有 npm）这次不再是"看得见
 * 开关但打开就 409、且无法自救"——这条测试锁的正是这件事真的成立。
 *
 * 这里验证两件事，且两件事必须同时成立、互不削弱：
 *   1. `firstInit=true`（真正全新部署）：自动创建 keyring，不需要任何
 *      人工步骤，文件真实落盘、权限正确、下次启动能复用同一把钥匙。
 *   2. `firstInit=false`（真有既有 state，密钥却丢了）：**硬约束，逐字
 *      不能变**——继续 fail-closed，报警文案保留，不会因为这次简化而
 *      被自动创建顶替。这是这次改动唯一不允许触碰的边界。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
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
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-autoinit-data-"));
  dir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-autoinit-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-keyring-autoinit-keys-"));
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

describe("开启开关时自动初始化 keyring（firstInit 单独就是完整的安全闸门）", () => {
  it("firstInit=true（真正全新部署，无 sentinel）：不需要任何人工步骤，keyring 自动创建、权限正确、ready", async () => {
    const { startOpaqueCompactRuntime } = await import("@src/routes/shared/opaque-compact-runtime.js");

    const keyringFile = resolve(keyDir, "keyring.json");
    expect(existsSync(keyringFile)).toBe(false);

    const result = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile,
      // 刻意不传任何"允许创建"的开关——这正是这次要验证的事：不需要它。
    });

    expect(result.ready).toBe(true);
    expect(result.reason).toBeNull();
    expect(existsSync(keyringFile)).toBe(true);
    // 属主/权限校验（assertKeyringFileSafe 在下次加载时会强制检查）：
    // 0600，不比这更宽松。
    const stats = statSync(keyringFile);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("自动创建之后重启：加载的是同一把钥匙，不是每次重新生成一把新的", async () => {
    const { startOpaqueCompactRuntime, forgetOpaqueCompactRuntimeForTesting } = await import(
      "@src/routes/shared/opaque-compact-runtime.js"
    );
    const keyringFile = resolve(keyDir, "keyring.json");
    const config = {
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile,
    };

    const first = startOpaqueCompactRuntime(config);
    expect(first.ready).toBe(true);
    first.close();
    forgetOpaqueCompactRuntimeForTesting();

    const contentAfterFirstBoot = statSync(keyringFile).mtimeMs;

    // 第二次启动：此时 sentinel 已经 ready（firstInit=false），
    // 但 keyring 文件本身还在——应该直接加载，不触碰创建分支。
    const second = startOpaqueCompactRuntime(config);
    expect(second.ready).toBe(true);
    // 文件没有被重写——mtime 不变，证明走的是加载分支不是重新创建。
    expect(statSync(keyringFile).mtimeMs).toBe(contentAfterFirstBoot);
    second.close();
  });

  it("★ 硬约束不得削弱：firstInit=false（真有既有 state）+ keyring 真的丢了 → 仍然 fail-closed，不会自动创建顶替", async () => {
    const { startOpaqueCompactRuntime, forgetOpaqueCompactRuntimeForTesting } = await import(
      "@src/routes/shared/opaque-compact-runtime.js"
    );
    const { getOpaqueCompactStateReadiness } = await import("@src/routes/shared/opaque-compact-state.js");
    const keyringFile = resolve(keyDir, "keyring.json");
    const config = {
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 64 * 1024 * 1024,
      directory: dir,
      keyringFile,
    };

    // 先真实走一遍完整初始化，让 sentinel 提交成 ready、keyring 真实落盘——
    // 这样下面"真有既有 state"这句话不是编的，是真的发生过一次完整初始化。
    const first = startOpaqueCompactRuntime(config);
    expect(first.ready).toBe(true);
    first.close();
    forgetOpaqueCompactRuntimeForTesting();

    // 模拟"keyring 丢了"：真实删除文件，sentinel/DB 原封不动。
    rmSync(keyringFile, { force: true });

    const second = startOpaqueCompactRuntime(config);

    // 决定性断言：不会因为这次简化就自动创建一把新钥匙顶替丢失的那把——
    // 那会让所有已加密的既有 state 永久报废，这是这次改动唯一不允许
    // 触碰的边界。
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("key_unavailable");
    expect(existsSync(keyringFile)).toBe(false);

    const detail = getOpaqueCompactStateReadiness().detail ?? "";
    expect(detail).toContain("persisted state exists");
  });
});
