import { test, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile, cp, rm } from "fs/promises";
import { resolve } from "path";
import { spawn, ChildProcess } from "child_process";

let serverProcess: ChildProcess;
const PORT = 8081;

beforeAll(async () => {
  // modify config/default.yaml before we start the server so it uses our custom port
  await cp(resolve(import.meta.dirname, "../../config/default.yaml"), resolve(import.meta.dirname, "../../config/default.yaml.bak"));
  const configContent = await readFile(resolve(import.meta.dirname, "../../config/default.yaml"), "utf-8");
  await require("fs/promises").writeFile(resolve(import.meta.dirname, "../../config/default.yaml"), configContent.replace(/port:\s*\d+/, `port: ${PORT}`));

  serverProcess = spawn("node", ["dist/index.js"], {
    env: { ...process.env },
    stdio: "inherit",
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));
});

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  // Restore original config
  await rm(resolve(import.meta.dirname, "../../config/default.yaml"));
  await cp(resolve(import.meta.dirname, "../../config/default.yaml.bak"), resolve(import.meta.dirname, "../../config/default.yaml"));
  await rm(resolve(import.meta.dirname, "../../config/default.yaml.bak"));
});

test("Vite build produces CSS with light and dark themes", async () => {
  const assetsDir = resolve(import.meta.dirname, "../../public/assets");
  const files = await readdir(assetsDir);
  const cssFiles = files.filter((f) => f.endsWith(".css"));

  expect(cssFiles.length).toBeGreaterThan(0);

  let hasLightRule = false;
  let hasDarkRule = false;

  for (const file of cssFiles) {
    const content = await readFile(resolve(assetsDir, file), "utf-8");
    if (content.includes(":root") || content.includes("body")) {
      hasLightRule = true;
    }
    if (content.includes(".dark") || content.includes("@media (prefers-color-scheme: dark)")) {
      hasDarkRule = true;
    }
  }

  expect(hasLightRule).toBe(true);
  expect(hasDarkRule).toBe(true);
});

test("Server serves HTML containing <div id=\"app\"></div>", async () => {
  // Use global fetch
  const response = await fetch(`http://localhost:${PORT}/`);
  expect(response.status).toBe(200);

  const html = await response.text();
  expect(html).toContain('<div id="app"></div>');
});
