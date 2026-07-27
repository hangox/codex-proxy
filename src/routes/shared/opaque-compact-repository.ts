/**
 * Opaque compact state 的 SQLite WAL 持久化仓库。
 *
 * 设计意图：marker 必须跨重启存活，但磁盘上不能出现任何可读的会话内容。
 * 因此这一层只做三件事：
 * 1. 把整条 state 序列化成一个密文块（AEAD），落到 SQLite；
 * 2. 用 HMAC 折叠后的 binding 做索引，磁盘上看不到 session / model / variant 明文；
 * 3. 用 generation CAS 在**同一个事务**里完成"写新代 → 激活新代 → 废止旧代"，
 *    并且只有 COMMIT 成功之后调用方才被允许把 marker 交给客户端。
 *
 * 关键取舍：宁可 fail-closed 也不返回半可信状态。密钥不对、AAD 不匹配、
 * schema 不认识、binding 对不上——一律抛错，绝不静默清空或降级。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  computeIndexBinding,
  openRecord,
  sealRecord,
  type OpaqueCompactKey,
  type OpaqueCompactKeyring,
} from "./opaque-compact-keyring.js";

/** 记录 schema 版本。任何不兼容的列变更都必须 +1。 */
export const OPAQUE_REPOSITORY_SCHEMA_VERSION = 1;

export type OpaqueCompactRepositoryFailure =
  | "store_unavailable"
  | "schema_unsupported"
  | "key_mismatch"
  | "state_corrupt"
  | "stale_generation"
  | "binding_mismatch";

export class OpaqueCompactRepositoryError extends Error {
  constructor(readonly reason: OpaqueCompactRepositoryFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactRepositoryError";
  }
}

export interface OpaqueCompactRecordMeta {
  stateId: string;
  keyId: string;
  binding: string;
  generation: number;
  createdAt: number;
  expiresAt: number;
  byteSize: number;
}

export interface OpaqueCompactStoredRecord extends OpaqueCompactRecordMeta {
  payload: Buffer;
}

export interface OpaqueCompactRepositoryOptions {
  databasePath: string;
  keyring: OpaqueCompactKeyring;
  capacity: number;
  maxBytes: number;
  now?: () => number;
}

interface RecordRow {
  state_id: string;
  key_id: string;
  binding: string;
  generation: number;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  byte_size: number;
  nonce: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * AAD 把记录钉死在 (schema, key, stateId, generation, binding) 上。
 * 任何一项被篡改——包括把别的 session 的密文搬到本行——都会解封失败。
 */
function buildAad(
  keyId: string,
  stateId: string,
  generation: number,
  binding: string,
): Buffer {
  return Buffer.from(
    `codex-opaque-state:v${OPAQUE_REPOSITORY_SCHEMA_VERSION}\x00${keyId}\x00${stateId}\x00${generation}\x00${binding}`,
    "utf-8",
  );
}

export class OpaqueCompactRepository {
  private readonly db: DatabaseSync;
  private readonly keyring: OpaqueCompactKeyring;
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  private readonly stmtInsert: StatementSync;
  private readonly stmtDeleteBindingOthers: StatementSync;
  private readonly stmtSelectActiveGeneration: StatementSync;
  private readonly stmtSelectById: StatementSync;
  private readonly stmtDeleteById: StatementSync;
  private readonly stmtTouch: StatementSync;
  private readonly stmtDeleteExpired: StatementSync;
  private readonly stmtTotals: StatementSync;
  private readonly stmtOldest: StatementSync;
  private readonly stmtAllIds: StatementSync;

