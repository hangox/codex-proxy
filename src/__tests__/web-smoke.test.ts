import { test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

let serverProcess: ChildProcess;

beforeAll(async () => {
  // Start the server on port 8081
  const serverPath = path.join(import.meta.dirname, '../../dist/index.js');
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: '8081' },
    // Pipe stdout to debug
    stdio: 'pipe',
  });

  serverProcess.stdout?.on('data', (data) => console.log(`stdout: ${data}`));
  serverProcess.stderr?.on('data', (data) => console.error(`stderr: ${data}`));

  // Wait for the server to be ready
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      try {
        const response = await fetch('http://localhost:8081/health');
        if (response.ok) {
          clearInterval(interval);
          resolve();
        }
      } catch (error) {
        attempts++;
        if (attempts > 30) {
          clearInterval(interval);
          reject(new Error('Server failed to start within 30 seconds'));
        }
      }
    }, 1000);
  });
}, 40000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test('Web frontend assets contain dark theme', () => {
  const assetsDir = path.join(import.meta.dirname, '../../public/assets');
  expect(fs.existsSync(assetsDir)).toBe(true);

  const cssFiles = fs.readdirSync(assetsDir).filter((file) => file.endsWith('.css'));
  expect(cssFiles.length).toBeGreaterThan(0);

  let hasDarkTheme = false;
  let hasLightTheme = false;

  for (const file of cssFiles) {
    const content = fs.readFileSync(path.join(assetsDir, file), 'utf-8');
    if (content.includes('.dark') || content.includes('@media (prefers-color-scheme: dark)')) {
      hasDarkTheme = true;
    }
    if (content.includes(':root') || content.includes(':host')) {
      hasLightTheme = true;
    }
  }

  expect(hasLightTheme).toBe(true);
  expect(hasDarkTheme).toBe(true);
});

test('Web frontend serves HTML app container', async () => {
  const response = await fetch('http://localhost:8081/');
  expect(response.status).toBe(200);

  const text = await response.text();
  expect(text).toContain('<div id="app"></div>');
});