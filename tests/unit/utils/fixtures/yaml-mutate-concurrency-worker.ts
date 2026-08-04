/**
 * Worker process for yaml-mutate-concurrency.test.ts.
 *
 * Deliberately a real, standalone forked process (not a same-process async
 * simulation) — see that test file's header comment for why: a same-process
 * simulation cannot reproduce the race `mutateYaml`'s lock is meant to
 * prevent, because Node's single-threaded run-to-completion semantics mean
 * two "concurrent" calls in one process never actually interleave inside
 * `mutateYaml`'s synchronous body. Only two real OS processes racing the
 * same file can exercise the lock's cross-process path.
 *
 * Usage: fork(this file, [targetFilePath, fieldName, fieldValue]).
 * Protocol: waits for a "go" IPC message before calling mutateYaml (so the
 * parent can line up both workers as close to simultaneously as possible),
 * sends "ready" once it's loaded and waiting, and "done" once the write
 * completes (or "error" with a message on failure).
 */

import { mutateYaml } from "../../../../src/utils/yaml-mutate.js";

const [, , targetFilePath, fieldName, fieldValue] = process.argv;

if (!targetFilePath || !fieldName || !fieldValue) {
  throw new Error("usage: worker.ts <targetFilePath> <fieldName> <fieldValue>");
}

process.on("message", (msg) => {
  if (msg !== "go") return;
  mutateYaml(targetFilePath, (data) => {
    data[fieldName] = fieldValue;
  })
    .then(() => {
      process.send?.("done");
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.send?.(`error:${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
});

process.send?.("ready");
