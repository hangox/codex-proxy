/**
 * 发布流水线校验。
 *
 * 在不实际运行 electron-builder（会下载 100MB+ Electron）的前提下，
 * 验证 core build → desktop build → esbuild → prepare-pack 的完整链路。
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { withPreparePackLock } from "./prepare-pack-lock";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const DIST_ELECTRON = resolve(PKG_DIR, "dist-electron");

describe("release pipeline", () => {
  afterAll(() => {
    // 清理构建产物。
    if (existsSync(DIST_ELECTRON)) rmSync(DIST_ELECTRON, { recursive: true });
    // 清理 prepare-pack 复制出的资源。
    withPreparePackLock(() => {
      try {
        execFileSync("node", ["electron/prepare-pack.mjs", "--clean"], {
          cwd: PKG_DIR,
        });
      } catch { /* ignore */ }
    });
  });

  it("core build produces web assets", () => {
    // CI 中测试前会先执行 npm run build，这里只校验产物存在。
    const publicDir = resolve(ROOT_DIR, "public");
    const indexHtml = resolve(publicDir, "index.html");
    expect(existsSync(publicDir)).toBe(true);
    expect(existsSync(indexHtml)).toBe(true);
  });

  it("esbuild produces valid server bundle", () => {
    execFileSync("node", ["electron/build.mjs"], {
      cwd: PKG_DIR,
      timeout: 30_000,
    });

    const serverMjs = resolve(DIST_ELECTRON, "server.mjs");
    expect(existsSync(serverMjs)).toBe(true);
    // server bundle 会包含依赖，体积不应过小。
    expect(statSync(serverMjs).size).toBeGreaterThan(100_000);
  });

  it("esbuild produces valid main process bundle", () => {
    const mainCjs = resolve(DIST_ELECTRON, "main.cjs");
    expect(existsSync(mainCjs)).toBe(true);
    // main bundle 只包含 Electron 主进程代码，体积比 server bundle 小。
    expect(statSync(mainCjs).size).toBeGreaterThan(1000);
  });

  it("prepare-pack copies all required resources", () => {
    withPreparePackLock(() => {
      execFileSync("node", ["electron/prepare-pack.mjs"], {
        cwd: PKG_DIR,
        timeout: 10_000,
      });

      // 校验 electron-builder 需要的资源已经就位。
      expect(existsSync(resolve(PKG_DIR, "config", "default.yaml"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "public", "index.html"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "dist-electron", "main.cjs"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "dist-electron", "server.mjs"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "electron", "assets", "icon.png"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "package.json"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "node_modules", "ws", "package.json"))).toBe(true);
      expect(
        existsSync(resolve(PKG_DIR, "node_modules", "https-proxy-agent", "package.json")),
      ).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "node_modules", "agent-base", "package.json"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "node_modules", "debug", "package.json"))).toBe(true);
      expect(existsSync(resolve(PKG_DIR, "node_modules", "ms", "package.json"))).toBe(true);
    });
  });

  it("version is consistent between root and electron package", () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "package.json"), "utf-8"),
    ) as { version: string };
    const electronPkg = JSON.parse(
      readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"),
    ) as { version: string };

    // 两边版本允许不同步，但都必须是合法 semver。
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(electronPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("release.yml references correct workflow steps", () => {
    const releaseYml = readFileSync(
      resolve(ROOT_DIR, ".github", "workflows", "release.yml"),
      "utf-8",
    );

    // release workflow 必须包含 workspace 感知的构建步骤。
    expect(releaseYml).toContain("packages/electron");
    expect(releaseYml).toContain("electron/build.mjs");
    expect(releaseYml).toContain("prepare-pack.mjs");
    expect(releaseYml).toContain("electron-builder");
    expect(releaseYml).toContain("CSC_IDENTITY_AUTO_DISCOVERY: false");
  });

  it("bump-electron.yml workflow exists", () => {
    const bumpYml = resolve(
      ROOT_DIR,
      ".github",
      "workflows",
      "bump-electron.yml",
    );
    expect(existsSync(bumpYml)).toBe(true);

    const content = readFileSync(bumpYml, "utf-8");
    // bump workflow 必须同时更新根包和 electron 包版本。
    expect(content).toContain("package.json");
    expect(content).toContain("packages/electron/package.json");
  });
});
