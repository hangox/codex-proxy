/**
 * Opaque compact state store 的单实例独占锁。
 *
 * 设计意图：SQLite WAL 支持多进程并发写，但本功能的 generation CAS 语义
 * 建立在"同一时刻只有一个实例在决定哪个 generation 是 active"之上。多实例
 * 同时开启会让两个进程各自认为自己的 CAS 成功，从而把对方刚返回给客户端的
 * marker 静默作废。因此第二实例必须**拒绝开启 opaque 功能**，而不是共享写入。
 *
 * 与 refresh-lock 的差别：不能仅按时间戳 break 一个"看起来很旧"的锁 —— 长
 * 时间空闲的实例仍然合法持有 store。这里记录 pid + 启动 nonce，只有在持有者
 * 进程确认已不存在时才回收。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface OpaqueCompactStoreLockHandle {
  readonly path: string;
  readonly pid: number;
  readonly nonce: string;
  release(): void;
}

interface LockPayload {
  pid: number;
  nonce: string;
  acquiredAt: number;
}

export class OpaqueCompactStoreLockError extends Error {
  constructor(readonly reason: "store_locked" | "store_unavailable", message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactStoreLockError";
  }
}

function readLockPayload(path: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.pid !== "number" || typeof candidate.nonce !== "string") return null;
    const acquiredAt = typeof candidate.acquiredAt === "number" ? candidate.acquiredAt : 0;
    return { pid: candidate.pid, nonce: candidate.nonce, acquiredAt };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 只做存在性/权限探测，不投递信号。
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于当前用户 → 视为存活，不可回收。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeLockFile(path: string, payload: LockPayload): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(payload), 0, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 获取 store 独占锁。失败即 `store_locked`，调用方必须让 opaque 功能保持
 * not-ready，而不是降级共享写入。
 */
export function acquireOpaqueCompactStoreLock(
  lockPath: string,
  options: { now?: () => number } = {},
): OpaqueCompactStoreLockHandle {
  const now = options.now ?? Date.now;
  const nonce = randomBytes(12).toString("hex");
  const payload: LockPayload = { pid: process.pid, nonce, acquiredAt: now() };

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw new OpaqueCompactStoreLockError(
      "store_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }

  const attempt = (allowReclaim: boolean): OpaqueCompactStoreLockHandle => {
    try {
      writeLockFile(lockPath, payload);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new OpaqueCompactStoreLockError(
          "store_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      const existing = readLockPayload(lockPath);
      // 无法解析的锁文件视为陈旧残留（崩溃时写了一半），可回收一次。
      const reclaimable = existing === null || !processAlive(existing.pid);
      if (!allowReclaim || !reclaimable) {
        throw new OpaqueCompactStoreLockError(
          "store_locked",
          existing
            ? `opaque compact store is held by pid ${existing.pid}`
            : "opaque compact store lock is held",
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // 竞争者可能已经删了；直接进入不可回收的最后一次尝试。
      }
      return attempt(false);
    }
    return {
      path: lockPath,
      pid: payload.pid,
      nonce: payload.nonce,
      release: () => releaseLock(lockPath, payload.nonce),
    };
  };

  return attempt(true);
}

/** 只释放自己持有的锁：nonce 不匹配说明锁已被别人重新获取，不能删。 */
function releaseLock(lockPath: string, nonce: string): void {
  if (!existsSync(lockPath)) return;
  const existing = readLockPayload(lockPath);
  if (existing !== null && existing.nonce !== nonce) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已被删除即可 */
  }
}
