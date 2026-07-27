/**
 * Opaque compact 持久化的**真实故障注入**测试。
 *
 * 与同目录的 opaque-compact-persistence.test.ts 分工：那边测同进程内可验证的
 * 逻辑不变量；这边专测只有跨进程才能成立的语义——
 *
 * - kill -9：必须真的 SIGKILL 一个持有 DB 连接和内核锁的进程；
 * - 单实例锁：必须由两个独立进程争用；
 * - 并发 CAS：两个进程读到同一 generation 后在 barrier 处同时放行；
 * - 密钥轮换：跨进程持久化 A:N → 轮换 → B:N+1；
 * - 隐私：扫描 DB/WAL/SHM 原始字节，marker 与 stateId 必须零命中。
 *
 * 之前版本的测试在这些点上全部是假覆盖（把全局 store 置 null 冒充崩溃、
 * 顺序调用冒充并发），本文件是对那批假覆盖的直接修正。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// 注意：本文件为每个用例派生 `node --import tsx` 子进程（都要重新编译 TS）。
// 峰值负载会与其它同样派生子进程的测试争抢 CPU。这里不改全局调度配置——
// 那会影响全仓测试语义、也不该混进产品候选；改为在本文件内自我约束：
// 同一时刻最多允许 MAX_CONCURRENT_CHILDREN 个子进程存活。
const MAX_CONCURRENT_CHILDREN = 2;
let liveChildren = 0;
const childWaiters: (() => void)[] = [];

async function acquireChildSlot(): Promise<void> {
  if (liveChildren < MAX_CONCURRENT_CHILDREN) {
    liveChildren += 1;
    return;
  }
  await new Promise<void>((resolvePromise) => childWaiters.push(resolvePromise));
  liveChildren += 1;
}

function releaseChildSlot(): void {
  liveChildren = Math.max(0, liveChildren - 1);
  childWaiters.shift()?.();
}

const ROOT = resolve(import.meta.dirname, "../../..");
const HARNESS = resolve(ROOT, "tests/unit/routes/opaque-compact-child-harness.mjs");

/** 子进程较慢（要经 tsx 编译 TS），给足超时但仍有上限。 */
const CHILD_TIMEOUT_MS = 90_000;

let dir: string;
/** 密钥环目录与 store 目录分离——生产要求密钥不与密文同卷。 */
let keyDir: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "opaque-fault-"));
  keyDir = `${dir}-keys`;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

interface HarnessResult {
  ok: boolean;
  ready?: boolean;
  reason?: string;
  marker?: string;
  generation?: number;
  outputJson?: string;
  preservedTailJson?: string;
  accountEntryId?: string;
  pid?: number;
  phase?: string;
  previousKeyId?: string;
  activeKeyId?: string;
}

function spawnHarness(command: string, payload: unknown = {}): ChildProcessWithoutNullStreams {
  liveChildren += 1;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", HARNESS, command, dir, JSON.stringify(payload)],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.once("close", () => releaseChildSlot());
  children.push(child);
  return child;
}

/** 运行到子进程自然退出，返回它输出的最后一行 JSON。 */
async function runHarness(command: string, payload: unknown = {}): Promise<HarnessResult> {
  await acquireChildSlot();
  releaseChildSlot(); // spawnHarness 自己记账，这里只做节流等待
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnHarness(command, payload);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`harness ${command} timed out; stderr=${stderr.slice(0, 400)}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.trim().split("\n").filter((line) => line.startsWith("{"));
      const last = lines.at(-1);
      if (last === undefined) {
        rejectPromise(new Error(`harness ${command} produced no JSON; stderr=${stderr.slice(0, 400)}`));
        return;
      }
      resolvePromise(JSON.parse(last) as HarnessResult);
    });
  });
}

/** 启动子进程并等它输出第一行 JSON（此时它仍在运行）。 */
function startHarnessAndWait(
  command: string,
  payload: unknown = {},
): Promise<{ child: ChildProcessWithoutNullStreams; first: HarnessResult }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnHarness(command, payload);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`harness ${command} never reported; stderr=${stderr.slice(0, 400)}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
      if (line !== undefined) {
        clearTimeout(timer);
        resolvePromise({ child, first: JSON.parse(line) as HarnessResult });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", () => {
      clearTimeout(timer);
      rejectPromise(new Error(`harness ${command} exited early; stderr=${stderr.slice(0, 400)}`));
    });
  });
}

/** 等待进程真正消失，而不是只发完信号就继续。 */
async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
}

