/**
 * esbuild script — bundles electron/main.ts into a single CJS file.
 *
 * Output: dist-electron/main.cjs
 * This avoids ESM+asar compatibility issues in Electron.
 */

import { build } from "esbuild";

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
