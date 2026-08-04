/**
 * Cross-process concurrency test for `mutateYaml`'s lock (#104).
 *
 * ★ Why this MUST fork real OS processes, not simulate concurrency within
 * one process: an earlier investigation (see #104 discussion) tried
 * reproducing the "two writers lose one writer's change" race with two
 * async handlers in the *same* process, each `await`-ing a short delay
 * before calling the real `mutateYaml`. It could not reproduce any data
 * loss, with or without the lock. The reason: `mutateYaml`'s body has no
 * `await` inside it, so once a call enters it, Node's single-threaded
 * run-to-completion semantics guarantee it finishes (read → mutate → write
 * → rename) before any other queued callback — including another
 * `mutateYaml` call — gets a turn. Two "concurrent" same-process callers
 * are, from `mutateYaml`'s perspective, never actually concurrent.
 *
 * A same-process test would therefore pass identically whether or not the
 * lock exists — exactly the "guard exists but has no teeth" pattern this
 * repo has hit repeatedly. This test only means something because it forks
 * two independent OS processes (`child_process.fork`, via `fixtures/
 * yaml-mutate-concurrency-worker.ts`) that race the same file for real.
 *
 * Verified once, manually, outside this file (not re-verified on every CI
 * run — that would require checking out the pre-fix code, which isn't
 * something a test can do to itself): with the lock removed, this test's
 * loop reliably lost at least one field within a handful of iterations.
 * With the lock in place, it holds across the iteration count below.
 */

import { describe, it, expect } from "vitest";
import { fork, type ChildProcess } from "child_process";
import { resolve } from "path";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import yaml from "js-yaml";

const WORKER_PATH = resolve(__dirname, "fixtures/yaml-mutate-concurrency-worker.ts");
// Statistically meaningful without making the suite slow — races are timing
// dependent, not guaranteed every run, so one clean iteration proves nothing
// and this needs several. Chosen empirically low enough to keep CI fast, not
// derived from a formal confidence calculation.
const ITERATIONS = 20;

function forkWorker(targetFile: string, fieldName: string, fieldValue: string): Promise<ChildProcess> {
  return new Promise((resolveReady, reject) => {
    const child = fork(WORKER_PATH, [targetFile, fieldName, fieldValue], {
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
    });
    const onMessage = (msg: unknown) => {
      if (msg === "ready") {
        child.off("message", onMessage);
        resolveReady(child);
      }
    };
    child.on("message", onMessage);
    child.on("error", reject);
  });
}

function waitForDone(child: ChildProcess): Promise<void> {
  return new Promise((resolveDone, reject) => {
    child.on("message", (msg) => {
      if (msg === "done") resolveDone();
      else if (typeof msg === "string" && msg.startsWith("error:")) {
        reject(new Error(`worker reported: ${msg.slice("error:".length)}`));
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

async function runOneRace(targetFile: string): Promise<{ hasFieldA: boolean; hasFieldB: boolean }> {
  const [workerA, workerB] = await Promise.all([
    forkWorker(targetFile, "fieldA", "from-worker-a"),
    forkWorker(targetFile, "fieldB", "from-worker-b"),
  ]);

  const doneA = waitForDone(workerA);
  const doneB = waitForDone(workerB);
  // Fire both "go" signals back-to-back with no await between them, to put
  // both workers' mutateYaml calls as close to simultaneous as two separate
  // OS processes can get.
  workerA.send("go");
  workerB.send("go");
  await Promise.all([doneA, doneB]);

  const finalContent = readFileSync(targetFile, "utf-8");
  const parsed = yaml.load(finalContent) as Record<string, unknown>;
  return { hasFieldA: parsed.fieldA === "from-worker-a", hasFieldB: parsed.fieldB === "from-worker-b" };
}

describe("mutateYaml cross-process concurrency", () => {
  it(
    `two real processes racing the same file both survive, across ${ITERATIONS} iterations`,
    async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "yaml-mutate-race-"));
      const targetFile = resolve(dir, "target.yaml");
      try {
        const losses: number[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          const { hasFieldA, hasFieldB } = await runOneRace(targetFile);
          if (!hasFieldA || !hasFieldB) losses.push(i);
        }
        expect(
          losses,
          `iterations where a writer's field was lost (empty = lock held under real cross-process contention): ${JSON.stringify(losses)}`,
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // Forking ~40 real tsx-loaded processes is slower than typical unit
    // tests — give it real headroom rather than tuning ITERATIONS down to
    // fit a tight default timeout.
    60_000,
  );
});
