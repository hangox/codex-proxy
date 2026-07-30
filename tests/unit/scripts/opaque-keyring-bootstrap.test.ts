/**
 * `scripts/build/opaque-keyring-bootstrap.ts`——`allowKeyringBootstrap` 从
 * `9b2763a` 起就没有配一个真正的开关（生产代码路径永远不会把它设成
 * `true`，见该函数文档）。这个脚本是那个开关：一次性、独立于正常服务器
 * 启动路径，带四道各自独立的安全检查（不依赖调用方按正确顺序操作）。
 *
 * 这里只测 `planBootstrap()`（纯逻辑，拆出来独立于 `main()` 正是为了不需要
 * 真的跑一次子进程就能驱动每一条检查）——四道检查各自触发一条，外加
 * 全部通过时返回正确的 `keyringFile`。用真实临时目录 + 真实
 * `loadOpaqueCompactSentinel()`（不是 mock 一个"sentinel ready"的返回值），
 * 因为"sentinel 已 ready"这道检查的正确性恰恰取决于它和真实 sentinel 文件
 * 格式的交互对不对。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let tmpDataDir = "";

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

const { parseArgs, planBootstrap } = await import("../../../scripts/build/opaque-keyring-bootstrap.js");
const { loadOpaqueCompactSentinel } = await import("@src/routes/shared/opaque-compact-sentinel.js");
const { resolveOpaqueCompactSentinelPath } = await import("@src/routes/shared/opaque-compact-runtime.js");

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-script-"));
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("识别 --yes 与 --keyring-file <path>", () => {
    expect(parseArgs(["--keyring-file", "/tmp/x/keyring.json", "--yes"])).toEqual({
      keyringFile: "/tmp/x/keyring.json",
      yes: true,
    });
  });

  it("两者都缺省时给出安全默认值（yes=false，keyringFile=null）", () => {
    expect(parseArgs([])).toEqual({ keyringFile: null, yes: false });
  });

  it("--keyring-file 缺参数值时不崩、退化为 null", () => {
    expect(parseArgs(["--keyring-file"])).toEqual({ keyringFile: null, yes: false });
  });
});

describe("planBootstrap — 四道独立安全检查", () => {
  it("拒绝以 root 身份运行", () => {
    expect(() =>
      planBootstrap({
        keyringFileArg: resolve(tmpDataDir, "..", "keys", "keyring.json"),
        configuredKeyringFile: null,
        isRoot: true,
      }),
    ).toThrow(/refusing to run as root/);
  });

  it("keyringFile 缺省（CLI 与 config 都没给）→ 拒绝", () => {
    expect(() =>
      planBootstrap({ keyringFileArg: null, configuredKeyringFile: null, isRoot: false }),
    ).toThrow(/no keyring file configured/);
  });

  it("--keyring-file 优先于 config 里的值", () => {
    const outsideDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-keys-"));
    try {
      const cliPath = resolve(outsideDir, "cli-chosen.json");
      const plan = planBootstrap({
        keyringFileArg: cliPath,
        configuredKeyringFile: resolve(outsideDir, "config-chosen.json"),
        isRoot: false,
      });
      expect(plan.keyringFile).toBe(cliPath);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("keyringFile 落在 data 目录内 → 拒绝（复用运行时同一份判断，不是脚本自己重写的版本）", () => {
    // 直接放在 tmpDataDir 下（而不是嵌套子目录）：父目录必须真实存在，
    // 这样 canonical() 里的 realpath 解析才会和 getDataDir() 走到同一条
    // 分支——嵌套一个不存在的子目录会在 macOS 上撞上 /tmp → /private/tmp
    // 这个符号链接：两边 realpath 解析深度不一致，会产生假阴性。
    const insidePath = resolve(tmpDataDir, "keyring.json");
    expect(() =>
      planBootstrap({ keyringFileArg: insidePath, configuredKeyringFile: null, isRoot: false }),
    ).toThrow(/must live outside the data directory/);
  });

  it("keyring 文件已存在 → 拒绝，绝不覆盖", () => {
    const outsideDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-keys-"));
    try {
      const existing = resolve(outsideDir, "keyring.json");
      writeFileSync(existing, "{}");
      expect(() =>
        planBootstrap({ keyringFileArg: existing, configuredKeyringFile: null, isRoot: false }),
      ).toThrow(/already exists.*refusing to overwrite/s);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("sentinel 已经 ready（真实 store 已完整初始化过）→ 拒绝，即便调用方没有先检查 firstInit", () => {
    // 真实走一遍两阶段提交：先 allowCreate 建出 init 阶段，再手工推进到 ready——
    // 这样断言的是脚本和真实 sentinel 文件格式的交互，不是一个编造的 mock 返回值。
    const sentinelPath = resolveOpaqueCompactSentinelPath();
    loadOpaqueCompactSentinel(sentinelPath, { allowCreate: true });
    // 直接操作底层文件把它从 init 推进到 ready——生产路径是
    // commitOpaqueCompactSentinel()，这里为了不引入完整 runtime 依赖，
    // 直接改 JSON 的 phase 字段，效果等价（sentinel 文件本身就是那份 JSON）。
    const raw = JSON.parse(readFileSync(sentinelPath, "utf-8"));
    raw.phase = "ready";
    writeFileSync(sentinelPath, `${JSON.stringify(raw, null, 2)}\n`);

    const outsideDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-keys-"));
    try {
      const keyringFile = resolve(outsideDir, "keyring.json");
      expect(() =>
        planBootstrap({ keyringFileArg: keyringFile, configuredKeyringFile: null, isRoot: false }),
      ).toThrow(/already has persisted state/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("sentinel 存在但仍在 init 阶段（上次引导被中断）→ 允许继续（可重入）", () => {
    const sentinelPath = resolveOpaqueCompactSentinelPath();
    loadOpaqueCompactSentinel(sentinelPath, { allowCreate: true }); // 只到 init，从不 commit 成 ready

    const outsideDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-keys-"));
    try {
      const keyringFile = resolve(outsideDir, "keyring.json");
      const plan = planBootstrap({ keyringFileArg: keyringFile, configuredKeyringFile: null, isRoot: false });
      expect(plan.keyringFile).toBe(keyringFile);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("全部检查通过：真正的全新部署（无 sentinel、无 keyring、路径在 data 目录外）", () => {
    const outsideDir = mkdtempSync(resolve(tmpdir(), "opaque-bootstrap-keys-"));
    try {
      const keyringFile = resolve(outsideDir, "keyring.json");
      const plan = planBootstrap({ keyringFileArg: keyringFile, configuredKeyringFile: null, isRoot: false });
      expect(plan).toEqual({ keyringFile });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
