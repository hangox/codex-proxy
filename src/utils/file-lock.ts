/**
 * Generic cross-process file lock.
 *
 * Generalized from the per-account RT refresh lock (`auth/refresh-lock.ts`,
 * now a thin wrapper over this module — see that file for why the two need
 * different staleness thresholds).
 *
 * Uses O_CREAT | O_EXCL ("wx" flag) for atomic exclusive create — this is a
 * real filesystem-level primitive, safe across processes (not just within
 * one Node event loop). Stale locks are automatically broken so a crashed
 * holder doesn't wedge the lock forever; callers pick their own `staleMs`
 * because "how long is too long to hold this lock" depends entirely on what
 * the lock protects (see refresh-lock.ts vs yaml-mutate.ts for two very
 * different answers to that question).
 */

import { writeFileSync, unlinkSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { getDataDir } from "../paths.js";

function lockDir(): string {
  const dir = resolve(getDataDir(), ".locks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(lockName: string): string {
  return resolve(lockDir(), `${lockName}.lock`);
}

/**
 * Try to acquire an exclusive lock. Returns true if acquired, false if
 * another holder currently has it (and it isn't stale yet).
 *
 * Non-blocking — callers that need to wait for contention to clear (e.g.
 * `mutateYaml`) are responsible for their own retry/backoff loop around
 * this function. This function itself never sleeps or retries beyond the
 * single "stale lock, break it and immediately re-attempt once" case.
 */
export function tryAcquireFileLock(lockName: string, staleMs: number): boolean {
  const path = lockPath(lockName);
  try {
    writeFileSync(path, `${process.pid}\n${Date.now()}`, { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    // Lock file exists — check if stale
    try {
      const content = readFileSync(path, "utf-8");
      const ts = parseInt(content.split("\n")[1], 10);
      if (!isNaN(ts) && Date.now() - ts > staleMs) {
        // Stale lock — break and re-acquire
        unlinkSync(path);
        return tryAcquireFileLock(lockName, staleMs);
      }
    } catch {
      // Can't read lock — another process may have just deleted it, retry once
      try {
        writeFileSync(path, `${process.pid}\n${Date.now()}`, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Release a lock previously acquired with {@link tryAcquireFileLock}. */
export function releaseFileLock(lockName: string): void {
  try {
    unlinkSync(lockPath(lockName));
  } catch {
    // Already deleted or never existed — fine
  }
}
