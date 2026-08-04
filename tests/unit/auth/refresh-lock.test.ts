/**
 * Tests for `auth/refresh-lock.ts` after its #104 refactor into a thin
 * wrapper over the generic `utils/file-lock.ts` primitive.
 *
 * ★ This file exists specifically because the refactor had zero pre-existing
 * test coverage protecting it — `grep -rln "tryAcquireRefreshLock" tests/`
 * was a clean miss before this file. "3057 tests passed" during the #104
 * work carried no information about whether this module still behaved
 * correctly; it just meant nothing had ever exercised it. This file locks
 * down exactly the three things the refactor could plausibly have broken —
 * not a full re-test of file-lock.ts's own mechanics (that's file-lock.test.ts's
 * job), just the seam between the two modules:
 *
 * 1. Lock files still carry the `refresh-` prefix `cleanupStaleLocks` filters on.
 * 2. `cleanupStaleLocks()` still finds and removes them.
 * 3. The 5-minute staleness threshold is still 5 minutes — not accidentally
 *    inherited from `yaml-mutate.ts`'s unrelated 10-second value now that
 *    both share the same underlying `tryAcquireFileLock(name, staleMs)`.
 *
 * Uses a real temp directory (not mocked fs) for the same reason
 * file-lock.test.ts does — O_CREAT|O_EXCL semantics aren't worth re-implementing
 * in a mock just to test against the mock's own re-implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

vi.mock("@src/paths.js", () => ({
  getDataDir: () => (globalThis as { __testDataDir?: string }).__testDataDir,
}));

import { tryAcquireRefreshLock, releaseRefreshLock, cleanupStaleLocks } from "@src/auth/refresh-lock.js";

let dataDir: string;
let locksDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "refresh-lock-test-"));
  locksDir = resolve(dataDir, ".locks");
  (globalThis as { __testDataDir?: string }).__testDataDir = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("refresh-lock.ts seam with the generic file-lock primitive", () => {
  it("1. lock file name still carries the 'refresh-' prefix cleanupStaleLocks filters on", () => {
    expect(tryAcquireRefreshLock("entry-abc")).toBe(true);
    const files = readdirSync(locksDir);
    expect(files).toContain("refresh-entry-abc.lock");
  });

  it("2. cleanupStaleLocks() still finds and removes a stale refresh- lock", () => {
    mkdirSync(locksDir, { recursive: true });
    const staleLockPath = resolve(locksDir, "refresh-dead-entry.lock");
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000; // older than the 5-minute threshold
    writeFileSync(staleLockPath, `12345\n${sixMinutesAgo}`);

    cleanupStaleLocks();

    expect(readdirSync(locksDir)).not.toContain("refresh-dead-entry.lock");
  });

  it("2b. cleanupStaleLocks() leaves a fresh refresh- lock alone", () => {
    expect(tryAcquireRefreshLock("entry-fresh")).toBe(true);
    cleanupStaleLocks();
    expect(readdirSync(locksDir)).toContain("refresh-entry-fresh.lock");
  });

  it("2c. cleanupStaleLocks() ignores non-refresh- lock files entirely (e.g. yaml-mutate's locks)", () => {
    mkdirSync(locksDir, { recursive: true });
    const foreignLockPath = resolve(locksDir, "yaml-abc123.lock");
    const veryOld = Date.now() - 60 * 60 * 1000; // 1 hour old — stale by any threshold
    writeFileSync(foreignLockPath, `12345\n${veryOld}`);

    cleanupStaleLocks();

    // Must still be there — cleanupStaleLocks only owns refresh-*.lock files.
    expect(readdirSync(locksDir)).toContain("yaml-abc123.lock");
  });

  it("3. staleness threshold is still 5 minutes, NOT yaml-mutate's unrelated 10-second value", () => {
    // A lock aged 15 seconds: stale under yaml-mutate's 10s threshold, but
    // must NOT be treated as stale under refresh-lock's own 5-minute one.
    // If the refactor had accidentally wired refresh-lock through a shared
    // 10s constant instead of keeping its own STALE_MS, this would
    // incorrectly break the lock and re-acquire it (return true).
    expect(tryAcquireRefreshLock("entry-borderline")).toBe(true);
    const lockPath = resolve(locksDir, "refresh-entry-borderline.lock");
    const fifteenSecondsAgo = Date.now() - 15_000;
    writeFileSync(lockPath, `99999\n${fifteenSecondsAgo}`);

    expect(tryAcquireRefreshLock("entry-borderline")).toBe(false);
  });

  it("3b. a lock older than 5 minutes IS still treated as stale and broken", () => {
    const lockPath = resolve(locksDir, "refresh-entry-old.lock");
    mkdirSync(locksDir, { recursive: true });
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    writeFileSync(lockPath, `99999\n${sixMinutesAgo}`);

    expect(tryAcquireRefreshLock("entry-old")).toBe(true);
  });

  it("release + re-acquire still works end to end through the wrapper", () => {
    expect(tryAcquireRefreshLock("entry-x")).toBe(true);
    expect(tryAcquireRefreshLock("entry-x")).toBe(false);
    releaseRefreshLock("entry-x");
    expect(tryAcquireRefreshLock("entry-x")).toBe(true);
  });
});
