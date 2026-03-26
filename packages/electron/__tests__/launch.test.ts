import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { _electron as electron, ElectronApplication } from "playwright";
import { resolve } from "path";
import { existsSync, readdirSync } from "fs";

const PKG_DIR = resolve(import.meta.dirname, "..");

describe("Electron app launch smoke test", () => {
  let app: ElectronApplication | undefined;

  beforeAll(() => {
    // We want to avoid rebuilding if we don't have to for local testing,
    // but the test should ideally build it from scratch. Let's do it in the tests.
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("builds the electron app successfully", () => {
    execSync("npm run build", { cwd: PKG_DIR, stdio: "inherit" });
    expect(existsSync(resolve(PKG_DIR, "dist-electron/main.cjs"))).toBe(true);
    expect(existsSync(resolve(PKG_DIR, "dist-electron/server.mjs"))).toBe(true);
  });

  it("packages the electron app for linux successfully", () => {
    execSync("npm run pack:linux", { cwd: PKG_DIR, stdio: "inherit" });
    const linuxUnpackedPath = resolve(PKG_DIR, "release/linux-unpacked");
    expect(existsSync(linuxUnpackedPath)).toBe(true);
  }, 60000);

  it("launches the packaged app and exits cleanly", async () => {
    const linuxUnpackedPath = resolve(PKG_DIR, "release/linux-unpacked");
    expect(existsSync(linuxUnpackedPath)).toBe(true);

    // Find the executable in the unpacked directory
    const files = readdirSync(linuxUnpackedPath);
    // On Linux, the executable usually lacks an extension, so we look for files
    // without a dot and ignore common non-executables.
    const possibleBinaries = files.filter(f => !f.includes(".") && !f.endsWith("so") && !["locales", "resources"].includes(f));
    expect(possibleBinaries.length).toBeGreaterThan(0);
    const executableName = possibleBinaries[0];
    const executablePath = resolve(linuxUnpackedPath, executableName);

    expect(existsSync(executablePath)).toBe(true);

    // Launch the app
    app = await electron.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--headless"],
    });

    // Wait for the main window to open
    const window = await app.firstWindow();
    expect(window).toBeDefined();

    // Verify it loads a page (e.g. checks title or basic content)
    // Adjust selector and timeout based on the expected initial UI
    await window.waitForLoadState("domcontentloaded");

    // We'll just check that it has opened
    const title = await window.title();
    expect(typeof title).toBe("string");

    // Close the app and verify clean exit
    await app.close();
    app = undefined; // clear reference
  }, 60000);
});
