/**
 * Per-account file lock for RT refresh operations.
 *
 * Prevents concurrent RT consumption across:
 * - RefreshScheduler recovery + probeAccount (same process)
 * - Overlapping processes during pm2 restart (cross-process)
 *
 * Thin wrapper over the generic `utils/file-lock.ts` primitive — kept as its
 * own module (rather than callers reaching for file-lock.ts directly) because
 * this lock's staleness threshold is deliberately different and must not
 * drift if someone changes the generic default later: a refresh takes
 * seconds to tens of seconds, so 5 minutes is a reasonable "this holder is
 * dead" cutoff. Contrast with `utils/yaml-mutate.ts`'s lock, which protects a
 * millisecond-scale operation and uses a 10s threshold — reusing this file's
 * 5-minute constant there would mean a crashed writer blocks all config
 * writes for 5 minutes, which is a worse outcome than the race it prevents.
 */

import { readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import { getDataDir } from "../paths.js";
import { tryAcquireFileLock, releaseFileLock } from "../utils/file-lock.js";

const STALE_MS = 5 * 60 * 1000; // 5 minutes

function lockName(entryId: string): string {
  return `refresh-${entryId}`;
}

/**
 * Try to acquire an exclusive refresh lock for an account.
 * Returns true if the lock was acquired, false if another caller holds it.
 */
export function tryAcquireRefreshLock(entryId: string): boolean {
  return tryAcquireFileLock(lockName(entryId), STALE_MS);
}

/**
 * Release the refresh lock for an account.
 */
export function releaseRefreshLock(entryId: string): void {
  releaseFileLock(lockName(entryId));
}

/**
 * Clean up all stale lock files (call on startup).
 */
export function cleanupStaleLocks(): void {
  // Re-implemented directly (not via file-lock.ts, which has no "list all
  // locks of a kind" concept) — same best-effort semantics as before.
  try {
    const dir = resolve(getDataDir(), ".locks");
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("refresh-") || !file.endsWith(".lock")) continue;
      try {
        const content = readFileSync(resolve(dir, file), "utf-8");
        const ts = parseInt(content.split("\n")[1], 10);
        if (!isNaN(ts) && now - ts > STALE_MS) {
          unlinkSync(resolve(dir, file));
        }
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Lock dir doesn't exist yet — nothing to clean
  }
}
