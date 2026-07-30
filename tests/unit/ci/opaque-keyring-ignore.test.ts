/**
 * `getDefaultOpaqueCompactKeyringFile()`（`src/paths.ts`）resolves to
 * `<sibling-of-data>/opaque-keys/keyring.json`. When nothing overrides
 * `dataDir` via `setPaths()` (i.e. running straight from a source checkout,
 * no Docker/Electron wrapper), that sibling is the repo root itself —
 * `<repo-root>/opaque-keys/keyring.json`. Combined with the new auto-init
 * behavior (opening the switch on a fresh store now creates a real master
 * key with no manual step), anyone who runs this repo from source and
 * flips the switch on gets a real, irreversible encryption key sitting at
 * the repo root.
 *
 * `.gitignore` only had `data/`, not `opaque-keys/` — a plain `git add -A`
 * would have staged that key. `.dockerignore` is a wholly separate
 * mechanism (Docker does not read `.gitignore`); `docker-compose.yml`'s
 * commented-out `build: .` option runs `COPY . .` against the exact same
 * checkout, so a developer's local `opaque-keys/` could end up baked into
 * an image layer without its own exclusion.
 *
 * This locks both — not just "the ignore files parse", but that they
 * actually cover this specific, real path.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

function ignoreLines(path: string): string[] {
  return readFileSync(resolve(ROOT, path), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("opaque-keys/ is excluded from both git and docker build context", () => {
  it(".gitignore excludes opaque-keys/ — a plain `git add -A` must not stage a real master key", () => {
    const lines = ignoreLines(".gitignore");
    expect(lines).toContain("opaque-keys/");
  });

  it(".dockerignore independently excludes opaque-keys/ — Docker does not read .gitignore, this needs its own entry", () => {
    const lines = ignoreLines(".dockerignore");
    expect(lines).toContain("opaque-keys/");
  });
});
