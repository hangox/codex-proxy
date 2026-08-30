import { appendFileSync, existsSync, statSync } from "fs";
import { acquireElectronTestLock } from "./test-lock.js";

async function main(): Promise<void> {
  const finishFile = process.argv[2];
  const lockFile = process.env.ELECTRON_TEST_LOCK_FILE;
  if (!finishFile) throw new Error("finish file is required");
  if (!lockFile) throw new Error("ELECTRON_TEST_LOCK_FILE is required");

  const release = await acquireElectronTestLock(lockFile);
  const activityFile = process.env.ELECTRON_TEST_LOCK_ACTIVITY_FILE;
  if (activityFile) appendFileSync(activityFile, `enter ${process.pid}\n`);
  const anchor = statSync(lockFile);
  process.stdout.write(`acquired ${process.pid} ${anchor.dev} ${anchor.ino}\n`);
  while (!existsSync(finishFile)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (activityFile) appendFileSync(activityFile, `exit ${process.pid}\n`);
  release();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
