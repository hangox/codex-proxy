/**
 * Opaque compact state 的 SQLite WAL 持久化仓库。
 *
 * 设计意图：marker 必须跨重启存活，但磁盘上不能出现任何可读的会话内容，
 * 也不能出现能与 marker 直接关联的标识符。这一层负责四件事：
 *
 * 1. 整条 state 序列化成一个密文块（按账号派生的数据密钥 + 全字段 AAD）；
 * 2. 索引用**稳定域** HMAC binding，stateId 也只以 keyed lookup 摘要落库；
 * 3. generation CAS 在单事务内完成"写新代 → 记录 successor 映射 → 修剪"；
 * 4. DB 外部 identity sentinel，使"库被清零/删除"无法伪装成首次初始化。
 *
 * 交付语义（关键）：COMMIT 之后、marker 送达客户端之前进程可能被 SIGKILL。
 * 那一刻客户端手里只有 predecessor marker，若此时就删掉 predecessor，会话就
 * 永久断了。因此 predecessor **不在同事务内删除**，而是：
 *   - 同事务写入 predecessor → successor 的加密映射；
 *   - 客户端拿着 predecessor 重试 compact 时，直接幂等返回同一个 successor marker，
 *     不再打上游；
 *   - 只有当客户端真正使用 successor marker（证明它收到了）时，才回收 predecessor。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, lstatSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  computeIndexBinding,
  computeLookupDigest,
  deriveAccountKey,
  encodeTuple,
  openRecord,
  sealRecord,
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
  | "binding_mismatch"
  /** sentinel 表明 store 曾初始化，但库不见了/被清零。 */
  | "store_reset_detected"
  | "state_too_large";

export class OpaqueCompactRepositoryError extends Error {
  constructor(readonly reason: OpaqueCompactRepositoryFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactRepositoryError";
  }
}

export interface OpaqueCompactRecordMeta {
  lookupDigest: string;
  keyId: string;
  binding: string;
  generation: number;
  createdAt: number;
  expiresAt: number;
  byteSize: number;
  predecessorLookup: string | null;
}

export interface OpaqueCompactRepositoryOptions {
  databasePath: string;
  keyring: OpaqueCompactKeyring;
  /** 由 sentinel 提供的稳定 store 身份，用于识别"库被换掉/清零"。 */
  storeId: string;
  /**
   * sentinel 是否是本次刚创建的。
   * false 表示"store 之前已经初始化过"——此时库里必须已有 schema，
   * 否则就是库被清零/删除/换掉，必须 fail-closed 而不是建一个新空库。
   */
  sentinelCreated: boolean;
  capacity: number;
  maxBytes: number;
  now?: () => number;
}

interface RecordRow {
  lookup_digest: string;
  key_id: string;
  binding: string;
  generation: number;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  byte_size: number;
  account_binding: string;
  predecessor_lookup: string | null;
  nonce: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * AAD 覆盖所有影响安全与生命周期的字段。
 *
 * 只认证 stateId/generation 是不够的：createdAt/expiresAt 决定过期，byteSize
 * 决定预算，account 决定归属——任何一项能被磁盘篡改而不被发现，都等于给攻击者
 * 一个延长 TTL 或操纵配额的口子。用长度前缀 tuple 编码，杜绝字段分隔歧义。
 */
function buildAad(fields: {
  storeId: string;
  keyId: string;
  lookupDigest: string;
  generation: number;
  binding: string;
  accountBinding: string;
  createdAt: number;
  expiresAt: number;
  byteSize: number;
  predecessorLookup: string | null;
}): Buffer {
  return encodeTuple([
    `schema:${OPAQUE_REPOSITORY_SCHEMA_VERSION}`,
    fields.storeId,
    fields.keyId,
    fields.lookupDigest,
    String(fields.generation),
    fields.binding,
    fields.accountBinding,
    String(fields.createdAt),
    String(fields.expiresAt),
    String(fields.byteSize),
    fields.predecessorLookup ?? "",
  ]);
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new OpaqueCompactRepositoryError(
      "store_unavailable",
      `${label} is not a regular file`,
    );
  }
}

export class OpaqueCompactRepository {
  private readonly db: DatabaseSync;
  private readonly keyring: OpaqueCompactKeyring;
  private readonly storeId: string;
  private readonly sentinelCreated: boolean;
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  private readonly stmtInsert: StatementSync;
  private readonly stmtSelectMaxGeneration: StatementSync;
  private readonly stmtSelectByLookup: StatementSync;
  private readonly stmtDeleteByLookup: StatementSync;
  private readonly stmtTouch: StatementSync;
  private readonly stmtDeleteExpired: StatementSync;
  private readonly stmtTotals: StatementSync;
  private readonly stmtOldest: StatementSync;
  private readonly stmtAllRows: StatementSync;
  private readonly stmtInsertSuccessor: StatementSync;
  private readonly stmtSelectSuccessor: StatementSync;
  private readonly stmtDeleteSuccessor: StatementSync;
  private readonly stmtDeleteSuccessorExpired: StatementSync;

