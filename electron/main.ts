/**
 * Electron main process for Codex Proxy desktop app.
 *
 * Built by esbuild into dist-electron/main.cjs (CJS format).
 * Loads the backend ESM modules from asarUnpack (real filesystem paths).
 */

import { app, BrowserWindow, Tray, Menu, shell, nativeImage } from "electron";
import { resolve, join } from "path";
import { pathToFileURL } from "url";
import { existsSync, mkdirSync } from "fs";

const IS_MAC = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverHandle: { close: () => Promise<void>; port: number } | null = null;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── macOS application menu ──────────────────────────────────────────

function setupAppMenu(): void {
  if (!IS_MAC) return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App ready ────────────────────────────────────────────────────────

app.on("ready", async () => {
  setupAppMenu();

  // 1. Determine paths — must happen before importing backend
  const userData = app.getPath("userData");
  const dataDir = resolve(userData, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const appRoot = app.getAppPath();
  const distRoot = app.isPackaged
    ? resolve(process.resourcesPath, "app.asar.unpacked")
    : appRoot;

  const binDir = app.isPackaged
    ? resolve(process.resourcesPath, "bin")
    : resolve(appRoot, "bin");

  // 2. Set paths before any backend import
  const pathsUrl = pathToFileURL(resolve(distRoot, "dist", "paths.js")).href;
  const { setPaths } = await import(pathsUrl);
  setPaths({
    configDir: resolve(distRoot, "config"),
    dataDir,
    binDir,
    publicDir: resolve(distRoot, "public"),
    desktopPublicDir: resolve(distRoot, "public-desktop"),
  });

  // 3. Start the proxy server
  try {
    const indexUrl = pathToFileURL(resolve(distRoot, "dist", "index.js")).href;
    const { startServer } = await import(indexUrl);
    serverHandle = await startServer();
    console.log(`[Electron] Server started on port ${serverHandle.port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Electron] Failed to start server: ${msg}`);
    app.quit();
    return;
  }

  // 4. System tray
  createTray();

  // 5. Main window
  createWindow();
});

// ── Window ───────────────────────────────────────────────────────────

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 680,
    minHeight: 500,
    title: "Codex Proxy",
    // macOS: native hidden titlebar with traffic lights inset into content
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  const port = serverHandle?.port ?? 8080;
  mainWindow.loadURL(`http://localhost:${port}/desktop`);

  // Mark <html> with platform class so frontend CSS can adapt
  mainWindow.webContents.on("did-finish-load", () => {
    const legacy = IS_MAC ? "electron-mac" : "electron-win";
    const platform = IS_MAC ? "platform-mac" : "platform-win";
    mainWindow?.webContents.executeJavaScript(
      `document.documentElement.classList.add("electron","${legacy}","${platform}")`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Close → hide to tray instead of quitting
  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Tray ─────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = join(__dirname, "..", "electron", "assets", "icon.png");
  let icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  // macOS: resize to 18x18 and mark as template for automatic dark/light adaptation
  if (IS_MAC && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Proxy");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Dashboard",
      click: () => createWindow(),
    },
    { type: "separator" },
    {
      label: `Port: ${serverHandle?.port ?? 8080}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        mainWindow?.removeAllListeners("close");
        mainWindow?.close();
        mainWindow = null;

        if (serverHandle) {
          serverHandle.close().then(() => app.quit()).catch(() => app.quit());
        } else {
          app.quit();
        }
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => createWindow());
}

// macOS: re-create window when dock icon is clicked
app.on("activate", () => {
  createWindow();
});

// Prevent app from quitting when all windows are closed (tray keeps it alive)
app.on("window-all-closed", () => {
  // Do nothing — tray keeps the app running
});
