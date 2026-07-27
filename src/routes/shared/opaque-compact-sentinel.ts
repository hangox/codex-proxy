/**
 * Store 身份 sentinel —— DB 之外的存在性证据。
 *
 * 为什么需要：QA 的运行时探针确认，把 SQLite 库整个清零之后
 * `PRAGMA integrity_check` 仍返回 ok，且 user_version=0，与一个全新空库
 * **完全不可区分**。也就是说"库被清零/删除"会静默退化成"首次初始化"，
 * 悄悄丢掉所有既有 state 而不报任何错。
 *
 * 因此 store 身份必须存在于 DB 之外：sentinel 文件记录 storeId，DB 的 meta
 * 表里也存同一个 storeId。三种组合的判定：
 *
 * | sentinel | DB schema | 判定                                    |
 * |----------|-----------|-----------------------------------------|
 * | 无       | 无        | 真正的首次初始化 → 允许创建             |
 * | 有       | 有且匹配  | 正常启动                                |
 * | 有       | 无/不匹配 | **库被清零或换掉 → fail-closed**        |
 *
 * sentinel 与 keyring 同为关键 durable commit，写入方式一致（fsync + rename + 目录 fsync）。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const OPAQUE_SENTINEL_VERSION = 1;

export type OpaqueCompactSentinelFailure = "sentinel_invalid" | "sentinel_write_failed";

export class OpaqueCompactSentinelError extends Error {
  constructor(readonly reason: OpaqueCompactSentinelFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactSentinelError";
  }
}

export interface OpaqueCompactSentinel {
  storeId: string;
  /** true 表示本次调用刚刚创建了 sentinel（即真正的首次初始化）。 */
  created: boolean;
}

interface StoredSentinel {
  version: number;
  storeId: string;
  createdAt: number;
}

function writeSentinelAtomically(path: string, sentinel: StoredSentinel): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.${randomBytes(8).toString("hex")}.sentinel.tmp`);
  const payload = `${JSON.stringify(sentinel, null, 2)}\n`;

  const fail = (error: unknown): never => {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new OpaqueCompactSentinelError(
      "sentinel_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  };

  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, payload, 0, "utf-8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    return fail(error);
  }
  try {
    closeSync(fd);
  } catch (error) {
    return fail(error);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    return fail(error);
  }
  // 目录 fsync 失败不吞：sentinel 丢失会让下一次启动误判为首次初始化。
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch (error) {
    throw new OpaqueCompactSentinelError(
      "sentinel_write_failed",
      `sentinel directory fsync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
 * 加载或创建 sentinel。
 * `allowCreate=false` 且 sentinel 不存在时返回 null，由调用方决定如何处理。
 */
export function loadOpaqueCompactSentinel(
  sentinelFile: string,
  options: { allowCreate: boolean; now?: () => number },
): OpaqueCompactSentinel | null {
  const now = options.now ?? Date.now;

  if (!existsSync(sentinelFile)) {
    if (!options.allowCreate) return null;
    const created: StoredSentinel = {
      version: OPAQUE_SENTINEL_VERSION,
      storeId: randomBytes(16).toString("hex"),
      createdAt: now(),
    };
    writeSentinelAtomically(sentinelFile, created);
    return { storeId: created.storeId, created: true };
  }

  const stats = lstatSync(sentinelFile);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new OpaqueCompactSentinelError("sentinel_invalid", "sentinel path is not a regular file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sentinelFile, "utf-8"));
  } catch {
    throw new OpaqueCompactSentinelError("sentinel_invalid", "sentinel is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpaqueCompactSentinelError("sentinel_invalid", "sentinel must be a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== OPAQUE_SENTINEL_VERSION) {
    throw new OpaqueCompactSentinelError(
      "sentinel_invalid",
      `unsupported sentinel version ${String(candidate.version)}`,
    );
  }
  if (typeof candidate.storeId !== "string" || candidate.storeId.length === 0) {
    throw new OpaqueCompactSentinelError("sentinel_invalid", "sentinel storeId missing");
  }
  return { storeId: candidate.storeId, created: false };
}
