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
  computeMutableMetaMac,
  deriveAccountKey,
  deriveAccountKeyFromBinding,
  encodeTuple,
  openRecord,
  sealRecord,
  sealedSizeFor,
  type OpaqueCompactKeyring,
} from "./opaque-compact-keyring.js";

/** 记录 schema 版本。任何不兼容的列变更都必须 +1。 */
export const OPAQUE_REPOSITORY_SCHEMA_VERSION = 3;

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
  /**
   * 冷启动语义校验器（由 state 层注入，避免循环依赖）。
   *
   * AEAD 通过只证明"这段密文是我们自己写的"，不证明它符合当前版本的结构与
   * 元数据约束。没有这一步，AEAD-valid 但 payload 版本过旧/字段畸形/绑定
   * 漂移的记录会让 readiness=ready，直到用户真正 restore 才暴露。
   * 返回 false 即视为不可读。
   */
  validatePayload?: (plaintext: Buffer, meta: OpaqueCompactRecordMeta) => boolean;
}

interface SuccessorRow {
  predecessor_lookup: string;
  successor_lookup: string;
  key_id: string;
  account_binding: string;
  binding: string;
  created_at: number;
  expires_at: number;
  byte_size: number;
  nonce: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
}

interface RecordRow {
  lookup_digest: string;
  key_id: string;
  binding: string;
  generation: number;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  last_used_mac: string;
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

/** successor 映射的 AAD。字段集合与 state 行同样必须完整覆盖生命周期。 */
function buildSuccessorAad(fields: {
  storeId: string;
  keyId: string;
  predecessorLookup: string;
  successorLookup: string;
  accountBinding: string;
  binding: string;
  createdAt: number;
  expiresAt: number;
  byteSize: number;
}): Buffer {
  return encodeTuple([
    `successor:${OPAQUE_REPOSITORY_SCHEMA_VERSION}`,
    fields.storeId,
    fields.keyId,
    fields.predecessorLookup,
    fields.successorLookup,
    fields.accountBinding,
    fields.binding,
    String(fields.createdAt),
    String(fields.expiresAt),
    String(fields.byteSize),
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
  private validatePayload: ((plaintext: Buffer, meta: OpaqueCompactRecordMeta) => boolean) | null;
  private validateSuccessorMarker: ((marker: string, expectedSuccessorLookup: string) => boolean) | null = null;

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
  private readonly stmtSuccessorTotals: StatementSync;
  private readonly stmtAllSuccessors: StatementSync;

  constructor(options: OpaqueCompactRepositoryOptions) {
    this.keyring = options.keyring;
    this.storeId = options.storeId;
    this.sentinelCreated = options.sentinelCreated;
    this.capacity = options.capacity;
    this.maxBytes = options.maxBytes;
    this.now = options.now ?? Date.now;
    this.validatePayload = options.validatePayload ?? null;

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

    // 注意：constructor 抛错时 `new` 不返回，外层拿不到实例，也就无法 close()。
    // 因此这里必须自己兜底关闭已经打开的连接，否则 DB/WAL 的 fd 会一直泄漏，
    // 影响后续启动与隔离操作。
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(options.databasePath);
      this.db = opened;
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.verifyDurabilityPragmas(options.databasePath);
      this.initSchema();
    } catch (error) {
      if (opened !== null) {
        try {
          opened.close();
        } catch {
          /* 已经关闭或从未成功打开 */
        }
      }
      if (error instanceof OpaqueCompactRepositoryError) throw error;
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }

    this.stmtInsert = this.db.prepare(
      `INSERT INTO opaque_states
         (lookup_digest, key_id, binding, generation, created_at, expires_at, last_used_at,
          last_used_mac, byte_size, account_binding, predecessor_lookup, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      "UPDATE opaque_states SET last_used_at = ?, last_used_mac = ? WHERE lookup_digest = ?",
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
         (predecessor_lookup, successor_lookup, key_id, account_binding, binding,
          created_at, expires_at, byte_size, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    this.stmtSuccessorTotals = this.db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM opaque_successors",
    );
    this.stmtAllSuccessors = this.db.prepare("SELECT * FROM opaque_successors");
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
           last_used_mac      TEXT NOT NULL,
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
           successor_lookup   TEXT NOT NULL,
           key_id             TEXT NOT NULL,
           account_binding    TEXT NOT NULL,
           binding            TEXT NOT NULL,
           created_at         INTEGER NOT NULL,
           expires_at         INTEGER NOT NULL,
           byte_size          INTEGER NOT NULL,
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

  /** 注入冷启动语义校验器（构造后设置，避免与 state 层循环依赖）。 */
  setPayloadValidator(
    validator: (plaintext: Buffer, meta: OpaqueCompactRecordMeta) => boolean,
  ): void {
    this.validatePayload = validator;
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
    // predecessor 与 successor 映射都受保护、不可被本次修剪淘汰，
    // 因此预算判定必须把它们一起算进来。
    const successorBytes = predecessorLookup === null
      ? 0
      : sealedSizeFor(Buffer.byteLength(options.successorMarker, "utf-8"));
    if (byteSize + successorBytes > this.maxBytes) {
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
        computeMutableMetaMac(this.keyring, lookupDigest, "last_used_at", options.createdAt),
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
        const markerBytes = Buffer.from(options.successorMarker, "utf-8");
        const sealedMarker = sealRecord(
          dataKey,
          buildSuccessorAad({
            storeId: this.storeId,
            keyId: key.id,
            predecessorLookup,
            successorLookup: lookupDigest,
            accountBinding,
            binding: options.binding,
            createdAt: options.createdAt,
            expiresAt: options.expiresAt,
            byteSize: successorBytes,
          }),
          markerBytes,
        );
        this.stmtInsertSuccessor.run(
          predecessorLookup,
          lookupDigest,
          key.id,
          accountBinding,
          options.binding,
          options.createdAt,
          options.expiresAt,
          successorBytes,
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
    const row = this.stmtSelectSuccessor.get(predecessorLookup) as unknown as
      | SuccessorRow
      | undefined;
    // 没有映射是正常情况（首次 compact），返回 null 让调用方去打上游。
    if (row === undefined) return null;

    // 以下任何一项失败都是**异常**，不能再返回 null 装作"没有映射"——
    // 那会让进程去重打一次上游，随后撞上 stale_generation，把真正的损坏
    // 原因掩盖掉。
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      throw new OpaqueCompactRepositoryError("key_mismatch", "successor key id is not in the keyring");
    }
    const accountBinding = this.accountBindingFor(accountEntryId);
    if (accountBinding !== row.account_binding) {
      throw new OpaqueCompactRepositoryError("binding_mismatch", "successor belongs to another account");
    }
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    if (Number(row.byte_size) !== actualByteSize) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "successor byte size does not match");
    }

    const dataKey = deriveAccountKey(this.keyring, key, accountEntryId);
    let marker: string;
    try {
      marker = openRecord(
        dataKey,
        buildSuccessorAad({
          storeId: this.storeId,
          keyId: row.key_id,
          predecessorLookup: row.predecessor_lookup,
          successorLookup: row.successor_lookup,
          accountBinding: row.account_binding,
          binding: row.binding,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          byteSize: actualByteSize,
        }),
        {
          nonce: Buffer.from(row.nonce),
          tag: Buffer.from(row.tag),
          ciphertext: Buffer.from(row.ciphertext),
        },
      ).toString("utf-8");
    } catch {
      throw new OpaqueCompactRepositoryError("state_corrupt", "successor failed AEAD verification");
    }

    // 认证之后才信任 expires_at。反序会让攻击者改短 expires 来销毁
    // post-commit 幂等映射，重新打开崩溃窗口。
    if (row.expires_at <= this.now()) {
      this.stmtDeleteSuccessor.run(predecessorLookup);
      return null;
    }
    // AEAD 只证明这段密文是我们写的，不证明它确实是一个 marker，也不证明它
    // 指向本行记录的 successor。缺了这一步，任何 AEAD-valid 的字符串都会被
    // 当作 marker 原样交给客户端。这里校验语法，并要求 marker 内的 stateId
    // 折算出的 lookup 与已认证的 successor_lookup 一致。
    if (this.validateSuccessorMarker !== null &&
        !this.validateSuccessorMarker(marker, row.successor_lookup)) {
      throw new OpaqueCompactRepositoryError(
        "state_corrupt",
        "successor mapping does not contain a valid marker for its target",
      );
    }
    return marker;
  }

  /** 注入 successor marker 语义校验器（避免与 state 层循环依赖）。 */
  setSuccessorMarkerValidator(
    validator: (marker: string, expectedSuccessorLookup: string) => boolean,
  ): void {
    this.validateSuccessorMarker = validator;
  }

  /**
   * 读取并解封。
   *
   * 顺序是安全关键，不可调换：
   * 1. 先做 AEAD 认证（含 byte_size 与列值比对）；
   * 2. 认证通过后才读取 expires_at 做 TTL 判定与删除。
   *
   * 反过来（先信任 expires_at 再解封）会给磁盘攻击者一条捷径：把 expires_at
   * 改早即可让损坏记录被静默删除，绕过 state_corrupt 并销毁证据。所有依赖
   * 元数据的删除/预算动作都必须在认证之后。
   *
   * `accountCandidates` 是当前进程已知的账号集合。数据密钥按账号派生，
   * 候选里没有匹配账号 → 该记录不属于本实例可访问的任何账号，fail-closed。
   */
  load(stateId: string, accountCandidates: readonly string[]): {
    plaintext: Buffer;
    meta: OpaqueCompactRecordMeta;
    /** 实际派生出数据密钥的账号——调用方必须与 payload 交叉验证。 */
    matchedAccountEntryId: string;
  } | null {
    const lookupDigest = this.lookupFor(stateId);
    const row = this.stmtSelectByLookup.get(lookupDigest) as RecordRow | undefined;
    if (row === undefined) return null;

    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      // 密钥已轮换出保留窗口，或换成了错误的密钥环：不能猜，也不能删。
      throw new OpaqueCompactRepositoryError("key_mismatch", "record key id is not in the keyring");
    }
    if (accountCandidates.length === 0) {
      throw new OpaqueCompactRepositoryError("key_mismatch", "account is required to open a record");
    }

    // byte_size 参与 AAD，但必须先与密文实测值比对：只把实测值塞进 AAD 而
    // 从不校验列值，等于让攻击者把列改成 0 来绕过 maxBytes 预算。
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    if (Number(row.byte_size) !== actualByteSize) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "record byte size does not match");
    }

    for (const account of accountCandidates) {
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

      // 在任何 touch 之前先验证**旧** MAC。否则攻击者可以先改 last_used_at，
      // 再诱导一次正常 resolve —— touch 会用篡改后的顺序重新签一个有效 MAC，
      // 等于把运行期篡改洗白成合法状态。
      if (
        row.last_used_mac !==
        computeMutableMetaMac(this.keyring, row.lookup_digest, "last_used_at", row.last_used_at)
      ) {
        throw new OpaqueCompactRepositoryError("state_corrupt", "last_used_at is not authenticated");
      }

      // 认证通过之后才敢相信 expires_at，此时删除过期记录是安全的。
      if (row.expires_at <= this.now()) {
        this.stmtDeleteByLookup.run(lookupDigest);
        return null;
      }

      const touchedAt = this.now();
      this.stmtTouch.run(
        touchedAt,
        computeMutableMetaMac(this.keyring, lookupDigest, "last_used_at", touchedAt),
        lookupDigest,
      );
      return {
        plaintext,
        matchedAccountEntryId: account,
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
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      // 不能吞：回收失败意味着 predecessor 仍然存在，调用方需要知道
      // store 出了问题，否则故障会被掩盖成"一切正常"。
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  deleteByStateId(stateId: string): void {
    this.stmtDeleteByLookup.run(this.lookupFor(stateId));
  }

  /**
   * 启动恢复：对全库做**真正的 AEAD 验证**，且严格只读。
   *
   * 两条纪律：
   * - **不 touch**：不改 last_used_at，否则重启就抹平了逐出顺序；
   * - **不删除**：损坏记录必须原样保留。先 DELETE 再让调用方"决定是否
   *   quarantine"是自相矛盾的——证据已经没了。过期清理同样推迟到认证之后。
   *
   * 能在不知道 raw 账号的情况下验证，是因为数据密钥实际只依赖
   * account_binding，而它就在 row 里。
   */
  recover(): { retained: number; expired: number; unreadable: number } {
    let retained = 0;
    let unreadable = 0;
    const expiredLookups: string[] = [];
    const expiredSuccessors: string[] = [];
    const now = this.now();

    // successor 映射与 state 行同等重要：它承载 post-commit 幂等回放。
    // 若不认证就按 expires_at 批量删除，攻击者改短 TTL 即可销毁映射，
    // 重新打开"新 marker 没收到、旧 marker 已失效"的双失窗口。
    const successorRows = this.stmtAllSuccessors.all() as unknown as SuccessorRow[];
    for (const row of successorRows) {
      const key = this.keyring.get(row.key_id);
      if (key === undefined) {
        unreadable += 1;
        continue;
      }
      const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
      if (Number(row.byte_size) !== actualByteSize) {
        unreadable += 1;
        continue;
      }
      let successorMarker: string;
      try {
        successorMarker = openRecord(
          deriveAccountKeyFromBinding(key, row.account_binding),
          buildSuccessorAad({
            storeId: this.storeId,
            keyId: row.key_id,
            predecessorLookup: row.predecessor_lookup,
            successorLookup: row.successor_lookup,
            accountBinding: row.account_binding,
            binding: row.binding,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            byteSize: actualByteSize,
          }),
          {
            nonce: Buffer.from(row.nonce),
            tag: Buffer.from(row.tag),
            ciphertext: Buffer.from(row.ciphertext),
          },
        ).toString("utf-8");
      } catch {
        unreadable += 1;
        continue;
      }
      // AEAD 只证明这段密文是我们写的。冷启动同样要验证它**确实是**一个
      // marker，且指向本行已认证的 successor_lookup；否则一条 AEAD-valid
      // 的垃圾字符串会让 store 照常 ready，直到客户端重试才被当 marker 交出。
      if (this.validateSuccessorMarker !== null &&
          !this.validateSuccessorMarker(successorMarker, row.successor_lookup)) {
        unreadable += 1;
        continue;
      }
      if (row.expires_at <= now) expiredSuccessors.push(row.predecessor_lookup);
    }

    const rows = this.stmtAllRows.all() as unknown as RecordRow[];
    for (const row of rows) {
      const key = this.keyring.get(row.key_id);
      if (key === undefined) {
        unreadable += 1;
        continue;
      }
      const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
      if (Number(row.byte_size) !== actualByteSize) {
        unreadable += 1;
        continue;
      }
      // last_used_at 决定 LRU 逐出。它可变、无法进记录 AAD，因此用独立 MAC
      // 认证；否则攻击者改这一列就能在容量压力下定向逐出任意 state。
      if (
        row.last_used_mac !==
        computeMutableMetaMac(this.keyring, row.lookup_digest, "last_used_at", row.last_used_at)
      ) {
        unreadable += 1;
        continue;
      }
      const dataKey = deriveAccountKeyFromBinding(key, row.account_binding);
      let plaintext: Buffer;
      try {
        plaintext = openRecord(
          dataKey,
          buildAad({
            storeId: this.storeId,
            keyId: row.key_id,
            lookupDigest: row.lookup_digest,
            generation: row.generation,
            binding: row.binding,
            accountBinding: row.account_binding,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            byteSize: actualByteSize,
            predecessorLookup: row.predecessor_lookup,
          }),
          {
            nonce: Buffer.from(row.nonce),
            tag: Buffer.from(row.tag),
            ciphertext: Buffer.from(row.ciphertext),
          },
        );
      } catch {
        // bit flip 在这里就会被抓到，冷启动不再"看起来健康"。
        unreadable += 1;
        continue;
      }
      // 语义校验：版本/结构/绑定漂移同样属于"启动期就该发现"的问题。
      if (this.validatePayload !== null) {
        const meta: OpaqueCompactRecordMeta = {
          lookupDigest: row.lookup_digest,
          keyId: row.key_id,
          binding: row.binding,
          generation: row.generation,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          byteSize: actualByteSize,
          predecessorLookup: row.predecessor_lookup,
        };
        if (!this.validatePayload(plaintext, meta)) {
          unreadable += 1;
          continue;
        }
      }
      // 认证通过之后，expires_at 才是可信的。
      if (row.expires_at <= now) {
        expiredLookups.push(row.lookup_digest);
        continue;
      }
      retained += 1;
    }

    // 只有在没有任何损坏记录时才动手清理过期项：一旦发现损坏，整库进入
    // 待隔离状态，此时任何写操作都可能破坏证据。
    // 注意删除的是**逐行认证过**的那些 lookup，而不是按 SQL 条件批量删——
    // 后者会连同未认证的行一起清掉。
    if (unreadable === 0) {
      for (const lookup of expiredLookups) {
        this.stmtDeleteByLookup.run(lookup);
      }
      for (const lookup of expiredSuccessors) {
        this.stmtDeleteSuccessor.run(lookup);
      }
    }
    return { retained, expired: expiredLookups.length, unreadable };
  }

  /**
   * 只读探测：磁盘上已存在记录的最晚过期时间。
   *
   * 用于密钥保留策略——不能只按当前配置 TTL 裁剪 previous key，否则调小
   * ttl_minutes 后重启会裁掉仍存活 state 依赖的密钥。这是一个不需要密钥、
   * 不需要认证的纯元数据查询，可在 keyring 加载前调用。
   */
  static peekMaxExpiresAt(databasePath: string): number {
    // 必须先确认文件存在：`new DatabaseSync(path)` 默认以读写方式打开，
    // 库不存在时会**创建一个 0 字节 0644 的空文件**。runtime 在 keyring
    // 加载之前调用本方法，一旦留下空库，随后 keyring 失败/崩溃就会让下次
    // 启动看到「sentinel 已存在但 DB 无 schema」→ store_reset_detected，
    // 两阶段初始化不再可重入；顺带还违反 0600 权限要求。
    if (!existsSync(databasePath)) return 0;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      const row = db
        .prepare("SELECT MAX(expires_at) AS max_expires FROM opaque_states")
        .get() as { max_expires: number | null } | undefined;
      return Number(row?.max_expires ?? 0);
    } catch {
      // 库不存在 / 无此表 / 无法打开都当作"没有存活记录"，
      // 真正的可用性判定由后续正式打开流程负责。
      return 0;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 容量与字节统计。
   *
   * successor 映射也占磁盘，必须计入预算——否则大量重复 compact 会让
   * successor 表无限增长却不触发任何淘汰，绕过 maxBytes。
   */
  stats(): { count: number; bytes: number } {
    const row = this.stmtTotals.get() as { count: number; bytes: number } | undefined;
    const successors = this.stmtSuccessorTotals.get() as
      | { count: number; bytes: number }
      | undefined;
    // successor 行同样占用容量与字节：只计 bytes 不计 count 时，
    // capacity=2 的库放 2 条 state + 1 条 successor 仍会被当作 count=2 放行。
    return {
      count: Number(row?.count ?? 0) + Number(successors?.count ?? 0),
      bytes: Number(row?.bytes ?? 0) + Number(successors?.bytes ?? 0),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 关闭失败不影响正确性：WAL 已经保证崩溃一致 */
    }
  }

  /**
   * TTL + 容量 + 字节预算修剪。必须在事务内调用，且不得删掉刚写入的记录或其
   * predecessor。
   *
   * 前置条件：启动时 `recover()` 已对全库完成 AEAD 验证且没有发现损坏记录
   * （否则 runtime 会进入 quarantine 而根本不会走到写入路径）。因此这里按
   * byte_size / last_used_at 做淘汰是安全的——这些列都已被认证过。
   */
  private pruneWithinTransaction(
    now: number,
    protectedLookup: string,
    predecessorLookup: string | null,
  ): void {
    // 刻意**不**在这里按 expires_at 批量 DELETE：那会信任运行期可能已被
    // 篡改的列，攻击者改短 TTL 即可静默删除任意记录。过期清理只在启动
    // recover 的逐行认证之后进行；这里仅按已认证的 LRU 顺序做容量淘汰。
    for (let guard = 0; guard < 10_000; guard += 1) {
      const { count, bytes } = this.stats();
      if (count <= this.capacity && bytes <= this.maxBytes) return;

      // 只在受保护记录之外挑最旧的一条淘汰。刚写入的行和它的 predecessor
      // 都不能动：predecessor 还要支撑崩溃重试的幂等回放。
      // 受保护集合：刚写入的行、它的 predecessor，以及**所有**仍待交付的
      // successor 映射两端。漏掉后者会让会话 B 的容量压力删掉会话 A 尚未
      // confirm 的 predecessor 或 successor 目标，破坏 post-commit 恢复承诺。
      const victim = this.db
        .prepare(
          `SELECT lookup_digest, last_used_at, last_used_mac FROM opaque_states
           WHERE lookup_digest <> ?
             AND (? IS NULL OR lookup_digest <> ?)
             AND lookup_digest NOT IN (SELECT predecessor_lookup FROM opaque_successors)
             AND lookup_digest NOT IN (
               SELECT successor_lookup FROM opaque_successors WHERE successor_lookup IS NOT NULL
             )
           ORDER BY last_used_at ASC, created_at ASC LIMIT 1`,
        )
        .get(protectedLookup, predecessorLookup, predecessorLookup ?? "") as
        | { lookup_digest: string; last_used_at: number; last_used_mac: string }
        | undefined;

      if (victim === undefined) {
        // 已经没有可淘汰的记录，但预算仍不满足 —— 此时**必须**抛错让整个
        // 事务回滚。此前这里是 return，导致 save 继续 COMMIT，capacity=1 时
        // 盘上会留下 2 条 state，直接违反配置上限。
        throw new OpaqueCompactRepositoryError(
          "state_too_large",
          "capacity or byte budget cannot be satisfied without evicting protected records",
        );
      }
      // 逐出前重新认证 last_used_at：启动时验过不等于运行期没被改。
      // MAC 不符说明有人在运行中动了排序依据，此时删除任何记录都不安全。
      if (
        victim.last_used_mac !==
        computeMutableMetaMac(this.keyring, victim.lookup_digest, "last_used_at", victim.last_used_at)
      ) {
        throw new OpaqueCompactRepositoryError(
          "state_corrupt",
          "eviction candidate has unauthenticated last_used_at",
        );
      }
      this.stmtDeleteByLookup.run(victim.lookup_digest);
    }
    throw new OpaqueCompactRepositoryError("state_too_large", "prune did not converge");
  }
}
