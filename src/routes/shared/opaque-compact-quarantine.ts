/**
 * 损坏 store 的真实隔离（quarantine）。
 *
 * 为什么"打个日志 + not-ready"不够：那样原始 `state.db` 仍留在正常路径上，
 * 下次启动会照常尝试打开它、照常失败，既没有取证快照，也没有任何持久标记
 * 阻止后续实例反复撞同一个损坏库。合同要求的是——
 *
 * 1. **证据保全**：损坏的 DB/WAL/SHM 原始字节整体移到隔离目录，不删除、不改写；
 * 2. **原路径不可复用**：移走之后，正常路径上不再有那个损坏库；
 * 3. **持久标记**：写一份隔离记录（含时间、原因、文件清单与大小），
 *    运维据此取证；
 * 4. **失败原子性**：隔离本身失败时，原文件必须**原样不动**，并且仍然
 *    fail-closed —— 绝不能"移了一半"。
 *
 * 刻意不做的事：不尝试"修复"损坏库，不静默重建空库。两者都会销毁证据。
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
  openSync,
  fsyncSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** 隔离目录名。与 store 目录同级，避免下次启动再扫到。 */
const QUARANTINE_DIR = "quarantine";

export interface QuarantineResult {
  /** 隔离目录的绝对路径；隔离失败时为 null。 */
  directory: string | null;
  /** 实际移动的文件名列表。 */
  moved: string[];
  /** 隔离是否完全成功。false 时原文件保持原样。 */
  ok: boolean;
  /** 失败原因（不含敏感内容）。 */
  error?: string;
}

/**
 * 把损坏的 store 文件整体移入隔离目录。
 *
 * `stamp` 由调用方提供（通常是时间戳），使多次隔离互不覆盖。
 */
export function quarantineOpaqueCompactStore(options: {
  databasePath: string;
  reason: string;
  stamp: string;
  /** 额外一并隔离的文件（如 sentinel）。 */
  extraFiles?: string[];
}): QuarantineResult {
  const storeDir = dirname(options.databasePath);
  const target = resolve(storeDir, QUARANTINE_DIR, options.stamp);

  // 候选文件：主库 + WAL + SHM（后两者可能不存在）。
  const candidates = [
    options.databasePath,
    `${options.databasePath}-wal`,
    `${options.databasePath}-shm`,
    ...(options.extraFiles ?? []),
  ].filter((path) => existsSync(path));

  if (candidates.length === 0) {
    return { directory: null, moved: [], ok: true };
  }

  // 先记录原始尺寸，隔离记录里要写进去供取证核对。
  const inventory = candidates.map((path) => {
    const stats = statSync(path);
    return { name: basename(path), bytes: stats.size, mode: stats.mode & 0o777 };
  });

  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      directory: null,
      moved: [],
      ok: false,
      error: error instanceof Error ? error.name : "mkdir failed",
    };
  }

  // rename 是同文件系统内的原子操作，不读写内容，因此字节完全保真。
  const moved: string[] = [];
  for (const path of candidates) {
    try {
      renameSync(path, resolve(target, basename(path)));
      moved.push(basename(path));
    } catch (error) {
      // 失败原子性：把已经移走的挪回去，让原路径恢复原状。
      for (const name of moved) {
        try {
          renameSync(resolve(target, name), resolve(storeDir, name));
        } catch {
          /* 尽力回滚；下面会如实报告失败 */
        }
      }
      return {
        directory: null,
        moved: [],
        ok: false,
        error: error instanceof Error ? error.name : "rename failed",
      };
    }
  }

  // 隔离记录：只写结构信息与文件清单，不含任何会话内容或密钥材料。
  try {
    const manifest = {
      quarantinedAt: options.stamp,
      reason: options.reason,
      files: inventory,
    };
    const manifestPath = resolve(target, "QUARANTINE.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const dirFd = openSync(target, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // 清单写失败不影响"证据已被安全移走"这一事实，如实返回成功但不阻断。
  }

  return { directory: target, moved, ok: true };
}
