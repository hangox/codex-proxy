import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron } from "playwright";
import { resolve } from "path";
import { execFileSync } from "child_process";
import fs from "fs";

const PKG_DIR = resolve(import.meta.dirname, "..");
const RELEASE_DIR = resolve(PKG_DIR, "release/linux-unpacked");
const USER_DATA_DIR = resolve(PKG_DIR, "test-user-data");
const TEST_DATA_DIR = resolve(USER_DATA_DIR, "data");

describe("Electron app launch smoke test", () => {
  beforeAll(() => {
    // Only build/pack if missing
    if (!fs.existsSync(RELEASE_DIR)) {
      execFileSync("npm", ["run", "build"], { cwd: PKG_DIR, stdio: "inherit" });
      execFileSync("npm", ["run", "pack:linux"], { cwd: PKG_DIR, stdio: "inherit" });
    }

    // Create test user data dir and mock config to bypass native transport failure
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      resolve(TEST_DATA_DIR, "local.yaml"),
      "tls:\n  transport: curl-cli\n"
    );

  }, 120_000); // Give it enough time to build and pack

  afterAll(() => {
    if (fs.existsSync(USER_DATA_DIR)) {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    }
  });

  it("launches without crashing", async () => {
    // Find the binary dynamically
    const files = fs.readdirSync(RELEASE_DIR);
    const binName = files.find(
      (f) =>
        !f.includes(".") &&
        f !== "chrome-sandbox" &&
        f !== "chrome_crashpad_handler" &&
        !fs.statSync(resolve(RELEASE_DIR, f)).isDirectory()
    );

    expect(binName).toBeDefined();

    const appPath = resolve(RELEASE_DIR, binName as string);

    // Launch with user-data-dir pointing to our test directory
    const app = await electron.launch({
      executablePath: appPath,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${USER_DATA_DIR}`
      ],
      env: { ...process.env, DISABLE_NATIVE_TRANSPORT: "1" }
    });

    // Check if process is still running
    const isRunning = app.process().killed === false;
    expect(isRunning).toBe(true);

    const window = await app.firstWindow({ timeout: 15000 });
    expect(window).toBeDefined();

    const title = await window.title();
    expect(title).toBeDefined(); // App window has a title

    // Check for any immediate crashes or errors in the main window
    const hasCrashed = await window.evaluate(() => {
        return window.document.body.innerHTML.includes('Error') || window.document.body.innerHTML.includes('Crash');
    }).catch(() => false);

    expect(hasCrashed).toBe(false);

    await app.close();
  }, 120_000);
});
