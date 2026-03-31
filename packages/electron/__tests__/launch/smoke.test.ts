import { test, expect } from 'vitest';
import { _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';

test('App launches and opens a window', async () => {
  // We need to increase timeout for electron tests, just in case
  const executablePath = path.join(
    import.meta.dirname,
    '../../release/linux-unpacked/codex-proxy' // fallback to standard name, might be right
  );

  let actualPath = executablePath;
  if (!fs.existsSync(executablePath)) {
    actualPath = path.join(import.meta.dirname, '../../release/linux-unpacked/@codex-proxyelectron');
  }

  // Set an environment variable to override config loading to prevent native tls from crashing
  // App shouldn't crash just because native tls fails anyway but to be sure
  const userDataPath = path.join(import.meta.dirname, 'dummy-data');
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(path.join(userDataPath, 'local.yaml'), 'tls:\n  transport: curl-cli\n');
  }

  const electronApp = await electron.launch({
    executablePath: actualPath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${userDataPath}`],
    env: { ...process.env, DISABLE_NATIVE_TRANSPORT: 'true' },
  });

  // Listen to console to see errors
  electronApp.on('window', async (page) => {
    page.on('console', (msg) => console.log(msg.text()));
  });

  const window = await electronApp.firstWindow();

  // Wait for the window to be created and to load something
  // Just getting the title is enough to prove it launched and opened a window
  const title = await window.title();
  expect(title).toBeDefined();

  // Close cleanly
  await electronApp.close();
}, 60000);