/**
 * Release pipeline validation.
 *
 * Verifies the full build chain works end-to-end without actually
 * running electron-builder (which downloads 100MB+ of Electron).
 * Tests the sequence: core build → desktop build → esbuild → prepare-pack.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { execFileSync } from "child_process";
import asar from "@electron/asar";
import { acquireElectronTestLock } from "./test-lock.js";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const DIST_ELECTRON = resolve(PKG_DIR, "dist-electron");
const PACKED_APP = resolve(PKG_DIR, "release", "mac-arm64", "Codex Proxy.app");
const APP_ASAR = resolve(PACKED_APP, "Contents", "Resources", "app.asar");
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

    const isolatedRoot = mkdtempSync(resolve(tmpdir(), "codex-proxy-packaged-health-"));
    const extracted = resolve(isolatedRoot, "app");
    const dataDir = resolve(isolatedRoot, "data");
    try {
      asar.extractAll(APP_ASAR, extracted);
      const resources = resolve(PACKED_APP, "Contents", "Resources");
      const script = `
        const { resolve } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const root = ${JSON.stringify(extracted)};
        const resources = ${JSON.stringify(resources)};
        const mod = await import(pathToFileURL(resolve(root, "dist-electron/server.mjs")).href);
        mod.setPaths({
          rootDir: root,
          configDir: resolve(resources, "app.asar.unpacked/config"),
          dataDir: ${JSON.stringify(dataDir)},
          binDir: resolve(resources, "bin"),
          publicDir: resolve(resources, "app.asar.unpacked/public"),
        });
        const handle = await mod.startServer({ host: "127.0.0.1", port: 0 });
        try {
          const response = await fetch("http://127.0.0.1:" + handle.port + "/health");
          const body = await response.json();
          if (!response.ok || body.status !== "ok") throw new Error(JSON.stringify(body));
          console.log("PACKAGED_HEALTH_OK:" + handle.port);
        } finally {
          await handle.close();
        }
      `;
      const stdout = execFileSync(
        "node",
        ["--input-type=module", "-e", script],
        {
          cwd: isolatedRoot,
          timeout: 30_000,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
        },
      );
      expect(stdout).toContain("PACKAGED_HEALTH_OK:");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }, 150_000);

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
