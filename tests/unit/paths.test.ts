/**
 * Tests for centralized path management (src/paths.ts).
 * Uses vi.resetModules() + dynamic imports to isolate module state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "path";

// Each test re-imports the module to get a fresh _paths = null state
async function importPaths() {
  const mod = await import("@src/paths.js");
  return mod;
}

describe("paths — CLI mode (default)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("getRootDir returns process.cwd() by default", async () => {
    const { getRootDir } = await importPaths();
    expect(getRootDir()).toBe(process.cwd());
  });

  it("getConfigDir returns cwd/config by default", async () => {
    const { getConfigDir } = await importPaths();
    expect(getConfigDir()).toBe(resolve(process.cwd(), "config"));
  });

  it("getDataDir returns cwd/data by default", async () => {
    const { getDataDir } = await importPaths();
    expect(getDataDir()).toBe(resolve(process.cwd(), "data"));
  });

  it("getDefaultOpaqueCompactKeyringFile is a sibling of data/, not nested inside it (cwd/opaque-keys/keyring.json)", async () => {
    const { getDefaultOpaqueCompactKeyringFile, getDataDir } = await importPaths();
    const keyringFile = getDefaultOpaqueCompactKeyringFile();
    expect(keyringFile).toBe(resolve(process.cwd(), "opaque-keys", "keyring.json"));
    // 决定性断言：不是 data 目录的子路径——这正是 config-schema.ts 那条
    // "keyring_file 必须在 data 目录之外" 校验要求的关系。
    expect(keyringFile.startsWith(`${getDataDir()}/`)).toBe(false);
  });

  it("getBinDir returns cwd/bin by default", async () => {
    const { getBinDir } = await importPaths();
    expect(getBinDir()).toBe(resolve(process.cwd(), "bin"));
  });

  it("getPublicDir returns cwd/public by default", async () => {
    const { getPublicDir } = await importPaths();
    expect(getPublicDir()).toBe(resolve(process.cwd(), "public"));
  });

  it("isEmbedded returns false by default", async () => {
    const { isEmbedded } = await importPaths();
    expect(isEmbedded()).toBe(false);
  });
});

describe("paths — Electron mode (setPaths)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("setPaths overrides all path getters", async () => {
    const { setPaths, getRootDir, getConfigDir, getDataDir, getBinDir, getPublicDir } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/resources/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(getRootDir()).toBe("/app");
    expect(getConfigDir()).toBe("/app/resources/config");
    expect(getDataDir()).toBe("/app/data");
    expect(getBinDir()).toBe("/app/bin");
    expect(getPublicDir()).toBe("/app/public");
  });

  it("isEmbedded returns true after setPaths", async () => {
    const { setPaths, isEmbedded } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(isEmbedded()).toBe(true);
  });

  it("getDefaultOpaqueCompactKeyringFile follows setPaths()'s dataDir, not the CLI default — same formula covers Electron without a platform-specific branch", async () => {
    const { setPaths, getDefaultOpaqueCompactKeyringFile } = await importPaths();
    // 真实验证过（启动打包好的 .app、ps 看实际 --user-data-dir）：桌面版的
    // dataDir 是 <userData>/data，userData 实际解出来是
    // ~/Library/Application Support/@codex-proxy/electron（npm 包名，
    // 不是 electron-builder.yml 的 productName "Codex Proxy"——这个落差
    // 记录进了 CHANGELOG，这里用真实验证过的那个值做测试输入）。
    const userData = "/Users/example/Library/Application Support/@codex-proxy/electron";
    setPaths({
      rootDir: "/app",
      configDir: resolve(userData, "config"),
      dataDir: resolve(userData, "data"),
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(getDefaultOpaqueCompactKeyringFile()).toBe(
      resolve(userData, "opaque-keys", "keyring.json"),
    );
  });

});
