import { test, expect } from "vitest";
import { _electron } from "playwright";
import { resolve } from "path";
import { readdirSync } from "fs";

// Increase timeout for the launch test
test("Electron app packages and launches main window", async () => {
  // Find the linux unpacked directory
  const unpackedDir = resolve(import.meta.dirname, "../../release/linux-unpacked");

  // Find the actual executable dynamically
  const files = readdirSync(unpackedDir);
  const executableName = files.find(file => {
    return !file.includes(".") && !["locales", "resources"].includes(file) && !file.includes("chrome-sandbox") && !file.includes("chrome_crashpad_handler");
  });

  if (!executableName) {
    throw new Error("Could not find executable in linux-unpacked directory");
  }

  const executablePath = resolve(unpackedDir, executableName);

  // Launch the app
  const electronApp = await _electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  // Verify app launched correctly by waiting for the first window
  const window = await electronApp.firstWindow();

  // Verify it exists (it resolves to a Playwright Page object)
  expect(window).toBeDefined();

  // Wait for it to be ready
  await window.waitForLoadState("domcontentloaded");

  // Get window title to verify it loaded our app
  const title = await window.title();
  expect(title).toBe("Codex Proxy Developer Dashboard");

  // Close cleanly
  await electronApp.close();
}, 60000);
