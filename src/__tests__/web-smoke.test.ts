import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

describe("Web frontend smoke test", () => {
  let serverProcess: ChildProcess;
  const PORT = "8081";

  beforeAll(async () => {
    // Start the server process on an alternative port
    serverProcess = spawn("node", ["dist/index.js"], {
      env: { ...process.env, PORT },
      stdio: "ignore",
    });

    // Wait for the server to be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  afterAll(() => {
    // Clean up server process
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  it("public/assets/ contains .css files with light and dark theme rules", () => {
    const assetsDir = path.join(import.meta.dirname, "..", "..", "public", "assets");

    // Check if assets directory exists
    expect(fs.existsSync(assetsDir)).toBe(true);

    // Find CSS files
    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));

    expect(cssFiles.length).toBeGreaterThan(0);

    // Check for light and dark theme content in CSS files
    let foundDarkTheme = false;
    let foundLightTheme = false;

    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), "utf-8");

      if (content.includes(".dark") || content.includes("@media (prefers-color-scheme: dark)")) {
        foundDarkTheme = true;
      }

      if (content.includes(":root") || content.includes("@media (prefers-color-scheme: light)")) {
        foundLightTheme = true;
      }
    }

    expect(foundDarkTheme).toBe(true);
    expect(foundLightTheme).toBe(true);
  });

  it("server returns HTML containing <div id=\"app\"></div>", async () => {
    const response = await fetch(`http://localhost:${PORT}/`);

    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<div id="app"></div>');
  });
});
