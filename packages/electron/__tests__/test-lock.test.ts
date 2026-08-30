import { ChildProcess, spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireElectronTestLock } from "./test-lock.js";

const root = resolve(import.meta.dirname, "..", "..", "..");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const childScript = resolve(import.meta.dirname, "test-lock-child.ts");
const children = new Map<ChildProcess, () => string>();
const fixtureDirs = new Set<string>();
const describeIfDarwin = process.platform === "darwin" ? describe : describe.skip;

type LockFixture = {
  dir: string;
  lockFile: string;
};

function createLockFixture(): LockFixture {
  const dir = mkdtempSync(join(tmpdir(), "electron-o-exlock-"));
  fixtureDirs.add(dir);
  return { dir, lockFile: join(dir, "lock") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(message);
}

function spawnLockChild(lockFile: string, finishFile: string, env: NodeJS.ProcessEnv = process.env): { child: ChildProcess; output: () => string; errors: () => string } {
  let output = "";
  let errors = "";
  const child = spawn(process.execPath, [tsx, childScript, finishFile], {
    cwd: root,
    env: { ...env, ELECTRON_TEST_LOCK_FILE: lockFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(child, () => output);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { errors += chunk.toString(); });
  return { child, output: () => output, errors: () => errors };
}

function reportedHolderPid(output: string): number | null {
  const match = output.match(/acquired (\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function reportedLockIdentity(output: string): { dev: number; ino: number } {
  const match = output.match(/acquired \d+ (\d+) (\d+)/);
  if (!match) throw new Error(`lock holder did not report its anchor inode: ${output}`);
  return { dev: Number.parseInt(match[1], 10), ino: Number.parseInt(match[2], 10) };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`child exit ${code}`)));
    child.once("error", rejectExit);
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", resolveExit));
}

async function terminateAndWait(child: ChildProcess, output: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const holderPid = reportedHolderPid(output());
  if (holderPid && holderPid !== child.pid) {
    try {
      process.kill(holderPid, "SIGKILL");
    } catch {
      // It may have exited between observation and teardown.
    }
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", resolveExit));
}

function readMaxActive(activityFile: string): number {
  let active = 0;
  let maxActive = 0;
  for (const event of readFileSync(activityFile, "utf8").trim().split("\n")) {
    active += event.startsWith("enter ") ? 1 : -1;
    maxActive = Math.max(maxActive, active);
  }
  return maxActive;
}

afterEach(async () => {
  await Promise.all([...children].map(([child, output]) => terminateAndWait(child, output)));
  children.clear();
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs.clear();
});

describeIfDarwin("Electron O_EXLOCK test lock", () => {
  it("keeps a contender out until the current owner releases", async () => {
    const fixture = createLockFixture();
    const ownerFinishFile = join(fixture.dir, "owner-finish");
    const contenderFinishFile = join(fixture.dir, "contender-finish");
    const owner = spawnLockChild(fixture.lockFile, ownerFinishFile);
    await waitFor(() => owner.output().includes("acquired"), `owner did not acquire: ${owner.errors()}`);
    const contender = spawnLockChild(fixture.lockFile, contenderFinishFile);
    await sleep(300);
    expect(contender.output()).not.toContain("acquired");

    const ownerExit = waitForExit(owner.child);
    writeFileSync(ownerFinishFile, "release");
    await ownerExit;
    await waitFor(() => contender.output().includes("acquired"), `contender did not acquire: ${contender.errors()}`);
    expect(reportedLockIdentity(contender.output())).toEqual(reportedLockIdentity(owner.output()));
    const contenderExit = waitForExit(contender.child);
    writeFileSync(contenderFinishFile, "release");
    await contenderExit;
  }, 20_000);

  it("automatically releases the kernel lock when its owner is SIGKILLed", async () => {
    const fixture = createLockFixture();
    const ownerFinishFile = join(fixture.dir, "owner-finish");
    const recoveryFinishFile = join(fixture.dir, "recovery-finish");
    const owner = spawnLockChild(fixture.lockFile, ownerFinishFile);
    await waitFor(() => owner.output().includes("acquired"), `owner did not acquire: ${owner.errors()}`);
    const ownerPid = reportedHolderPid(owner.output());
    const ownerIdentity = reportedLockIdentity(owner.output());
    expect(ownerPid).not.toBeNull();
    process.kill(ownerPid!, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(ownerPid!, 0);
        return false;
      } catch {
        return true;
      }
    }, "actual lock holder did not exit after SIGKILL");
    await waitForClose(owner.child);

    const recovery = spawnLockChild(fixture.lockFile, recoveryFinishFile);
    await waitFor(() => recovery.output().includes("acquired"), `recovery owner did not acquire: ${recovery.errors()}`);
    expect(reportedLockIdentity(recovery.output())).toEqual(ownerIdentity);
    const recoveryExit = waitForExit(recovery.child);
    writeFileSync(recoveryFinishFile, "release");
    await recoveryExit;
  }, 20_000);

  it("makes a repeated old release closure harmless after a new holder acquires", async () => {
    const fixture = createLockFixture();
    const firstRelease = await acquireElectronTestLock(fixture.lockFile);
    firstRelease();
    const secondRelease = await acquireElectronTestLock(fixture.lockFile);
    const contenderFinishFile = join(fixture.dir, "contender-finish");
    const contender = spawnLockChild(fixture.lockFile, contenderFinishFile);
    await sleep(300);
    expect(contender.output()).not.toContain("acquired");

    firstRelease();
    await sleep(300);
    expect(contender.output()).not.toContain("acquired");

    const contenderExit = waitForExit(contender.child);
    secondRelease();
    await waitFor(() => contender.output().includes("acquired"), `contender acquired before second holder release: ${contender.errors()}`);
    writeFileSync(contenderFinishFile, "release");
    await contenderExit;
  }, 20_000);

  it("serializes eight competing child processes with maxActive equal to one", async () => {
    const fixture = createLockFixture();
    const finishFile = join(fixture.dir, "finish");
    const activityFile = join(fixture.dir, "activity.log");
    const contenders = Array.from({ length: 8 }, () => spawnLockChild(fixture.lockFile, finishFile, {
      ...process.env,
      ELECTRON_TEST_LOCK_ACTIVITY_FILE: activityFile,
    }));
    await waitFor(() => contenders.some((contender) => contender.output().includes("acquired")), "no contender acquired");
    await sleep(300);
    expect(contenders.filter((contender) => contender.output().includes("acquired"))).toHaveLength(1);

    const exits = contenders.map((contender) => waitForExit(contender.child));
    writeFileSync(finishFile, "release all");
    await Promise.all(exits);
    expect(readMaxActive(activityFile)).toBe(1);
    expect(readFileSync(activityFile, "utf8").match(/^enter /gm)).toHaveLength(8);
  }, 20_000);
});
