import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron } from "playwright";
import { resolve, join } from "path";
import { existsSync, mkdirSync, cpSync } from "fs";

const PKG_DIR = resolve(import.meta.dirname, "../..");
const ROOT_DIR = resolve(PKG_DIR, "../..");

describe("Electron App Smoke Test", () => {
  let electronApp: any;

  beforeAll(async () => {
    // Copy default config into packages/electron/config so it can be found
    if (!existsSync(join(PKG_DIR, "config"))) {
      mkdirSync(join(PKG_DIR, "config"));
    }
    cpSync(join(ROOT_DIR, "config"), join(PKG_DIR, "config"), { recursive: true });

    // Copy built public UI so window can load it
    if (existsSync(join(ROOT_DIR, "public"))) {
      if (!existsSync(join(PKG_DIR, "public"))) {
        mkdirSync(join(PKG_DIR, "public"));
      }
      cpSync(join(ROOT_DIR, "public"), join(PKG_DIR, "public"), { recursive: true });
    }

    electronApp = await electron.launch({
      cwd: PKG_DIR,
      args: ["."], // launches the app
      env: { ...process.env, CI: "true" }
    });
  }, 60000);

  afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  }, 30000);

  it("launches the app and opens the main window", async () => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Test the window title
    const title = await window.title();
    expect(title).toBe("Codex Proxy Developer Dashboard");
  }, 60000);
});
