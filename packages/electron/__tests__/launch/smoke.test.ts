import { _electron as electron } from "playwright";
import { expect, test } from "vitest";
import { join } from "path";
import { readdirSync } from "fs";
import fs from "fs";

test("Smoke test: Electron app packages and launches", async () => {
  // Find the packaged linux executable in the release directory
  const releaseDir = join(import.meta.dirname, "..", "..", "release", "linux-unpacked");

  // Verify directory exists
  expect(fs.existsSync(releaseDir)).toBe(true);

  // Find binary dynamically (files with no extension, excluding certain ones)
  const files = readdirSync(releaseDir);
  const binaryName = files.find(f =>
    !f.includes(".") &&
    f !== "locales" &&
    f !== "resources" &&
    f !== "LICENSES.chromium.html" &&
    f !== "chrome-sandbox" &&
    f !== "chrome_crashpad_handler"
  );

  if (!binaryName) {
    throw new Error("Could not find executable binary in release/linux-unpacked/");
  }

  const executablePath = join(releaseDir, binaryName);

  // Launch the Electron app using playwright
  const electronApp = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    // Wait for the first window to appear
    const window = await electronApp.firstWindow();

    // Check if the window is defined
    expect(window).toBeDefined();

    // Optionally wait for the app to initialize its content
    await window.waitForLoadState("domcontentloaded");

    // Close window gracefully
    await electronApp.close();
  } catch (error) {
    await electronApp.close();
    throw error;
  }
}, 60000); // Increased timeout for potentially slow launches
