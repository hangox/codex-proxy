/**
 * Release pipeline validation.
 *
 * Verifies the full build chain works end-to-end, including electron-builder
 * packaging and a real packaged-App cold start in an isolated user-data root.
 * Tests the sequence: core build → desktop build → esbuild → prepare-pack → App.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { execFileSync, spawn } from "child_process";
import { createServer } from "net";
import asar from "@electron/asar";
import { acquireElectronTestLock } from "./test-lock.js";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const DIST_ELECTRON = resolve(PKG_DIR, "dist-electron");
const PACKED_APP = resolve(PKG_DIR, "release", "mac-arm64", "Codex Proxy.app");
const APP_ASAR = resolve(PACKED_APP, "Contents", "Resources", "app.asar");
const APP_EXECUTABLE = resolve(PACKED_APP, "Contents", "MacOS", "Codex Proxy");
const RUNTIME_PACKAGES = [
  "ws",
  "https-proxy-agent",
  "socks-proxy-agent",
  "agent-base",
  "debug",
  "ms",
  "socks",
  "ip-address",
  "smart-buffer",
] as const;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配冷启动测试端口");
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

async function waitForPackagedAppStart(
  child: ReturnType<typeof spawn>,
  logPath: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    if (/Startup failed|ERR_MODULE_NOT_FOUND|Cannot find package/.test(log)) {
      throw new Error(`打包 App 启动失败：\n${log}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`打包 App 提前退出（${child.exitCode}）：\n${log}`);
    }
    if (log.includes(`[Electron] Server started on port ${port}`)) {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json() as { status?: string };
      if (response.ok && body.status === "ok") return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待打包 App health 超时：\n${log}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function stopPackagedApp(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 7_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
}

describe("release pipeline", () => {
  let releaseLock: (() => void) | null = null;

  beforeAll(async () => {
    releaseLock = await acquireElectronTestLock();
  }, 180_000);

  afterAll(() => {
    // Clean up build artifacts
    if (existsSync(DIST_ELECTRON)) rmSync(DIST_ELECTRON, { recursive: true });
    // Clean up prepare-pack copies
    try {
      execFileSync("node", ["electron/prepare-pack.mjs", "--clean"], {
        cwd: PKG_DIR,
      });
    } catch { /* ignore */ }
    releaseLock?.();
  });

  it("core build produces web assets", () => {
    // Core should already be built (npm run build runs in CI before tests)
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
    // Server bundle should be substantial (includes all deps)
    expect(statSync(serverMjs).size).toBeGreaterThan(100_000);
  });

  it("esbuild produces valid main process bundle", () => {
    const mainCjs = resolve(DIST_ELECTRON, "main.cjs");
    expect(existsSync(mainCjs)).toBe(true);
    // Main bundle is smaller (only Electron main process code)
    expect(statSync(mainCjs).size).toBeGreaterThan(1000);
  });

  it("prepare-pack copies all required resources", () => {
    execFileSync("node", ["electron/prepare-pack.mjs"], {
      cwd: PKG_DIR,
      timeout: 10_000,
    });

    // Verify all resources are in place for electron-builder
    expect(existsSync(resolve(PKG_DIR, "config", "default.yaml"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "public", "index.html"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "bin"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "dist-electron", "main.cjs"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "dist-electron", "server.mjs"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "electron", "assets", "icon.png"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "package.json"))).toBe(true);
  });

  it("packaged ASAR cold-starts without repository node_modules and serves health", async () => {
    execFileSync("node", ["electron/prepare-pack.mjs"], { cwd: PKG_DIR, timeout: 10_000 });
    execFileSync(
      "npx",
      ["electron-builder", "--config", "electron-builder.yml", "--dir", "--arm64"],
      { cwd: PKG_DIR, timeout: 120_000, stdio: "pipe" },
    );

    expect(existsSync(APP_ASAR)).toBe(true);
    const contents = asar.listPackage(APP_ASAR);
    for (const pkgName of RUNTIME_PACKAGES) {
      expect(contents, `app.asar 缺少运行时依赖 ${pkgName}`).toContain(
        `/node_modules/${pkgName}/package.json`,
      );
    }
    expect(contents).toContain(
      "/node_modules/socks-proxy-agent/node_modules/agent-base/package.json",
    );

    const isolatedRoot = mkdtempSync(resolve(tmpdir(), "codex-proxy-packaged-app-smoke-"));
    const userData = resolve(isolatedRoot, "user-data");
    const dataDir = resolve(userData, "data");
    const logPath = resolve(isolatedRoot, "app.log");
    mkdirSync(dataDir, { recursive: true });
    const port = await reservePort();
    writeFileSync(
      resolve(dataDir, "local.yaml"),
      `server:\n  host: 127.0.0.1\n  port: ${port}\n  proxy_api_key: null\nupdate:\n  auto_update: false\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    const logFd = openSync(logPath, "a");
    const child = spawn(
      APP_EXECUTABLE,
      [`--user-data-dir=${userData}`, "--disable-gpu"],
      {
        cwd: isolatedRoot,
        detached: false,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          CLAUDECODE: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
        },
      },
    );
    try {
      await waitForPackagedAppStart(child, logPath, port);
    } finally {
      await stopPackagedApp(child);
      closeSync(logFd);
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("version is consistent between root and electron package", () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "package.json"), "utf-8"),
    ) as { version: string };
    const electronPkg = JSON.parse(
      readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"),
    ) as { version: string };

    // Versions may diverge (electron can be ahead), but both must be valid semver
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(electronPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("release.yml references correct workflow steps", () => {
    const releaseYml = readFileSync(
      resolve(ROOT_DIR, ".github", "workflows", "release.yml"),
      "utf-8",
    );

    // Must include workspace-aware build steps
    expect(releaseYml).toContain("packages/electron");
    expect(releaseYml).toContain("electron/build.mjs");
    expect(releaseYml).toContain("prepare-pack.mjs");
    expect(releaseYml).toContain("electron-builder");
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
    // Must bump both root and electron package versions
    expect(content).toContain("package.json");
    expect(content).toContain("packages/electron/package.json");
  });
});