function readAllBytes(target: string): Buffer {
  const chunks: Buffer[] = [];
  for (const name of readdirSync(target)) {
    const path = resolve(target, name);
    if (statSync(path).isDirectory()) {
      chunks.push(readAllBytes(path));
      continue;
    }
    chunks.push(readFileSync(path));
  }
  return Buffer.concat(chunks);
}

/** 从 marker 全文里取出 stateId 段。 */
function stateIdOf(marker: string): string {
  const match = /codex-opaque-state:v1:([A-Za-z0-9_-]{32}):/.exec(marker);
  if (match === null) throw new Error("marker does not contain a stateId");
  return match[1]!;
}

describe("opaque compact — 真实 kill -9 崩溃恢复", () => {
  it("SIGKILL 掉持有 DB 与内核锁的进程后，已 COMMIT 的 marker 仍可在新进程解析", async () => {
    const { child, first } = await startHarnessAndWait("save-and-hang");
    expect(first.ok).toBe(true);
    const marker = first.marker!;

    // 真正的 SIGKILL：没有 close()、没有 ROLLBACK、没有 WAL checkpoint，
    // DB 连接和 advisory lock 都由内核在进程死亡时回收。
    child.kill("SIGKILL");
    await waitForExit(child);
    expect(child.signalCode).toBe("SIGKILL");

    const restored = await runHarness("resolve", { marker });
    expect(restored.ready).toBe(true);
    expect(restored.ok).toBe(true);
    // 正确性来自 WAL + synchronous=FULL，而非任何优雅关闭路径。
    expect(JSON.parse(restored.outputJson!)).toEqual([
      { type: "reasoning", encrypted_content: "encrypted-content-canary-7a10", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "opaque-output-canary-c93e" }],
      },
    ]);
    expect(JSON.parse(restored.preservedTailJson!)).toHaveLength(2);
  }, 240_000);
});

describe("opaque compact — 跨进程单实例锁", () => {
  it("持有者存活时第二实例被拒；持有者被 SIGKILL 后立即可接管", async () => {
    const { child, first } = await startHarnessAndWait("hold-and-hang");
    expect(first.ok).toBe(true);

    // 独立进程争用：拿到的是内核 advisory lock，不是自制 PID 文件判断。
    const blocked = await runHarness("probe-readiness");
    expect(blocked.ready).toBe(false);
    expect(blocked.reason).toBe("store_locked");

    child.kill("SIGKILL");
    await waitForExit(child);

    // 内核随进程死亡释放锁，不需要任何 stale-timeout 破锁逻辑。
    const acquired = await runHarness("probe-readiness");
    expect(acquired.ready).toBe(true);
    expect(acquired.reason).toBeNull();
  }, 240_000);
});

describe("opaque compact — 真正并发的 generation CAS", () => {
  it("两个并发请求在 await 边界重叠、读到同一 generation，恰好一个 winner", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);
    const marker = seed.marker!;

    // 单实例锁保证同一 store 只能被一个进程持有，因此真实的并发 recompact
    // 只会发生在同一实例内的两个请求之间——harness 正是这样构造：两个竞争者
    // 都先读到同一个 generation（barrier），再各自提交。
    const race = await runHarness("cas-race", { marker });
    expect(race.ok).toBe(true);
    expect(race.phase).toBe("race-complete");
    // 断言两个请求确实在 await 边界重叠过——否则这就退化成顺序调用，
    // 证明不了任何竞态。
    expect((race as unknown as { readersOverlapped: boolean }).readersOverlapped).toBe(true);

    const results = (race as unknown as {
      results: { phase: string; reason?: string; generation?: number; marker?: string }[];
    }).results;
    const committed = results.filter((entry) => entry.phase === "committed");
    const rejected = results.filter((entry) => entry.phase === "rejected");

    // 线性化：恰好一个 winner。
    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("stale_generation");
    expect(committed[0]!.generation).toBe(seed.generation! + 1);

    // winner 的 marker 必须真实可用——落败方不得作废赢家刚返回的 marker。
    // 这正是旧实现（后完成者无条件删除同 binding 旧行）的回归点。
    const usable = await runHarness("resolve", { marker: committed[0]!.marker });
    expect(usable.ok).toBe(true);
    expect(usable.generation).toBe(seed.generation! + 1);
  }, 240_000);
});

