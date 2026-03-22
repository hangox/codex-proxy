/**
 * Smoke test for Electron app launch.
 * Verifies that the packaged application launches successfully
 * and the main window is created.
 *
 * Designed to be run in CI, isolated from unit tests.
 */

import { _electron } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");

async function run() {
  console.log("[Launch Test] Building root resources...");
  execFileSync("npm", ["run", "build"], { cwd: ROOT_DIR, stdio: "inherit" });

  console.log("[Launch Test] Building desktop frontend...");
  execFileSync("npx", ["vite", "build"], { cwd: resolve(PKG_DIR, "desktop"), stdio: "inherit" });

  console.log("[Launch Test] Bundling electron code...");
  execFileSync("node", ["electron/build.mjs"], { cwd: PKG_DIR, stdio: "inherit" });

  console.log("[Launch Test] Preparing pack resources...");
  execFileSync("node", ["electron/prepare-pack.mjs"], { cwd: PKG_DIR, stdio: "inherit" });

  console.log("[Launch Test] Launching Electron app...");
  const electronApp = await _electron.launch({
    args: [".", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    cwd: PKG_DIR,
  });

  try {
    const window = await electronApp.firstWindow();
    if (!window) throw new Error("Main window did not open");

    const title = await window.title();
    if (!title.includes("Codex Proxy")) {
      throw new Error(`Unexpected window title: ${title}`);
    }

    await window.waitForLoadState("domcontentloaded");
    console.log("[Launch Test] Success! Window opened properly.");
  } finally {
    await electronApp.close();
    try {
      execFileSync("node", ["electron/prepare-pack.mjs", "--clean"], { cwd: PKG_DIR });
    } catch { /* ignore */ }
  }
}

run().catch((err) => {
  console.error("[Launch Test] Failed:", err);
  process.exit(1);
});
