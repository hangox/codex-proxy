/**
 * Opaque compact state store 的单实例独占锁。
 *
 * 设计意图：generation CAS 的正确性建立在"同一时刻只有一个实例在决定哪个
 * generation 是 active"之上。两个实例同时开启会让双方各自认为 CAS 成功，
 * 把对方刚返回给客户端的 marker 静默作废。因此第二实例必须**拒绝开启 opaque
 * 功能**，而不是共享写入。
 *
 * 实现选择：用一个独立 SQLite 库上长期持有的 `BEGIN EXCLUSIVE` 事务作为锁。
 * 这拿到的是内核 POSIX advisory lock，具备自制 PID 锁不可能有的两个性质：
 *
 * - 持有者进程消失（含 SIGKILL）时由内核自动释放，无需任何清理代码；
 * - 不存在 "读到死亡 owner → unlink → 重建" 的 TOCTOU 窗口，也不受 PID 复用影响。
 *
 * 实测（Node 22.22.2 / macOS）：持有者存活时争用方稳定得到
 * `ERR_SQLITE_ERROR errcode=5 database is locked`；持有者被 SIGKILL 后，
 * 下一个进程立即获取成功。
 *
 * 刻意不做的事：
 * - 不做 stale-timeout 破锁。长时间空闲的实例仍然合法持有 store，按时间破锁
 *   会误杀活实例（这正是 refresh-lock.ts 的模式不能照搬到这里的原因）。
 * - 不用主 state 库自身的 EXCLUSIVE 事务当锁：那会阻塞本实例自己的读。
 *   锁库与 store 事务库严格分离。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

export interface OpaqueCompactStoreLockHandle {
  readonly path: string;
  release(): void;
}

export class OpaqueCompactStoreLockError extends Error {
  constructor(readonly reason: "store_locked" | "store_unavailable", message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactStoreLockError";
  }
}

/** SQLITE_BUSY。争用锁时的期望错误码。 */
const SQLITE_BUSY = 5;

function isBusyError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { errcode?: unknown; message?: unknown };
  if (candidate.errcode === SQLITE_BUSY) return true;
  return typeof candidate.message === "string" && candidate.message.includes("database is locked");
}

/**
 * 获取 store 独占锁。
 *
 * 返回的 handle 内部持有一个未提交的 EXCLUSIVE 事务；只要 handle 不 release，
 * 锁就一直有效，而进程一旦消失内核会立即回收。
 */
export function acquireOpaqueCompactStoreLock(lockPath: string): OpaqueCompactStoreLockHandle {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw new OpaqueCompactStoreLockError(
      "store_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 锁文件必须是普通文件：symlink 会把独占语义指到别处。
  try {
    const stats = lstatSync(lockPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new OpaqueCompactStoreLockError(
        "store_unavailable",
        "lock path is not a regular file",
      );
    }
  } catch (error) {
    if (error instanceof OpaqueCompactStoreLockError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OpaqueCompactStoreLockError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    // ENOENT 是首次启动的正常情况。
  }

  let db: DatabaseSync;
  {
    // 与 repository 同理：打开成功但后续语句失败时，必须自己关闭连接，
    // 否则调用方拿不到 handle 也就无从释放，fd 会泄漏。
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(lockPath);
      // busy_timeout=0：争用时立刻失败，不要等待。第二实例应当明确拒绝启动，
      // 而不是挂在这里让运维以为进程卡死。
      opened.exec("PRAGMA busy_timeout = 0");
      opened.exec("CREATE TABLE IF NOT EXISTS opaque_store_lock (id INTEGER PRIMARY KEY)");
      db = opened;
    } catch (error) {
      if (opened !== null) {
        try {
          opened.close();
        } catch {
          /* ignore */
        }
      }
      if (isBusyError(error)) {
        throw new OpaqueCompactStoreLockError(
          "store_locked",
          "another instance holds the opaque compact store",
        );
      }
      throw new OpaqueCompactStoreLockError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  try {
    // 长期持有的写事务 = 内核 advisory lock。写一行确保真正进入 EXCLUSIVE
    // 状态：仅 BEGIN EXCLUSIVE 在某些版本下可能延迟到首次写才实际取锁。
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("INSERT OR REPLACE INTO opaque_store_lock (id) VALUES (1)").run();
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (isBusyError(error)) {
      throw new OpaqueCompactStoreLockError(
        "store_locked",
        "another instance holds the opaque compact store",
      );
    }
    throw new OpaqueCompactStoreLockError(
      "store_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }

  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务可能已因关闭而结束 */
      }
      try {
        db.close();
      } catch {
        /* 关闭失败不影响正确性：进程退出时内核也会释放 */
      }
    },
  };
}

/**
 * 只读探测锁状态，供 readiness/健康检查使用，不获取锁。
 *
 * 返回结构化结果而非 boolean：把"锁库损坏/权限不足"折叠成 `held=false`
 * 会让 readiness 把不可用误报成空闲，正好是 fail-closed 的反面。
 */
export function probeOpaqueCompactStoreLock(lockPath: string): {
  held: boolean;
  unavailable: boolean;
  reason?: string;
} {
  try {
    statSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { held: false, unavailable: false };
    }
    return { held: false, unavailable: true, reason: "lock path is not accessible" };
  }
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(lockPath);
    probe.exec("PRAGMA busy_timeout = 0");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    return { held: false, unavailable: false };
  } catch (error) {
    if (isBusyError(error)) return { held: true, unavailable: false };
    // 损坏、权限、非 SQLite 文件等都属于"锁不可用"，绝不能当作未占用。
    return {
      held: false,
      unavailable: true,
      reason: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}
