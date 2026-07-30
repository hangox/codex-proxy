/**
 * Centralized path management for CLI and Electron modes.
 *
 * CLI mode (default): all paths relative to process.cwd().
 * Electron mode: paths set by setPaths() before backend imports.
 */

import { dirname, resolve } from "path";

interface PathConfig {
  rootDir: string;
  configDir: string;
  dataDir: string;
  binDir: string;
  publicDir: string;
}

let _paths: PathConfig | null = null;

/**
 * Set custom paths (called by Electron main process before importing backend).
 * Must be called before any getXxxDir() calls.
 */
export function setPaths(config: PathConfig): void {
  _paths = config;
}

/** App root directory (where package.json lives). */
export function getRootDir(): string {
  return _paths?.rootDir ?? process.cwd();
}

/** Directory containing YAML config files. */
export function getConfigDir(): string {
  return _paths?.configDir ?? resolve(process.cwd(), "config");
}

/** Directory for runtime data (accounts.json, cookies.json, etc.). */
export function getDataDir(): string {
  return _paths?.dataDir ?? resolve(process.cwd(), "data");
}

/** Directory for curl-impersonate binaries. */
export function getBinDir(): string {
  return _paths?.binDir ?? resolve(process.cwd(), "bin");
}

/** Directory for static web assets (Vite build output). */
export function getPublicDir(): string {
  return _paths?.publicDir ?? resolve(process.cwd(), "public");
}

/** Whether running in embedded mode (Electron). */
export function isEmbedded(): boolean {
  return _paths !== null;
}

/**
 * Default location for opaque compact's master keyring
 * (`opaque_compact_state.keyring_file`) when the operator hasn't configured
 * one explicitly.
 *
 * Must resolve outside `getDataDir()` (see `config-schema.ts` — this is
 * checked at runtime, not just documented): the master key and the ciphertext
 * it protects can't share a volume, or a single backup/leak exposes both.
 * One formula covers every deployment form because `getDataDir()` is already
 * correctly configured per-form by `setPaths()` — this just takes its parent
 * and adds a sibling directory, it does not hardcode a platform-specific path:
 *
 *   - Docker:        dataDir=/app/data                  → /app/opaque-keys/keyring.json
 *     (provisioned by docker-compose.yml's volume mount + the Dockerfile's
 *     `mkdir -p`, both already root-owned/chown'd by docker-entrypoint.sh).
 *   - Electron:      dataDir=<userData>/data             → <userData>/opaque-keys/keyring.json
 *     (verified by actually launching a packaged build and inspecting its
 *     real `--user-data-dir` via `ps` — do not assume this matches
 *     `productName`; it does not, see CHANGELOG).
 *   - Running from a source checkout (no setPaths() call): dataDir=<cwd>/data
 *     → <cwd>/opaque-keys/keyring.json — a real, irreversible encryption key
 *     ends up at the repo root. `.gitignore`/`.dockerignore` both exclude
 *     `opaque-keys/` for exactly this reason; don't remove those entries
 *     without re-checking this comment.
 *
 * Only used as a fallback — explicit `opaque_compact_state.keyring_file`
 * configuration always wins over this.
 */
export function getDefaultOpaqueCompactKeyringFile(): string {
  return resolve(dirname(getDataDir()), "opaque-keys", "keyring.json");
}
