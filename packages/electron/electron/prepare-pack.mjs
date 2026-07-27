/**
 * Copy root-level runtime resources into packages/electron/ before
 * electron-builder runs, so all paths resolve relative to projectDir.
 *
 * Usage:
 *   node electron/prepare-pack.mjs          # copy
 *   node electron/prepare-pack.mjs --clean  # remove copies
 */

import { cpSync, existsSync, rmSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PKG = resolve(import.meta.dirname, "..");

const DIRS = ["config", "public", "bin"];
const isClean = process.argv.includes("--clean");

for (const dir of DIRS) {
  const src = resolve(ROOT, dir);
  const dest = resolve(PKG, dir);

  if (isClean) {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true });
      console.log(`[prepare-pack] removed ${dir}/`);
    }
  } else {
    if (!existsSync(src)) {
      console.warn(`[prepare-pack] skipping ${dir}/ (not found at ${src})`);
      continue;
    }
    // Clean destination first to avoid stale files from previous builds
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true });
    }
    cpSync(src, dest, { recursive: true });
    console.log(`[prepare-pack] copied ${dir}/ → packages/electron/${dir}/`);
  }
}

// Native addon — copy only runtime files (index.js, index.d.ts, *.node, package.json),
// skip Rust source, build artifacts (target/), and node_modules.
const nativeSrc = resolve(ROOT, "native");
const nativeDest = resolve(PKG, "native");

if (isClean) {
  if (existsSync(nativeDest)) {
    rmSync(nativeDest, { recursive: true });
    console.log("[prepare-pack] removed native/");
  }
} else if (!existsSync(nativeSrc)) {
  console.warn(`[prepare-pack] skipping native/ (not found at ${nativeSrc})`);
} else {
  cpSync(nativeSrc, nativeDest, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = src.slice(nativeSrc.length);
      // Skip Rust source, build artifacts, and node_modules
      if (/\/(target|node_modules|src)(\/|$)/.test(rel)) return false;
      if (/\/(Cargo\.(toml|lock)|build\.rs|\.cargo)/.test(rel)) return false;
      return true;
    },
  });
  console.log("[prepare-pack] copied native/ (runtime only) → packages/electron/native/");
}

// External runtime dependencies are declared in packages/electron/package.json.
// npm workspaces may hoist them to the repository root; electron-builder follows
// the production dependency graph and packages the exact hoisted/nested layout.
// Do not hand-copy node_modules here: doing so hides those packages from the
// dependency collector and caused clean App bundles to omit `ws` entirely.
