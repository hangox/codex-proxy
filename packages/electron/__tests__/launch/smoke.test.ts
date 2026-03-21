import { _electron } from "playwright";
import { test, expect } from "vitest";
import { resolve } from "path";
import { stat } from "fs/promises";

test("Electron app packages and launches", async () => {
  // Path to the electron binary built by electron-builder in dir mode
  const binaryPath = resolve(
    import.meta.dirname,
    "../../release/linux-unpacked/@codex-proxyelectron"
  );

  // Verify binary exists
  const stats = await stat(binaryPath).catch(() => null);
  expect(stats).toBeDefined();

  // Launch the packaged electron app using Playwright
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | null = null;
  try {
    electronApp = await _electron.launch({
      executablePath: binaryPath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    const isReady = await electronApp.evaluate(async ({ app }) => {
      return app.isReady();
    });
    expect(isReady).toBe(true);

    const window = await electronApp.firstWindow();
    expect(window).toBeDefined();

    // Check if the title is set properly
    const title = await window.title();
    expect(title).toContain("Codex Proxy");

  } finally {
    if (electronApp) {
      await electronApp.close();
    }
  }
}, 30000);
