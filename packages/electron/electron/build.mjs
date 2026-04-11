/**
 * esbuild script — bundles Electron main + backend server.
 *
 * Output:
 *   dist-electron/main.cjs    — Electron main process (CJS)
 *   dist-electron/server.mjs  — Backend server bundle (ESM)
 *
 * 大部分依赖会内联进 server bundle；`ws` 这类 CJS/ESM 互操作敏感包
 * 保持 external，并在 prepare-pack 阶段复制到 app.asar/node_modules。
 */

import { build } from "esbuild";

// 1. Electron main process → CJS (loaded by Electron directly)
await build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist-electron/main.cjs",
  external: ["electron"],
  target: "node20",
  sourcemap: true,
});

console.log("[esbuild] dist-electron/main.cjs built successfully");

// 2. Backend server → ESM (dynamically imported by main.cjs)
//    大部分 npm 依赖会被打进单文件 bundle；WebSocket 相关运行时包保持 external。
await build({
  entryPoints: ["src/electron-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist-electron/server.mjs",
  external: ["ws", "https-proxy-agent"],
  target: "node20",
  sourcemap: true,
  // Mark .node files as external (native addons)
  loader: { ".node": "empty" },
});

console.log("[esbuild] dist-electron/server.mjs built successfully");
