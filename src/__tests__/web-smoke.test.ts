import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, ChildProcess } from "child_process";
import { resolve } from "path";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";

describe("Web Frontend Smoke Test", () => {
  let serverProcess: ChildProcess;
  const PORT = 8081;
  const dataDir = resolve(import.meta.dirname, "../../data");
  const localYamlPath = resolve(dataDir, "local.yaml");

  beforeAll(async () => {
  }, 120000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  it("should have CSS files in public/assets with light and dark theme rules", () => {
    const assetsDir = resolve(import.meta.dirname, "../../public/assets");
    const files = readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith(".css"));

    expect(cssFiles.length).toBeGreaterThan(0);

    let hasDark = false;
    let hasLight = false;

    for (const cssFile of cssFiles) {
      const content = readFileSync(resolve(assetsDir, cssFile), "utf-8");
      if (content.includes(".dark")) hasDark = true;
      if (content.includes(".light") || content.includes(":root")) hasLight = true;
    }

    expect(hasDark).toBe(true);
    expect(hasLight).toBe(true);
  });

  it("should start the server and serve the HTML containing <div id=\"app\"></div>", async () => {
    let backupYaml = "";
    try {
      backupYaml = readFileSync(localYamlPath, "utf-8");
    } catch (e) {
    }

    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(localYamlPath, `tls:\n  transport: curl-cli\nserver:\n  port: ${PORT}\n`);

      serverProcess = spawn("node", ["dist/index.js"], {
        cwd: resolve(import.meta.dirname, "../../"),
        stdio: "inherit"
      });

      let attempts = 0;
      let serverReady = false;
      while (attempts < 20 && !serverReady) {
        try {
          const res = await fetch(`http://localhost:${PORT}/`);
          if (res.status === 200) {
            serverReady = true;
          }
        } catch (e) {
        }
        if (!serverReady) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;
        }
      }

      expect(serverReady).toBe(true);

      const res = await fetch(`http://localhost:${PORT}/`);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('<div id="app"></div>');

    } finally {
      try {
        if (backupYaml) {
          writeFileSync(localYamlPath, backupYaml);
        } else {
          writeFileSync(localYamlPath, "");
        }
      } catch (e) {}
    }
  }, 30000);
});
