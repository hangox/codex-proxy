/**
 * Tests for the generic cross-process file lock (`utils/file-lock.ts`).
 *
 * Uses a real temp directory (not mocked fs) — the whole point of this
 * primitive is O_CREAT|O_EXCL filesystem semantics, which a mock can't
 * faithfully reproduce without reimplementing the thing under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

vi.mock("@src/paths.js", () => ({
  getDataDir: () => (globalThis as { __testDataDir?: string }).__testDataDir,
}));

import { tryAcquireFileLock, releaseFileLock } from "@src/utils/file-lock.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "file-lock-test-"));
  (globalThis as { __testDataDir?: string }).__testDataDir = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("tryAcquireFileLock / releaseFileLock", () => {
  it("acquires an uncontended lock", () => {
    expect(tryAcquireFileLock("test-lock", 10_000)).toBe(true);
  });

  it("refuses a second acquire while the first holder hasn't released", () => {
    expect(tryAcquireFileLock("test-lock", 10_000)).toBe(true);
    expect(tryAcquireFileLock("test-lock", 10_000)).toBe(false);
  });

  it("allows re-acquiring after release", () => {
    expect(tryAcquireFileLock("test-lock", 10_000)).toBe(true);
    releaseFileLock("test-lock");
    expect(tryAcquireFileLock("test-lock", 10_000)).toBe(true);
  });

  it("release is a no-op when nothing is held", () => {
    expect(() => releaseFileLock("never-acquired")).not.toThrow();
  });

  it("breaks a stale lock and re-acquires it", () => {
    const locksDir = resolve(dataDir, ".locks");
    mkdirSync(locksDir, { recursive: true });
    const lockPath = resolve(locksDir, "test-lock.lock");
    writeFileSync(
      lockPath,
      `999999\n${Date.now() - 20_000}`, // 20s old — stale under any staleMs < 20s
      { flag: "w" },
    );
    // A short staleMs (1s) makes the 20s-old lock above look stale.
    expect(tryAcquireFileLock("test-lock", 1_000)).toBe(true);
  });

  it("does not break a fresh lock even if staleMs is short", () => {
    expect(tryAcquireFileLock("test-lock", 1_000)).toBe(true);
    // Immediately try again with the same short staleMs — the lock we just
    // took is 0ms old, nowhere near stale.
    expect(tryAcquireFileLock("test-lock", 1_000)).toBe(false);
  });

  it("different lock names don't contend with each other", () => {
    expect(tryAcquireFileLock("lock-a", 10_000)).toBe(true);
    expect(tryAcquireFileLock("lock-b", 10_000)).toBe(true);
  });

  it("lock file records the holder's pid", () => {
    tryAcquireFileLock("test-lock", 10_000);
    const content = readFileSync(resolve(dataDir, ".locks", "test-lock.lock"), "utf-8");
    expect(content.split("\n")[0]).toBe(String(process.pid));
  });
});
