import { test, expect, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

let serverProcess: ChildProcess;

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test("Smoke Test: Web frontend builds and serves", async () => {
  // 1. Verify CSS assets contain theme rules
  const assetsDir = path.join(import.meta.dirname, "../../public/assets");
  const files = fs.readdirSync(assetsDir);
  const cssFile = files.find((f) => f.endsWith(".css"));
  expect(cssFile).toBeDefined();

  const cssContent = fs.readFileSync(path.join(assetsDir, cssFile!), "utf8");
  expect(cssContent).toContain("dark:"); // Contains dark theme rule

  // verify it's a non-empty CSS file
  expect(cssContent.length).toBeGreaterThan(0);

  // 2. Start server
  // process.env.PORT is supported according to src/config.ts applyEnvOverrides
  serverProcess = spawn("node", ["dist/index.js"], {
    env: { ...process.env, PORT: "8081" },
  });

  // Wait for server to be ready with a retry loop
  let isReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://localhost:8081/");
      if (res.ok) {
        isReady = true;
        const html = await res.text();
        expect(html).toContain('<div id="app"></div>');
        break;
      }
    } catch (err) {
      // Ignore connection refused errors during startup
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  expect(isReady).toBe(true);
}, 35000);
