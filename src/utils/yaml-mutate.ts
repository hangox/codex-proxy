/**
 * Structured YAML file mutation — parse, mutate, write back.
 *
 * Avoids fragile regex-based replacements.
 * Note: js-yaml.dump() does not preserve comments.
 *
 * ★ Locking is defense-in-depth, not a fix for a confirmed incident. A
 * 2026-08-04 investigation into an apparent "config key silently vanished"
 * report found NO evidence of an actual cross-request race (single-process
 * container, only one successful write logged in the relevant window, and a
 * same-process interleaving test could not reproduce data loss — see #104
 * discussion). The most likely explanation for that specific report was an
 * investigator error (conflating a PATCH response body with an independent
 * re-read), not a real bug. The underlying defect this file had — a fixed
 * `.tmp` filename shared by every caller, with no mutual exclusion around
 * read-mutate-write-rename — is nonetheless real and worth closing: it would
 * matter the moment this process is ever scaled to multiple replicas sharing
 * the same data volume, or if an external tool writes the same file
 * concurrently with the running process. Fixed here preventively.
 *
 * ★ Scope of what this lock actually protects — do not overstate it. It only
 * covers writers that go through `mutateYaml`. It does NOT cover the
 * separate compose-startup script (see CLAUDE.md) that rewrites
 * `local.yaml`'s `server.proxy_api_key`/`trust_proxy` via its own inline
 * js-yaml merge on every container start — that script never acquires this
 * lock. That writer only runs once, at container start (not mid-flight), so
 * it doesn't compete with in-process writes in practice, but it means "this
 * file now has a lock" is not the same claim as "all writers to local.yaml
 * are now mutually exclusive." They are not.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes, createHash } from "crypto";
import yaml from "js-yaml";
import { tryAcquireFileLock, releaseFileLock } from "./file-lock.js";

// ★ Deliberately NOT the 5-minute threshold `auth/refresh-lock.ts` uses —
// that value is calibrated for a refresh op that takes seconds to tens of
// seconds. This lock protects a millisecond-scale read-mutate-write-rename.
// Reusing 5 minutes here would mean a single crashed writer blocks every
// config write on this file for 5 minutes — a worse outcome than the race
// it's meant to prevent. 10s is an experience-based value (not measured
// against a real failure distribution): comfortably above any realistic
// write duration, short enough that a crash self-heals quickly.
const LOCK_STALE_MS = 10 * 1000;

// ★ Also experience-based, not measured. Long enough that ordinary
// contention (two admin API calls landing within the same tens-of-ms
// window) resolves without the caller seeing an error; short enough that a
// genuinely wedged lock doesn't hang an HTTP request for an unreasonable
// time. If this value turns out wrong in practice, look for evidence before
// changing it — don't just guess a new number.
const ACQUIRE_TIMEOUT_MS = 2000;
const ACQUIRE_RETRY_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Short, stable lock name derived from the full file path (not `basename`
 *  — two files with the same basename in different directories must not
 *  share a lock; a path hash has no such collision risk). */
function lockNameForPath(filePath: string): string {
  return `yaml-${createHash("sha256").update(filePath).digest("hex").slice(0, 16)}`;
}

async function acquireWithRetry(lockName: string): Promise<boolean> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    if (tryAcquireFileLock(lockName, LOCK_STALE_MS)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(ACQUIRE_RETRY_INTERVAL_MS);
  }
}

/**
 * Load a YAML file, apply a mutator function, and atomically write it back.
 * Uses tmp-file + rename for crash safety, and a cross-process lock so two
 * concurrent callers on the same file don't lose one writer's changes.
 * Creates the file (and parent directories) if it doesn't exist.
 *
 * Throws if the lock cannot be acquired within the timeout, rather than
 * silently proceeding unprotected or silently dropping the write — callers
 * (all currently admin API route handlers) should let this propagate into a
 * 5xx response. An explicit error the caller can see and retry is strictly
 * better than "the API said success and the write never happened," which is
 * the exact failure mode this file exists to prevent.
 */
export async function mutateYaml(
  filePath: string,
  mutator: (data: Record<string, unknown>) => void,
): Promise<void> {
  const lockName = lockNameForPath(filePath);
  const acquired = await acquireWithRetry(lockName);
  if (!acquired) {
    throw new Error(
      `[mutateYaml] Failed to acquire lock for ${filePath} within ${ACQUIRE_TIMEOUT_MS}ms — another writer is holding it`,
    );
  }
  try {
    let data: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      data = (yaml.load(raw) as Record<string, unknown>) ?? {};
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    mutator(data);
    // ★ Unique per call, not a shared `${filePath}.tmp` — this alone doesn't
    // fix the "lost update" race (that's what the lock above is for), but it
    // does prevent two writers' tmp files from stomping each other's content
    // mid-write, which would otherwise produce a hybrid of neither writer's
    // intended result. Belt-and-suspenders with the lock, not a substitute
    // for it.
    const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, yaml.dump(data, { lineWidth: -1, quotingType: '"' }), "utf-8");
    renameSync(tmp, filePath);
  } finally {
    releaseFileLock(lockName);
  }
}