  constructor(options: OpaqueCompactRepositoryOptions) {
    this.keyring = options.keyring;
    this.storeId = options.storeId;
    this.sentinelCreated = options.sentinelCreated;
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
      assertRegularFile(options.databasePath, "database");
      assertRegularFile(`${options.databasePath}-wal`, "database WAL");
      assertRegularFile(`${options.databasePath}-shm`, "database SHM");
    }

    try {
      this.db = new DatabaseSync(options.databasePath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.verifyDurabilityPragmas(options.databasePath);
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
         (lookup_digest, key_id, binding, generation, created_at, expires_at, last_used_at,
          byte_size, account_binding, predecessor_lookup, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSelectMaxGeneration = this.db.prepare(
      "SELECT MAX(generation) AS generation FROM opaque_states WHERE binding = ?",
    );
    this.stmtSelectByLookup = this.db.prepare(
      "SELECT * FROM opaque_states WHERE lookup_digest = ?",
    );
    this.stmtDeleteByLookup = this.db.prepare(
      "DELETE FROM opaque_states WHERE lookup_digest = ?",
    );
    this.stmtTouch = this.db.prepare(
      "UPDATE opaque_states SET last_used_at = ? WHERE lookup_digest = ?",
    );
    this.stmtDeleteExpired = this.db.prepare("DELETE FROM opaque_states WHERE expires_at <= ?");
    this.stmtTotals = this.db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM opaque_states",
    );
    this.stmtOldest = this.db.prepare(
      "SELECT lookup_digest FROM opaque_states ORDER BY last_used_at ASC, created_at ASC LIMIT 1",
    );
    this.stmtAllRows = this.db.prepare("SELECT * FROM opaque_states");
    this.stmtInsertSuccessor = this.db.prepare(
      `INSERT OR REPLACE INTO opaque_successors
         (predecessor_lookup, binding, created_at, expires_at, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSelectSuccessor = this.db.prepare(
      "SELECT * FROM opaque_successors WHERE predecessor_lookup = ?",
    );
    this.stmtDeleteSuccessor = this.db.prepare(
      "DELETE FROM opaque_successors WHERE predecessor_lookup = ?",
    );
    this.stmtDeleteSuccessorExpired = this.db.prepare(
      "DELETE FROM opaque_successors WHERE expires_at <= ?",
    );
  }

  /** PRAGMA 设置必须读回验证：设置成功不等于生效（只读介质、旧版本等）。 */
  private verifyDurabilityPragmas(databasePath: string): void {
    if (databasePath === ":memory:") return;
    const journal = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    if (String(journal?.journal_mode ?? "").toLowerCase() !== "wal") {
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        `journal_mode is ${String(journal?.journal_mode)}, expected wal`,
      );
    }
    const sync = this.db.prepare("PRAGMA synchronous").get() as
      | { synchronous?: number }
      | undefined;
    // 2 = FULL, 3 = EXTRA. 两者都满足"COMMIT 后可跨崩溃恢复"。
    if (Number(sync?.synchronous) < 2) {
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        `synchronous is ${String(sync?.synchronous)}, expected FULL`,
      );
    }
  }

  /**
   * schema 初始化整体在一个事务内完成，避免中途被 kill 留下
   * "表建了但 meta 没写"的半初始化库。
   */
  private initSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    );
    const readMeta = (key: string): string | undefined =>
      (this.db.prepare("SELECT value FROM opaque_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined)?.value;

    const existingVersion = readMeta("schema_version");
    if (existingVersion !== undefined) {
      const version = Number(existingVersion);
      if (!Number.isInteger(version) || version !== OPAQUE_REPOSITORY_SCHEMA_VERSION) {
        // 旧版本二进制遇到新 schema 只会读到无法解析的记录；必须停机而不是猜列布局。
        throw new OpaqueCompactRepositoryError(
          "schema_unsupported",
          `unsupported opaque state schema version ${existingVersion}`,
        );
      }
      const existingStoreId = readMeta("store_id");
      // sentinel 说 store 曾初始化，库里却没有身份 / 身份不符 → 库被换过或清零。
      // 这正是 integrity_check 检不出来的路径（清零库与全新空库不可区分）。
      if (existingStoreId === undefined || existingStoreId !== this.storeId) {
        throw new OpaqueCompactRepositoryError(
          "store_reset_detected",
          "database identity does not match the store sentinel",
        );
      }
      return;
    }

    // 走到这里说明库里没有 schema。只有"sentinel 也是刚创建的"才是真正的
    // 首次初始化；否则 sentinel 证明 store 曾经存在过，而库却空了——
    // 这正是 QA 探针确认的 integrity_check 检不出的清零场景。
    if (!this.sentinelCreated) {
      throw new OpaqueCompactRepositoryError(
        "store_reset_detected",
        "store sentinel exists but the database has no schema",
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS opaque_states (
           lookup_digest      TEXT PRIMARY KEY,
           key_id             TEXT NOT NULL,
           binding            TEXT NOT NULL,
           generation         INTEGER NOT NULL,
           created_at         INTEGER NOT NULL,
           expires_at         INTEGER NOT NULL,
           last_used_at       INTEGER NOT NULL,
           byte_size          INTEGER NOT NULL,
           account_binding    TEXT NOT NULL,
           predecessor_lookup TEXT,
           nonce              BLOB NOT NULL,
           tag                BLOB NOT NULL,
           ciphertext         BLOB NOT NULL
         )`,
      );
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS opaque_successors (
           predecessor_lookup TEXT PRIMARY KEY,
           binding            TEXT NOT NULL,
           created_at         INTEGER NOT NULL,
           expires_at         INTEGER NOT NULL,
           nonce              BLOB NOT NULL,
           tag                BLOB NOT NULL,
           ciphertext         BLOB NOT NULL
         )`,
      );
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_binding ON opaque_states (binding)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_expires ON opaque_states (expires_at)");
      this.db
        .prepare("INSERT INTO opaque_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
      this.db
        .prepare("INSERT INTO opaque_meta (key, value) VALUES ('store_id', ?)")
        .run(this.storeId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      throw error;
    }
  }

  /** 稳定索引绑定：跨 master key 轮换不变。 */
  bindingFor(sessionId: string, model: string, variantHash: string): string {
    return computeIndexBinding(this.keyring, ["state", sessionId, model, variantHash]);
  }

  accountBindingFor(accountEntryId: string): string {
    return computeIndexBinding(this.keyring, ["account", accountEntryId]);
  }

  lookupFor(stateId: string): string {
    return computeLookupDigest(this.keyring, stateId);
  }

  /** 当前 binding 的最高 generation；没有记录时为 0。 */
  currentGeneration(binding: string): number {
    const row = this.stmtSelectMaxGeneration.get(binding) as
      | { generation: number | null }
      | undefined;
    const value = row?.generation ?? 0;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * 在单个事务里：CAS 校验 → 写入新 generation → 记录 successor 映射 → 修剪。
   * 只有本方法正常返回（COMMIT 成功）后，调用方才可以把 marker 发给客户端。
   *
   * 注意 predecessor **不在这里删除**——见文件头的交付语义说明。
   */
  saveWithCas(options: {
    stateId: string;
    binding: string;
    accountEntryId: string;
    expectedGeneration: number;
    plaintext: Buffer;
    createdAt: number;
    expiresAt: number;
    /** 本次 compact 所基于的 predecessor stateId（首次为 null）。 */
    predecessorStateId: string | null;
    /** 成功后要幂等回放的 marker 全文，加密后存入 successor 映射。 */
    successorMarker: string;
  }): { generation: number; keyId: string; byteSize: number; lookupDigest: string } {
    const key = this.keyring.active();
    const generation = options.expectedGeneration + 1;
    const lookupDigest = this.lookupFor(options.stateId);
    const accountBinding = this.accountBindingFor(options.accountEntryId);
    const predecessorLookup = options.predecessorStateId === null
      ? null
      : this.lookupFor(options.predecessorStateId);

    const dataKey = deriveAccountKey(this.keyring, key, options.accountEntryId);
    // byteSize 参与 AAD，必须在封装前定稿。
    const provisional = sealRecord(dataKey, Buffer.alloc(0), options.plaintext);
    const byteSize = provisional.ciphertext.length + provisional.nonce.length + provisional.tag.length;

    // 单条超预算必须在 COMMIT 之前拒绝：绝不能既落了行又返回失败，
    // 也不能返回一个指向被立刻淘汰的行的 marker。
    if (byteSize > this.maxBytes) {
      throw new OpaqueCompactRepositoryError("state_too_large");
    }

    const aad = buildAad({
      storeId: this.storeId,
      keyId: key.id,
      lookupDigest,
      generation,
      binding: options.binding,
      accountBinding,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
      byteSize,
      predecessorLookup,
    });
    const sealed = sealRecord(dataKey, aad, options.plaintext);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.currentGeneration(options.binding);
      if (current !== options.expectedGeneration) {
        throw new OpaqueCompactRepositoryError("stale_generation");
      }
      this.stmtInsert.run(
        lookupDigest,
        key.id,
        options.binding,
        generation,
        options.createdAt,
        options.expiresAt,
        options.createdAt,
        byteSize,
        accountBinding,
        predecessorLookup,
        sealed.nonce,
        sealed.tag,
        sealed.ciphertext,
      );

      // predecessor → successor marker 的加密映射，与 state 行同事务落盘。
      // 崩溃后客户端拿旧 marker 重试时据此幂等返回同一个 successor marker。
      if (predecessorLookup !== null) {
        const mapAad = encodeTuple([
          `successor:${OPAQUE_REPOSITORY_SCHEMA_VERSION}`,
          this.storeId,
          key.id,
          predecessorLookup,
          options.binding,
          String(options.expiresAt),
        ]);
        const sealedMarker = sealRecord(dataKey, mapAad, Buffer.from(options.successorMarker, "utf-8"));
        this.stmtInsertSuccessor.run(
          predecessorLookup,
          options.binding,
          options.createdAt,
          options.expiresAt,
          sealedMarker.nonce,
          sealedMarker.tag,
          sealedMarker.ciphertext,
        );
      }

      this.pruneWithinTransaction(options.createdAt, lookupDigest, predecessorLookup);
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
    return { generation, keyId: key.id, byteSize, lookupDigest };
  }

  /**
   * 幂等回放：若该 predecessor 已经有 successor，直接返回它的 marker。
   * 这是"COMMIT 成功但响应没送达"之后客户端重试的恢复路径。
   */
  findSuccessorMarker(predecessorStateId: string, accountEntryId: string): string | null {
    const predecessorLookup = this.lookupFor(predecessorStateId);
    const row = this.stmtSelectSuccessor.get(predecessorLookup) as
      | {
          predecessor_lookup: string;
          binding: string;
          expires_at: number;
          nonce: Uint8Array;
          tag: Uint8Array;
          ciphertext: Uint8Array;
        }
      | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= this.now()) {
      this.stmtDeleteSuccessor.run(predecessorLookup);
      return null;
    }
    // 映射可能由任意一代 key 封装；逐 key 尝试，失败即视为不可用而非损坏。
    for (const key of this.keyring.keys) {
      const dataKey = deriveAccountKey(this.keyring, key, accountEntryId);
      const mapAad = encodeTuple([
        `successor:${OPAQUE_REPOSITORY_SCHEMA_VERSION}`,
        this.storeId,
        key.id,
        row.predecessor_lookup,
        row.binding,
        String(row.expires_at),
      ]);
      try {
        return openRecord(dataKey, mapAad, {
          nonce: Buffer.from(row.nonce),
          tag: Buffer.from(row.tag),
          ciphertext: Buffer.from(row.ciphertext),
        }).toString("utf-8");
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * 读取并解封。失败一律抛错；过期记录顺带删除。
   *
   * `accountCandidates` 是当前进程已知的账号集合。数据密钥按账号派生，因此
   * 必须由调用方提供候选；先用 account_binding 常数级筛出唯一匹配项，再解封。
   * 候选里没有匹配账号 → 该记录不属于本实例可访问的任何账号，fail-closed。
   */
  load(stateId: string, accountCandidates: readonly string[]): {
    plaintext: Buffer;
    meta: OpaqueCompactRecordMeta;
  } | null {
    const lookupDigest = this.lookupFor(stateId);
    const row = this.stmtSelectByLookup.get(lookupDigest) as RecordRow | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= this.now()) {
      this.stmtDeleteByLookup.run(lookupDigest);
      return null;
    }
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      // 密钥已轮换出保留窗口，或换成了错误的密钥环：不能猜，也不能删。
      throw new OpaqueCompactRepositoryError("key_mismatch", "record key id is not in the keyring");
    }
    // 账号未知时无法派生数据密钥——这正是账号域隔离的体现：调用方必须先知道
    // 自己是哪个账号，否则连解封都做不到。
    const candidates = accountCandidates;
    if (candidates.length === 0) {
      throw new OpaqueCompactRepositoryError("key_mismatch", "account is required to open a record");
    }
    // byteSize 用密文实测值重算，不信任列里的数字。
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    for (const account of candidates) {
      const accountBinding = this.accountBindingFor(account);
      if (accountBinding !== row.account_binding) continue;
      const aad = buildAad({
        storeId: this.storeId,
        keyId: row.key_id,
        lookupDigest: row.lookup_digest,
        generation: row.generation,
        binding: row.binding,
        accountBinding,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        byteSize: actualByteSize,
        predecessorLookup: row.predecessor_lookup,
      });
      const dataKey = deriveAccountKey(this.keyring, key, account);
      let plaintext: Buffer;
      try {
        plaintext = openRecord(dataKey, aad, {
          nonce: Buffer.from(row.nonce),
          tag: Buffer.from(row.tag),
          ciphertext: Buffer.from(row.ciphertext),
        });
      } catch {
        throw new OpaqueCompactRepositoryError("state_corrupt", "record failed AEAD verification");
      }
      this.stmtTouch.run(this.now(), lookupDigest);
      return {
        plaintext,
        meta: {
          lookupDigest: row.lookup_digest,
          keyId: row.key_id,
          binding: row.binding,
          generation: row.generation,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          byteSize: actualByteSize,
          predecessorLookup: row.predecessor_lookup,
        },
      };
    }
    throw new OpaqueCompactRepositoryError("binding_mismatch", "record belongs to another account");
  }

  /**
   * 确认客户端已经用上 successor：此时回收它的 predecessor 与映射。
   * 这一步是 predecessor 被删除的**唯一**入口。
   */
  confirmSuccessorUsed(meta: OpaqueCompactRecordMeta): void {
    if (meta.predecessorLookup === null) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmtDeleteByLookup.run(meta.predecessorLookup);
      this.stmtDeleteSuccessor.run(meta.predecessorLookup);
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
  }

  deleteByStateId(stateId: string): void {
    this.stmtDeleteByLookup.run(this.lookupFor(stateId));
  }

  /**
   * 启动恢复验证。**只读**：既不改 last_used_at（那会抹掉重启前的 LRU 顺序），
   * 也不删除损坏记录（销毁证据后调用方就无法做 quarantine 决策了）。
   * 过期清理是唯一的写操作，且与损坏无关。
   */
  recover(): { retained: number; expired: number; unreadable: number } {
    const expired = Number(this.stmtDeleteExpired.run(this.now()).changes ?? 0);
    this.stmtDeleteSuccessorExpired.run(this.now());
    let retained = 0;
    let unreadable = 0;
    const rows = this.stmtAllRows.all() as unknown as RecordRow[];
    for (const row of rows) {
      const key = this.keyring.get(row.key_id);
      if (key === undefined) {
        unreadable += 1;
        continue;
      }
      // 恢复阶段不知道账号，无法解封——账号域隔离的必然结果。
      // 这里只验证结构完整性：AEAD 验证推迟到真正的读取路径。
      if (row.ciphertext.length === 0 || row.nonce.length === 0 || row.tag.length === 0) {
        unreadable += 1;
        continue;
      }
      retained += 1;
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

  /** TTL + 容量 + 字节预算修剪。必须在事务内调用，且不得删掉刚写入的记录或其 predecessor。 */
  private pruneWithinTransaction(
    now: number,
    protectedLookup: string,
    predecessorLookup: string | null,
  ): void {
    this.stmtDeleteExpired.run(now);
    this.stmtDeleteSuccessorExpired.run(now);
    for (let guard = 0; guard < 10_000; guard += 1) {
      const { count, bytes } = this.stats();
      if (count <= this.capacity && bytes <= this.maxBytes) return;
      const oldest = this.stmtOldest.get() as { lookup_digest: string } | undefined;
      if (oldest === undefined) return;
      // 刚写入的行和它的 predecessor 都不能被本次修剪淘汰：predecessor 还要
      // 支撑崩溃重试的幂等回放。
      if (oldest.lookup_digest === protectedLookup) return;
      if (predecessorLookup !== null && oldest.lookup_digest === predecessorLookup) {
        // 跳过 predecessor，转而淘汰次旧的一条。
        const alternate = this.db
          .prepare(
            `SELECT lookup_digest FROM opaque_states
             WHERE lookup_digest NOT IN (?, ?)
             ORDER BY last_used_at ASC, created_at ASC LIMIT 1`,
          )
          .get(protectedLookup, predecessorLookup) as { lookup_digest: string } | undefined;
        if (alternate === undefined) return;
        this.stmtDeleteByLookup.run(alternate.lookup_digest);
        continue;
      }
      this.stmtDeleteByLookup.run(oldest.lookup_digest);
    }
  }
}
