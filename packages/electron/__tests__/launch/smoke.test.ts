import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron, ElectronApplication, Page } from 'playwright';
import path from 'path';

describe.runIf(process.env.CI || process.env.RUN_E2E_SMOKE)('Electron Launch Smoke Test', () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    let executablePath = '';
    const releaseDir = path.join(import.meta.dirname, '../../release');

    if (process.platform === 'win32') {
      executablePath = path.join(releaseDir, 'win-unpacked', 'Codex Proxy.exe');
    } else if (process.platform === 'darwin') {
      executablePath = path.join(releaseDir, 'mac', 'Codex Proxy.app', 'Contents', 'MacOS', 'Codex Proxy');
    } else {
      executablePath = path.join(releaseDir, 'linux-unpacked', 'codex-proxy');
    }

    app = await electron.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    page = await app.firstWindow();
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should launch the main window successfully', async () => {
    expect(page).toBeDefined();

    const title = await page.title();
    expect(title).toBeDefined();

    expect(await page.isVisible('body')).toBeTruthy();
  });
});
