import { test, expect } from 'vitest';
import { _electron as electron } from 'playwright';
import { resolve } from 'path';
import { readdirSync } from 'fs';

test('launch packaged app', async () => {
  const unpackedPath = resolve(__dirname, '../release/linux-unpacked');

  // Find the executable in the unpacked path
  const files = readdirSync(unpackedPath);
  let executable = files.find(f => f.startsWith('@codex-proxyelectron'));

  if (!executable) {
    throw new Error('Executable not found in linux-unpacked');
  }

  const executablePath = resolve(unpackedPath, executable);

  const electronApp = await electron.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const isAppReady = await electronApp.evaluate(async ({ app }) => {
    return app.isReady();
  });
  expect(isAppReady).toBeTruthy();

  const window = await electronApp.firstWindow();
  expect(window).toBeTruthy();

  await electronApp.close();
}, 30000);