  constructor(options: OpaqueCompactRepositoryOptions) {
    this.keyring = options.keyring;
    this.capacity = options.capacity;
    this.maxBytes = options.maxBytes;
    this.now = options.now ?? Date.now;

    if (options.databasePath !== ":memory:") {
      try {
        mkdirSync(dirname(options.databasePath), { recursive: true });
      } catch (error) {
        throw new OpaqueCompactRepositoryError(
          "store_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    try {
      this.db = new DatabaseSync(options.databasePath);
      // WAL + FULL：崩溃后仍能恢复到最后一次 COMMIT，marker 不会指向不存在的记录。
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.initSchema();
    } catch (error) {
      if (error instanceof OpaqueCompactRepositoryError) throw error;
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }

    this.stmtInsert = this.db.prepare(
      `INSERT INTO opaque_states
         (state_id, key_id, binding, generation, created_at, expires_at, last_used_at,
          byte_size, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteBindingOthers = this.db.prepare(
      "DELETE FROM opaque_states WHERE binding = ? AND state_id <> ?",
    );
    this.stmtSelectActiveGeneration = this.db.prepare(
      "SELECT MAX(generation) AS generation FROM opaque_states WHERE binding = ?",
    );
    this.stmtSelectById = this.db.prepare("SELECT * FROM opaque_states WHERE state_id = ?");
    this.stmtDeleteById = this.db.prepare("DELETE FROM opaque_states WHERE state_id = ?");
    this.stmtTouch = this.db.prepare(
      "UPDATE opaque_states SET last_used_at = ? WHERE state_id = ?",
    );
    this.stmtDeleteExpired = this.db.prepare("DELETE FROM opaque_states WHERE expires_at <= ?");
    this.stmtTotals = this.db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM opaque_states",
    );
    this.stmtOldest = this.db.prepare(
      "SELECT state_id FROM opaque_states ORDER BY last_used_at ASC, created_at ASC LIMIT 1",
    );
    this.stmtAllIds = this.db.prepare("SELECT state_id FROM opaque_states");
  }

  private initSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    );
    const existing = this.db
      .prepare("SELECT value FROM opaque_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (existing === undefined) {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS opaque_states (
           state_id     TEXT PRIMARY KEY,
           key_id       TEXT NOT NULL,
           binding      TEXT NOT NULL,
           generation   INTEGER NOT NULL,
           created_at   INTEGER NOT NULL,
           expires_at   INTEGER NOT NULL,
           last_used_at INTEGER NOT NULL,
           byte_size    INTEGER NOT NULL,
           nonce        BLOB NOT NULL,
           tag          BLOB NOT NULL,
           ciphertext   BLOB NOT NULL
         )`,
      );
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_binding ON opaque_states (binding)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_expires ON opaque_states (expires_at)");
      this.db
        .prepare("INSERT INTO opaque_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
      return;
    }
    const version = Number(existing.value);
    if (!Number.isInteger(version) || version !== OPAQUE_REPOSITORY_SCHEMA_VERSION) {
      // 向前兼容不成立时必须停机而不是猜测列布局：旧版本回滚遇到新 schema
      // 只会读到无法解析的记录，静默继续等于数据损坏。
      throw new OpaqueCompactRepositoryError(
        "schema_unsupported",
        `unsupported opaque state schema version ${existing.value}`,
      );
    }
  }

  /** 计算索引绑定。使用 active key，轮换后旧记录靠自身 key_id 解析。 */
  bindingFor(key: OpaqueCompactKey, sessionId: string, model: string, variantHash: string): string {
    return computeIndexBinding(key, `${sessionId}\x00${model}\x00${variantHash}`);
  }

  /** 当前 binding 的 active generation；没有记录时为 0。 */
  currentGeneration(binding: string): number {
    const row = this.stmtSelectActiveGeneration.get(binding) as
      | { generation: number | null }
      | undefined;
    const value = row?.generation ?? 0;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * 在单个事务里：CAS 校验 → 写入新 generation → 删除该 binding 的旧代 → TTL/LRU 修剪。
   * 只有本方法正常返回（COMMIT 成功）后，调用方才可以把 marker 发给客户端。
   */
  saveWithCas(options: {
    stateId: string;
    binding: string;
    expectedGeneration: number;
    plaintext: Buffer;
    createdAt: number;
    expiresAt: number;
  }): { generation: number; keyId: string; byteSize: number } {
    const key = this.keyring.active();
    const generation = options.expectedGeneration + 1;
    const aad = buildAad(key.id, options.stateId, generation, options.binding);
    const sealed = sealRecord(key, aad, options.plaintext);
    const byteSize = sealed.ciphertext.length + sealed.nonce.length + sealed.tag.length;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.currentGeneration(options.binding);
      if (current !== options.expectedGeneration) {
        throw new OpaqueCompactRepositoryError("stale_generation");
      }
      this.stmtInsert.run(
        options.stateId,
        key.id,
        options.binding,
        generation,
        options.createdAt,
        options.expiresAt,
        options.createdAt,
        byteSize,
        sealed.nonce,
        sealed.tag,
        sealed.ciphertext,
      );
      // 同事务内废止旧代：重复 compact 之后老 marker 立即失效，不留悬挂状态。
      this.stmtDeleteBindingOthers.run(options.binding, options.stateId);
      this.pruneWithinTransaction(options.createdAt, options.stateId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      if (error instanceof OpaqueCompactRepositoryError) throw error;
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return { generation, keyId: key.id, byteSize };
  }

  /** 读取并解封。失败一律抛错；过期记录顺带删除。 */
  load(stateId: string, expectedBinding: string | null): {
    plaintext: Buffer;
    meta: OpaqueCompactRecordMeta;
  } | null {
    const row = this.stmtSelectById.get(stateId) as RecordRow | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= this.now()) {
      this.stmtDeleteById.run(stateId);
      return null;
    }
    if (expectedBinding !== null && row.binding !== expectedBinding) {
      throw new OpaqueCompactRepositoryError("binding_mismatch");
    }
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      // 密钥已被轮换掉或换成了错误的密钥环：不能猜，也不能删——留给运维处理。
      throw new OpaqueCompactRepositoryError("key_mismatch", "record key id is not in the keyring");
    }
    const aad = buildAad(row.key_id, row.state_id, row.generation, row.binding);
    let plaintext: Buffer;
    try {
      plaintext = openRecord(key, aad, {
        nonce: Buffer.from(row.nonce),
        tag: Buffer.from(row.tag),
        ciphertext: Buffer.from(row.ciphertext),
      });
    } catch {
      throw new OpaqueCompactRepositoryError("state_corrupt", "record failed AEAD verification");
    }
    this.stmtTouch.run(this.now(), stateId);
    return {
      plaintext,
      meta: {
        stateId: row.state_id,
        keyId: row.key_id,
        binding: row.binding,
        generation: row.generation,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        byteSize: row.byte_size,
      },
    };
  }

  delete(stateId: string): void {
    this.stmtDeleteById.run(stateId);
  }

  /** 启动恢复：清理过期记录，并验证剩余记录能被当前密钥环解封。 */
  recover(): { retained: number; expired: number; unreadable: number } {
    const expired = Number(this.stmtDeleteExpired.run(this.now()).changes ?? 0);
    let retained = 0;
    let unreadable = 0;
    const rows = this.stmtAllIds.all() as { state_id: string }[];
    for (const { state_id: stateId } of rows) {
      try {
        const loaded = this.load(stateId, null);
        if (loaded === null) continue;
        retained += 1;
      } catch (error) {
        // 单条不可读不足以判定整库损坏（可能只是一条被截断），删除并计数；
        // 调用方按 unreadable 数量决定是否整体隔离。
        unreadable += 1;
        if (error instanceof OpaqueCompactRepositoryError && error.reason === "key_mismatch") {
          continue;
        }
        this.stmtDeleteById.run(stateId);
      }
    }
    return { retained, expired, unreadable };
  }

  stats(): { count: number; bytes: number } {
    const row = this.stmtTotals.get() as { count: number; bytes: number } | undefined;
    return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 关闭失败不影响正确性：WAL 已经保证崩溃一致 */
    }
  }

  /** TTL + 容量 + 字节预算修剪。必须在事务内调用，且不得删掉刚写入的记录。 */
  private pruneWithinTransaction(now: number, protectedStateId: string): void {
    this.stmtDeleteExpired.run(now);
    for (;;) {
      const { count, bytes } = this.stats();
      if (count <= this.capacity && bytes <= this.maxBytes) return;
      const oldest = this.stmtOldest.get() as { state_id: string } | undefined;
      if (oldest === undefined) return;
      if (oldest.state_id === protectedStateId) {
        // 只剩刚写入的这条还超预算，说明单条超限，交由上层的 state_too_large 处理。
        return;
      }
      this.stmtDeleteById.run(oldest.state_id);
    }
  }
}
