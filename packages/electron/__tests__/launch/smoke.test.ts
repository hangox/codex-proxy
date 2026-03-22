import { test, expect } from "vitest";
import { _electron as electron } from "playwright";
import fs from "fs";
import path from "path";

test("Smoke Test: Electron app packages and launches", async () => {
  // Find the built binary dynamically
  const unpackedDir = path.join(import.meta.dirname, "../../release/linux-unpacked");

  // The executable is the one with no extension or just find @codex-proxyelectron
  // `electron-builder` might output different names, so we can check for specific names or permissions
  const files = fs.readdirSync(unpackedDir);

  // Known executable names that electron-builder might output
  const possibleNames = ["@codex-proxyelectron", "codex-proxy", "Codex Proxy"];

  let executableName = files.find(f => possibleNames.includes(f));

  if (!executableName) {
    // Fallback: finding a file without extension that is likely the binary
    executableName = files.find(f => !f.includes(".") && !f.includes("chrome"));
  }

  if (!executableName) {
    throw new Error("Could not find electron executable in " + unpackedDir);
  }

  const executablePath = path.join(unpackedDir, executableName);

  const app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"], // Useful for CI/headless
  });

  const window = await app.firstWindow();

  // Verify window opens
  expect(window).toBeDefined();

  // Assert window count
  const windows = app.windows();
  expect(windows.length).toBe(1);

  // Close app cleanly
  await app.close();
});