describe("opaque compact — 密钥轮换跨进程", () => {
  it("A:N 轮换到 B 之后仍是唯一的 N+1，旧 marker 在保留窗口内仍可解析", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);
    expect(seed.generation).toBe(1);

    const indexRootBefore = (JSON.parse(readFileSync(resolve(keyDir, "keyring.json"), "utf-8")) as {
      indexRoot: string;
    }).indexRoot;

    const rotated = await runHarness("rotate");
    expect(rotated.ok).toBe(true);
    expect(rotated.activeKeyId).not.toBe(rotated.previousKeyId);

    // 旧 key 签发的 marker 必须仍然可验签、可解封（previous key 在保留窗口内）。
    const afterRotation = await runHarness("resolve", { marker: seed.marker });
    expect(afterRotation.ok).toBe(true);
    expect(afterRotation.generation).toBe(1);

    // 关键：索引域必须跨轮换稳定。若 indexKey 随 master key 一起轮换，新 key
    // 会算出不同的 binding，CAS 看不到 A:1，于是从 0 开始写出第二个 active ——
    // 这里断言 generation 恰好是 2（而不是 1），正是那条分裂路径的防线。
    const recompacted = await runHarness("save-and-close", {
      expectedGeneration: 1,
      predecessorStateId: stateIdOf(seed.marker!),
    });
    expect(recompacted.ok).toBe(true);
    expect(recompacted.generation).toBe(2);

    // 再用已被消费掉的 generation 提交必须落败，证明 DB 里只有单一 active 链。
    const stale = await runHarness("save-and-close", { expectedGeneration: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("stale_generation");

    // indexRoot 本身不得随轮换改变——直接读盘证明，不依赖间接推断。
    const keyring = JSON.parse(readFileSync(resolve(keyDir, "keyring.json"), "utf-8")) as {
      indexRoot: string;
      activeKeyId: string;
    };
    expect(keyring.activeKeyId).toBe(rotated.activeKeyId);
    expect(keyring.indexRoot).toBe(indexRootBefore);
  }, 300_000);
});

describe("opaque compact — 磁盘隐私合同", () => {
  it("DB/WAL/SHM 原始字节中 marker 全文与 stateId 均零命中", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);
    const marker = seed.marker!;
    const stateId = stateIdOf(marker);

    const bytes = readAllBytes(dir);
    // 冻结的隐私合同：marker 与 stateId 都不得以原文出现在任何持久化文件里。
    expect(bytes.includes(Buffer.from(marker)), "marker leaked to disk").toBe(false);
    expect(bytes.includes(Buffer.from(stateId)), "stateId leaked to disk").toBe(false);

    for (const canary of [
      "session-canary-8f2a",
      "entry-canary-51bd",
      "opaque-output-canary-c93e",
      "encrypted-content-canary-7a10",
      "preserved-tail-canary-2d64",
      "variant-canary-b7f3",
    ]) {
      expect(bytes.includes(Buffer.from(canary)), `${canary} leaked to disk`).toBe(false);
    }
  }, 240_000);
});

describe("opaque compact — 清零库不得伪装成首次初始化", () => {
  it("sentinel 存在而 DB 被清零时 fail-closed，而不是静默新建空库", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);

    // QA 探针确认：清零后的库 integrity_check 返回 ok，与全新空库不可区分。
    // 这正是"损坏被当成空库继续跑"的真实路径，必须由 DB 外的 sentinel 兜住。
    writeFileSync(resolve(dir, "state.db"), Buffer.alloc(0));
    rmSync(resolve(dir, "state.db-wal"), { force: true });
    rmSync(resolve(dir, "state.db-shm"), { force: true });

    const probed = await runHarness("probe-readiness");
    expect(probed.ready).toBe(false);
    expect(probed.reason).toBe("store_reset_detected");
  }, 240_000);

  it("keyring 丢失但 sentinel/DB 仍在时 fail-closed，绝不重新生成密钥", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);
    rmSync(resolve(keyDir, "keyring.json"));

    const probed = await runHarness("probe-readiness");
    expect(probed.ready).toBe(false);
    expect(probed.reason).toBe("key_unavailable");
    // 没有偷偷造一把新密钥把既有密文变成永久垃圾。
    expect(readdirSync(keyDir)).not.toContain("keyring.json");
  }, 240_000);
});

describe("opaque compact — 账号域隔离经生产解封路径", () => {
  it("换一个账号候选集合就解不开记录", async () => {
    const seed = await runHarness("save-and-close");
    expect(seed.ok).toBe(true);

    const wrongAccount = await runHarness("resolve", {
      marker: seed.marker,
      accountCandidates: ["entry-someone-else"],
    });
    // 数据密钥按账号派生：账号不对连解封都做不到，不是事后比较字段。
    expect(wrongAccount.ok).toBe(false);
    expect(wrongAccount.reason).toBe("account_mismatch");

    const rightAccount = await runHarness("resolve", { marker: seed.marker });
    expect(rightAccount.ok).toBe(true);
  }, 240_000);
});
