import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const LOCK_DIR = resolve(import.meta.dirname, "..", ".prepare-pack-test.lock");
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withPreparePackLock<T>(action: () => T): T {
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(resolve(LOCK_DIR, "owner"), `${process.pid}\n`, "utf-8");
      break;
    } catch (error) {
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("等待 prepare-pack 测试锁超时", { cause: error });
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
