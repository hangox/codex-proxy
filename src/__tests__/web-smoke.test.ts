import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

const rootDir = path.resolve(import.meta.dirname, '../../');
const publicDir = path.join(rootDir, 'public');

describe('Web Frontend Smoke Test', () => {
  let serverProcess: ChildProcess;
  const PORT = 8081;

  beforeAll(async () => {
    // Start the server process on custom port
    serverProcess = spawn('node', ['dist/index.js'], {
      cwd: rootDir,
      env: { ...process.env, PORT: PORT.toString() },
      stdio: 'pipe',
    });

    // Wait for the server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server did not start within 10 seconds'));
      }, 10000);

      serverProcess.stdout?.on('data', (data) => {
        if (data.toString().includes(`Codex Proxy Server`) || data.toString().includes(`Listen:`)) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on('data', (data) => {
        console.error(`Server stderr: ${data}`);
      });

      serverProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }, 15000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  it('should have built CSS with light and dark themes', () => {
    const assetsDir = path.join(publicDir, 'assets');
    expect(fs.existsSync(assetsDir)).toBe(true);

    const files = fs.readdirSync(assetsDir);
    const cssFiles = files.filter(f => f.endsWith('.css'));
    expect(cssFiles.length).toBeGreaterThan(0);

    let foundLight = false;
    let foundDark = false;

    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf-8');
      if (content.includes(':root') || content.includes('html')) {
        foundLight = true;
      }
      if (content.includes('.dark') || content.includes('@media (prefers-color-scheme: dark)')) {
        foundDark = true;
      }
    }

    expect(foundLight).toBe(true);
    expect(foundDark).toBe(true);
  });

  it('should serve HTML with <div id="app"></div>', async () => {
    const response = await fetch(`http://localhost:${PORT}/`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<div id="app"></div>');
  });
});
