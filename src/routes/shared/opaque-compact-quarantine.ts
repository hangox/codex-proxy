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
 *
 * ── active marker（QUARANTINED.json）─────────────────────────
 *
 * 光把损坏库移走还不够：原路径此刻是"什么都没有"，与全新部署不可区分。
 * 下一次启动会走 sentinel 判定，运气好是 store_reset_detected，运气不好
 * （sentinel 也被一并清掉）就是**重新建一个正常空库**，隔离等于白做。
 *
 * 因此隔离完成后要在 store 根目录留一枚**持久 active marker**：记录 storeId、
 * 原因、首次隔离时间与快照标识。runtime 在创建/打开任何 DB 之前先读它——
 * storeId 匹配就直接 NOT_READY 并返回逐字稳定的 reason，既不建库也不再产生
 * 第二份快照。marker 本身损坏一律 fail-closed（宁可停机也不能绕过隔离）；
 * storeId 不匹配则说明这是另一份全新 store，不应被上一份的隔离连坐。
 *
 * 写入顺序是刻意的：**先移文件、再写清单、最后原子写 marker**。marker 一旦
 * 出现就代表"证据已经安全落位"；中途崩溃只会缺 marker（下次启动仍 fail-closed，
 * 因为正常路径上已经没有可用的库），绝不会出现"marker 在、证据不在"。
 */

import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  closeSync,
  openSync,
  fsyncSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

/** 隔离目录名。与 store 目录同级，避免下次启动再扫到。 */
const QUARANTINE_DIR = "quarantine";

/** store 根目录下的持久 active marker 文件名。 */
export const QUARANTINE_MARKER_FILE = "QUARANTINED.json";

/** active marker 格式版本。任何字段语义变更都必须 +1。 */
export const QUARANTINE_MARKER_VERSION = 1;

export type OpaqueCompactQuarantineFailure =
  /** marker 存在但不可解析/字段畸形 —— 必须 fail-closed。 */
  | "quarantine_marker_invalid"
  /** marker 有效且指向当前 store —— store 已被隔离，禁止再打开。 */
  | "quarantine_active";

export class OpaqueCompactQuarantineError extends Error {
  constructor(readonly reason: OpaqueCompactQuarantineFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactQuarantineError";
  }
}

/** 持久 active marker 的内容。只含结构信息，不含任何会话内容或密钥材料。 */
export interface ActiveQuarantineMarker {
  version: number;
  /** 被隔离的 store 身份。与 sentinel 的 storeId 比对，避免连坐另一份新 store。 */
  storeId: string;
  /** 隔离原因（稳定枚举串，如 recover_unreadable）。 */
  reason: string;
  /** **首次**隔离时间。后续重启不得改写它。 */
  quarantinedAt: string;
  /** 快照标识：相对 store 根目录的路径。 */
  snapshot: string;
  /** 快照中保全的文件名列表。 */
  files: string[];
}

export interface QuarantineResult {
  /** 隔离目录的绝对路径；隔离失败时为 null。 */
  directory: string | null;
  /** 实际移动的文件名列表。 */
  moved: string[];
  /** 隔离是否完全成功。false 时原文件保持原样。 */
  ok: boolean;
  /** active marker 是否已经落盘。 */
  markerWritten: boolean;
  /** 失败原因（不含敏感内容）。 */
  error?: string;
}

/** 与 sentinel/keyring 一致的持久化写法：tmp + fsync + rename + 目录 fsync。 */
function writeMarkerAtomically(path: string, marker: ActiveQuarantineMarker): void {
  const dir = dirname(path);
  const tmp = resolve(dir, `.${randomBytes(8).toString("hex")}.quarantine.tmp`);
  const payload = `${JSON.stringify(marker, null, 2)}\n`;

  let fd: number | null = null;
  try {
    // wx 保证 tmp 一定是自己新建的；最终 rename 原子替换目标。
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, payload, 0, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    // 半成品 tmp 绝不能留在 store 根目录里。
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }

  // 目录 fsync：marker 丢失会让下次启动重新建库，隔离等于失效。
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } finally {
    if (dirFd !== null) {
      try {
        closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 读取 store 根目录下的 active quarantine marker。
 *
 * 返回 null 只代表"没有 marker"。marker 存在但不可信一律抛
 * `quarantine_marker_invalid`：忽略一个读不懂的隔离标记然后继续建库，
 * 正是隔离机制最不能出现的失败模式。
 */
export function readActiveQuarantineMarker(storeDir: string): ActiveQuarantineMarker | null {
  const path = resolve(storeDir, QUARANTINE_MARKER_FILE);
  if (!existsSync(path)) return null;

  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new OpaqueCompactQuarantineError(
      "quarantine_marker_invalid",
      "quarantine marker path is not a regular file",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new OpaqueCompactQuarantineError(
      "quarantine_marker_invalid",
      "quarantine marker is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpaqueCompactQuarantineError(
      "quarantine_marker_invalid",
      "quarantine marker must be a JSON object",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== QUARANTINE_MARKER_VERSION) {
    throw new OpaqueCompactQuarantineError(
      "quarantine_marker_invalid",
      `unsupported quarantine marker version ${String(candidate.version)}`,
    );
  }
  for (const field of ["storeId", "reason", "quarantinedAt", "snapshot"]) {
    const value = candidate[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new OpaqueCompactQuarantineError(
        "quarantine_marker_invalid",
        `quarantine marker ${field} is missing`,
      );
    }
  }
  if (
    !Array.isArray(candidate.files) ||
    candidate.files.some((entry) => typeof entry !== "string")
  ) {
    throw new OpaqueCompactQuarantineError(
      "quarantine_marker_invalid",
      "quarantine marker files must be a string array",
    );
  }
  return candidate as unknown as ActiveQuarantineMarker;
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
  /** 被隔离 store 的身份，写进 active marker 供后续启动比对。 */
  storeId: string;
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
    return { directory: null, moved: [], ok: true, markerWritten: false };
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
      markerWritten: false,
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
        markerWritten: false,
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

  // 最后一步：原子写 active marker。它必须在证据落位之后才出现，
  // 这样"marker 存在"就等价于"损坏库已经被安全保全"。
  let markerWritten = false;
  try {
    writeMarkerAtomically(resolve(storeDir, QUARANTINE_MARKER_FILE), {
      version: QUARANTINE_MARKER_VERSION,
      storeId: options.storeId,
      reason: options.reason,
      quarantinedAt: options.stamp,
      snapshot: `${QUARANTINE_DIR}/${options.stamp}`,
      files: moved,
    });
    markerWritten = true;
  } catch {
    // marker 写失败不回滚已经完成的隔离：证据保全优先。此时正常路径上已经
    // 没有库，下一次启动仍会 fail-closed（sentinel 在、DB 无 schema），
    // 只是拿不到"已隔离"这个更精确的原因。
  }

  return { directory: target, moved, ok: true, markerWritten };
}
