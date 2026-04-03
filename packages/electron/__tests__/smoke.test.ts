import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron } from "playwright";
import { resolve } from "path";
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

// Only run in CI or when explicitly asked to run E2E smoke tests.
// Running this locally takes 1-2 mins and might mess with local dev configs.
const isE2E = process.env.CI || process.env.RUN_E2E_SMOKE;

describe.runIf(isE2E)("Electron App Smoke Test", () => {
  // Determine the unpack directory and executable based on platform
  const platform = process.platform;
  let unpackDir = "linux-unpacked";
  let executableName = "@codex-proxy/electron";

  if (platform === "win32") {
    unpackDir = "win-unpacked";
    executableName = "Codex Proxy.exe";
  } else if (platform === "darwin") {
    unpackDir = "mac";
    executableName = "Codex Proxy.app/Contents/MacOS/Codex Proxy";
  }

  const PKG_DIR = resolve(import.meta.dirname, "..");
  const releaseDir = resolve(PKG_DIR, "release", unpackDir);

  // Fallback logic for linux executable name
  if (platform === "linux" && !existsSync(resolve(releaseDir, executableName))) {
     if(existsSync(resolve(releaseDir, "codex-proxy"))) {
        executableName = "codex-proxy";
     } else if (existsSync(resolve(releaseDir, "@codex-proxyelectron"))) {
         executableName = "@codex-proxyelectron";
     }
  }

  const executablePath = resolve(releaseDir, executableName);

  let userDataDir: string;

  beforeAll(() => {
    // Create a temporary data dir to bypass native transport and avoid committing cache
    userDataDir = mkdtempSync(resolve(tmpdir(), "codex-proxy-test-"));
    const testDataDir = resolve(userDataDir, "data");

    if (!existsSync(testDataDir)) {
      mkdirSync(testDataDir, { recursive: true });
    }
    writeFileSync(
      resolve(testDataDir, "local.yaml"),
      "tls:\n  transport: curl-cli\n"
    );

    const npmCmd = platform === "win32" ? "npm.cmd" : "npm";
    const npxCmd = platform === "win32" ? "npx.cmd" : "npx";

    // Make sure it builds and packs
    execFileSync(npmCmd, ["run", "build"], { cwd: PKG_DIR, stdio: "inherit" });
    execFileSync(npmCmd, ["run", "prepack"], { cwd: PKG_DIR, stdio: "inherit" });

    // Pass --publish never and redirect stdio to avoid hanging/crashing in CI
    execFileSync(npxCmd, ["electron-builder", "--dir", "--config", "electron-builder.yml", "--publish", "never"], {
      cwd: PKG_DIR,
      stdio: "pipe"
    });
  }, 300000); // 5 mins timeout for slower CI

  afterAll(() => {
    // Clean up temporary user data dir
    if (userDataDir && existsSync(userDataDir)) {
        rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it("app builds and launches without crashing", async () => {
    // 1. Verify build exists
    expect(existsSync(executablePath)).toBe(true);

    // 2. Launch the app using Playwright
    const electronApp = await electron.launch({
      executablePath,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        DISABLE_NATIVE_TRANSPORT: "1",
      }
    });

    electronApp.on("console", (msg) => {
        console.log(`[electron-app] ${msg.type()}: ${msg.text()}`);
    });

    // 3. Wait for the app to be ready and first window to open
    // Electron's main process opens the window during the 'ready' event
    let window;
    try {
        window = await electronApp.firstWindow();
    } catch (e) {
        console.error("Timeout getting first window, getting all windows to check");
        const windows = electronApp.windows();
        console.log("Total windows:", windows.length);
        throw e;
    }

    expect(window).toBeTruthy();

    window.on("console", (msg) => {
        console.log(`[window-console] ${msg.type()}: ${msg.text()}`);
    });

    // 4. Verify title or some content to ensure it didn't just crash and stay open
    const title = await window.title();
    expect(title).toMatch(/^Codex Proxy/);

    // 5. Exit cleanly
    await electronApp.close();
  }, 60000); // Give it up to 60s
});