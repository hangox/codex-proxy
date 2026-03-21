import { execSync } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { _electron as electron } from "playwright";
import fs from "fs";
import path from "path";

describe("Electron App Smoke Test", () => {
  beforeAll(() => {
    // We only need to test Linux since we're on a Linux runner in CI,
    // and this matches the "test: verify Electron app packages and launches"
    console.log("Building the desktop frontend and bundling Electron...");
    execSync("cd packages/electron && npm run build", { stdio: "pipe" });

    console.log("Preparing pack resources...");
    execSync("cd packages/electron && node electron/prepare-pack.mjs", { stdio: "pipe" });

    console.log("Packaging the Electron app for Linux (dir mode)...");
    // Use --dir to avoid actually creating a zip/AppImage, just get the unpacked binary
    try {
      // Memory: electron-builder might fail if we don't have GH_TOKEN or similar env variable,
      // but it shouldn't for a dir build. However, in sandbox, sometimes stdout pipes break with npx.
      // We pass publish never just in case.
      execSync("cd packages/electron && npx electron-builder --linux --dir -c.compression=store -c.publish=null", {
        stdio: "ignore",
        env: {
          ...process.env,
          GH_TOKEN: "", // prevent github publish attempts
        }
      });
    } catch (e: any) {
      console.warn("electron-builder failed with publish null, trying without publish");
      try {
        execSync("cd packages/electron && npx electron-builder --linux --dir -c.compression=store", {
          stdio: "pipe",
        });
      } catch (e2: any) {
        console.error("electron-builder failed completely");
        console.error(e2.stdout?.toString());
        console.error(e2.stderr?.toString());
        throw e2;
      }
    }
  }, 300000); // 5 minutes timeout for building and packaging

  it("should launch the built Electron app successfully", async () => {
    // Find the unpacked executable
    const distDir = path.resolve(__dirname, "../../packages/electron/release/linux-unpacked");
    const executablePath = path.join(distDir, "@codex-proxyelectron");

    expect(fs.existsSync(executablePath)).toBe(true);

    console.log("Launching Electron app via Playwright...");

    // In some restricted environments like Docker, electron/playwright can hang.
    // We can also verify by launching the binary directly using child_process and checking if it exits or starts.
    // Let's use Playwright but with more robust arguments for headless Linux.
    const electronApp = await electron.launch({
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-software-rasterizer"
      ],
      timeout: 15000 // fail fast instead of waiting 60s if Playwright hangs
    });

    const window = await electronApp.firstWindow();

    expect(window).toBeTruthy();

    const title = await window.title();
    expect(typeof title).toBe("string");

    await electronApp.close();
  }, 60000);
});
