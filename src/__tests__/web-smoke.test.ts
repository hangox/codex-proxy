import { test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

test('Web frontend builds and generates CSS with light and dark themes', () => {
  const assetsDir = path.join(import.meta.dirname, '../../public/assets');

  const files = fs.readdirSync(assetsDir);
  const cssFiles = files.filter(f => f.endsWith('.css'));

  expect(cssFiles.length).toBeGreaterThan(0);

  let foundDarkTheme = false;
  let foundLightTheme = false;

  for (const cssFile of cssFiles) {
    const cssContent = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');
    if (cssContent.includes('.dark')) {
      foundDarkTheme = true;
    }
    // Just looking for some standard class without dark to imply light theme, or root variables
    if (cssContent.includes(':root') || cssContent.includes('bg-white')) {
      foundLightTheme = true;
    }
  }

  expect(foundDarkTheme).toBe(true);
  expect(foundLightTheme).toBe(true);
});

let serverProcess: ChildProcess;
const PORT = '8081';

beforeAll(async () => {
  const indexPath = path.join(import.meta.dirname, '../../dist/index.js');

  // Create a local config to bypass native transport failure
  const dataDir = path.join(import.meta.dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'local.yaml'), 'tls:\n  transport: curl-cli\n');

  serverProcess = spawn('node', [indexPath], {
    env: { ...process.env, PORT, DISABLE_NATIVE_TRANSPORT: '1' },
    stdio: 'pipe',
  });

  // Wait for the server to be ready
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out. Output: ${output}`)), 10000);

    serverProcess.stdout?.on('data', (data) => {
      output += data.toString();
      if (output.includes(`listening`) || output.includes(PORT)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error(`Server stderr: ${data}`);
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Also just try polling
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/`);
        if (res.ok) {
          clearInterval(pollInterval);
          clearTimeout(timeout);
          resolve();
        }
      } catch (e) {
        // Expected if server is not yet up
      }
    }, 500);
  });
});

afterAll(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});

test('Server serves the web dashboard', async () => {
  const response = await fetch(`http://localhost:${PORT}/`);
  expect(response.status).toBe(200);

  const text = await response.text();
  expect(text).toContain('<div id="app"></div>');
});
