/**
 * Opaque compact state 的 SQLite WAL 持久化仓库。
 *
 * 设计意图：marker 必须跨重启存活，但磁盘上不能出现任何可读的会话内容，
 * 也不能出现能与 marker 直接关联的标识符。这一层负责四件事：
 *
 * 1. 整条 state 序列化成一个密文块（按账号派生的数据密钥 + 全字段 AAD）；
 * 2. 索引用**稳定域** HMAC binding，stateId 也只以 keyed lookup 摘要落库；
 * 3. 授权 + CAS + 写新代 + 记录 edge 映射 + 修剪，全部在单个事务内完成；
 * 4. DB 外部 identity sentinel，使"库被清零/删除"无法伪装成首次初始化。
 *
 * 交付语义（关键）：COMMIT 之后、marker 送达客户端之前进程可能被 SIGKILL。
 * 那一刻客户端手里还是旧输入，若不留幂等凭据，重试就会重打上游并产生第二条
 * 分叉。因此每次 COMMIT 都同事务写入一条**内容寻址的 edge**：
 *
 *   edge = (session/model, predecessor-或-root, compact 请求语义 digest, account binding, authorization binding)
 *
 *   - 客户端拿同样的输入重试时，edge 命中，直接幂等返回同一个 marker，不打上游；
 *   - 同一 predecessor 上 digest 不同的分叉各自成边，互不覆盖、各自都能成功；
 *   - 并发时先拿到写锁的一方成为 winner，loser 在同一事务内读到 winner 的 edge
 *     并原样回放它的 marker，零写入——因此"相同 edge 只会有一次 COMMIT"；
 *   - root（首次 compact）同样建边，它的 post-commit 崩溃窗口与后续完全一样。
 *
 * predecessor state **永远不在这里显式删除**。内容寻址之后一个 predecessor 可
 * 合法长出多条分叉，按 predecessor 回收会打掉兄弟分叉。改为：客户端真正用上
 * 某个 state 时（证明它收到了 marker），回收指向该 state 的所有 incoming edge；
 * 失去 edge 保护的旧 state 随后按正常 LRU/TTL 自然淘汰。
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

/**
 * 记录 schema 版本。任何不兼容的列变更都必须 +1。
 *
 * v5（8.4 sliding TTL）：新增 `expires_at_mac` 列；`expiresAt` 从 AAD 里
 * 移出，改用独立 MAC 保护（与 `last_used_mac` 同等待遇）。见 `buildAad()`
 * 的文档了解为什么、以及历史版本的 AAD 形状如何在迁移时仍然可重建。
 */
export const OPAQUE_REPOSITORY_SCHEMA_VERSION = 5;

/**
 * 能就地迁移到当前版本的最低历史 schema。
 *
 * v1 不在其列：它早于 successor 映射与账号域密钥派生，没有可无损重建的路径，
 * 遇到时必须 schema_unsupported 停机，而不是猜列布局。
 */
export const OPAQUE_REPOSITORY_MIN_MIGRATABLE_SCHEMA_VERSION = 2;

export type OpaqueCompactRepositoryFailure =
  | "store_unavailable"
  | "schema_unsupported"
  | "key_mismatch"
  | "state_corrupt"
  | "stale_generation"
  | "binding_mismatch"
  /** sentinel 表明 store 曾初始化，但库不见了/被清零。 */
  | "store_reset_detected"
  /**
   * 旧 schema → 当前 schema 的迁移失败。
   *
   * 刻意与 state_corrupt 分开：迁移失败时旧库**完整无损**（事务已回滚），
   * 正确动作是排查后重试升级；把它折叠成 state_corrupt 会诱导运维去做隔离
   * 或重建，白白丢掉一整份仍然可用的 state。
   */
  | "migration_failed"
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

/**
 * `load()` 的结构化结果。
 *
 * 历史上"行不存在"与"行存在但已过期(被本次调用删除)"被压平成同一个 `null`，
 * 调用方因此永远无法区分两者——两条语义完全不同的路径（"从来没有过"
 * vs "曾经有过、自然到期"）在持久化模式下被迫共用一个 reason。拆开之后
 * 上层才能把"过期"当作良性、可自愈的信号，而不是一刀切 fail-closed。
 */
export type OpaqueCompactLoadResult =
  | {
      kind: "found";
      plaintext: Buffer;
      meta: OpaqueCompactRecordMeta;
      /** 实际派生出数据密钥的账号——调用方必须与 payload 交叉验证。 */
      matchedAccountEntryId: string;
    }
  /** lookup 在表里完全没有对应行——从未存在过，或早已被删除。 */
  | { kind: "not_found" }
  /** 行存在、通过了完整认证，但 TTL 已过——本次调用已将其删除。 */
  | { kind: "expired" };

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
  edge_lookup: string;
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
  /** 8.4 sliding TTL：expires_at 的独立 MAC，与 last_used_mac 同等待遇。 */
  expires_at_mac: string;
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
 * 只认证 stateId/generation 是不够的：createdAt 决定创建时间，byteSize
 * 决定预算，account 决定归属——任何一项能被磁盘篡改而不被发现，都等于给攻击者
 * 一个操纵配额或归属的口子。用长度前缀 tuple 编码，杜绝字段分隔歧义。
 *
 * `schemaVersion` **必须由调用方显式传入**，不能内联当前常量：升级时同一行
 * 要先按旧版本 AAD 解封、再按新版本 AAD 重封，内联常量会让解封侧永远拿不到
 * 正确的 AAD。正常读写路径一律传 OPAQUE_REPOSITORY_SCHEMA_VERSION。
 *
 * ★ 8.4 sliding TTL：`expiresAt` 从 v5 起**不再进 AAD**（`schemaVersion >= 5`
 * 时整段跳过）。原因和 `computeMutableMetaMac` 文档里 `last_used_at` 不进 AAD
 * 的理由完全一样——sliding TTL 让 expires_at 变成了"每次成功 restore 都要写"
 * 的可变字段，如果继续留在 AAD 里，每次顺延都要重新封装整条密文（对 last_used_at
 * 早就否决过的做法，没理由为 expires_at 破例）。v5 起改用独立 MAC 保护
 * （`expires_at_mac` 列，与 `last_used_mac` 同等待遇）。
 *
 * `schemaVersion < 5` 时仍然把 `expiresAt` 塞进 tuple——这是为了让迁移路径
 * 能按**历史真实 AAD 形状**解封 v2/v3/v4 遗留密文；新写入/重新封装一律传
 * `OPAQUE_REPOSITORY_SCHEMA_VERSION`（现在是 5），自动落到新形状，调用方
 * 不需要关心这个条件分支。
 */
function buildAad(fields: {
  schemaVersion: number;
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
  const parts = [
    `schema:${fields.schemaVersion}`,
    fields.storeId,
    fields.keyId,
    fields.lookupDigest,
    String(fields.generation),
    fields.binding,
    fields.accountBinding,
    String(fields.createdAt),
  ];
  if (fields.schemaVersion < 5) {
    parts.push(String(fields.expiresAt));
  }
  parts.push(String(fields.byteSize), fields.predecessorLookup ?? "");
  return encodeTuple(parts);
}

/**
 * successor 映射（edge）的 AAD。字段集合与 state 行同样必须完整覆盖生命周期。
 *
 * `edgeLookup` 必须进 AAD：它是本行的主键，也是"这条映射属于哪一次内容寻址
 * compact"的唯一凭据。不认证它，攻击者就能把 A 分叉的密文整行搬到 B 分叉的
 * 主键下——AEAD 照样通过，客户端却会拿到另一条分叉的 marker。
 *
 * `predecessorLookup` 是 string 而非 nullable：root edge 用空串占位，
 * 保证 root 与非 root 走完全相同的认证路径，不给 null 分支留旁路。
 *
 * 与 buildAad 同理，`schemaVersion` 显式传入而不内联常量。
 */
function buildSuccessorAad(fields: {
  schemaVersion: number;
  storeId: string;
  keyId: string;
  edgeLookup: string;
  predecessorLookup: string;
  successorLookup: string;
  accountBinding: string;
  binding: string;
  createdAt: number;
  expiresAt: number;
  byteSize: number;
}): Buffer {
  return encodeTuple([
    `successor:${fields.schemaVersion}`,
    fields.storeId,
    fields.keyId,
    fields.edgeLookup,
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
  private readonly stmtDeleteSuccessorByTarget: StatementSync;
  private readonly stmtDeleteSuccessorByPredecessor: StatementSync;
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
         (lookup_digest, key_id, binding, generation, created_at, expires_at, expires_at_mac,
          last_used_at, last_used_mac, byte_size, account_binding, predecessor_lookup,
          nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // 8.4 sliding TTL：restore 成功时 last_used_at 与 expires_at 在同一条
    // UPDATE 里一起顺延，两者各自的 MAC 也一起重算——不需要额外包一层事务，
    // 单条语句本身就是原子的。
    this.stmtTouch = this.db.prepare(
      `UPDATE opaque_states
         SET last_used_at = ?, last_used_mac = ?, expires_at = ?, expires_at_mac = ?
       WHERE lookup_digest = ?`,
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
         (edge_lookup, predecessor_lookup, successor_lookup, key_id, account_binding, binding,
          created_at, expires_at, byte_size, nonce, tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSelectSuccessor = this.db.prepare(
      "SELECT * FROM opaque_successors WHERE edge_lookup = ?",
    );
    this.stmtDeleteSuccessor = this.db.prepare(
      "DELETE FROM opaque_successors WHERE edge_lookup = ?",
    );
    // 按 successor 目标删除 incoming edges：一个 state 被确认送达后，所有指向
    // 它的 edge 都失去意义（客户端已经不可能再拿旧输入重放到这里）。
    this.stmtDeleteSuccessorByTarget = this.db.prepare(
      "DELETE FROM opaque_successors WHERE successor_lookup = ?",
    );
    this.stmtDeleteSuccessorByPredecessor = this.db.prepare(
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
      if (
        !Number.isInteger(version) ||
        version > OPAQUE_REPOSITORY_SCHEMA_VERSION ||
        version < OPAQUE_REPOSITORY_MIN_MIGRATABLE_SCHEMA_VERSION
      ) {
        // 旧版本二进制遇到新 schema 只会读到无法解析的记录；必须停机而不是猜列布局。
        // 太旧（v1）同理：没有可无损重建的路径，猜列布局只会造出假数据。
        throw new OpaqueCompactRepositoryError(
          "schema_unsupported",
          `unsupported opaque state schema version ${existingVersion}`,
        );
      }
      const existingStoreId = readMeta("store_id");
      // sentinel 说 store 曾初始化，库里却没有身份 / 身份不符 → 库被换过或清零。
      // 这正是 integrity_check 检不出来的路径（清零库与全新空库不可区分）。
      // 身份校验必须在迁移**之前**：绝不能对一份不属于本 store 的库动手改写。
      if (existingStoreId === undefined || existingStoreId !== this.storeId) {
        throw new OpaqueCompactRepositoryError(
          "store_reset_detected",
          "database identity does not match the store sentinel",
        );
      }
      if (version !== OPAQUE_REPOSITORY_SCHEMA_VERSION) {
        this.migrateSchema(version);
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
      this.createCurrentSchemaObjects();
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

  /**
   * 当前版本的表与索引定义。首次初始化与迁移重建共用同一份 DDL——
   * 两处各写一遍迟早会漂移，而"迁移后的库与新建库形状不同"是最难查的一类 bug。
   */
  private createCurrentSchemaObjects(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_states (
         lookup_digest      TEXT PRIMARY KEY,
         key_id             TEXT NOT NULL,
         binding            TEXT NOT NULL,
         generation         INTEGER NOT NULL,
         created_at         INTEGER NOT NULL,
         expires_at         INTEGER NOT NULL,
         expires_at_mac     TEXT NOT NULL,
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
         edge_lookup        TEXT PRIMARY KEY,
         predecessor_lookup TEXT NOT NULL,
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
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_opaque_successor_target ON opaque_successors (successor_lookup)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_opaque_successor_predecessor ON opaque_successors (predecessor_lookup)",
    );
  }

  /**
   * 旧 schema（v2/v3）→ 当前 schema 的**原子**迁移。
   *
   * 设计意图：升级必须保住旧 marker 仍能 resolve 的那部分 state，但绝不能把
   * 旧的 predecessor→successor 单键映射伪造成新的内容寻址 edge。
   *
   * - **state 行**：列形状不变（除新增的 `expires_at_mac`），只是 AAD 里的
   *   `schema:N` 变了，v5 起 AAD 还少了 `expiresAt` 那一段（见 `buildAad()`
   *   文档）。因此逐行按旧版本 AAD 解封、按新版本 AAD 重封，plaintext 与全部
   *   元数据逐字保持；顺带把 v2 缺失的 last_used_mac、以及所有旧版本都没有的
   *   expires_at_mac（8.4 sliding TTL 新增列，任何历史版本都不存在，因此
   *   永远是回填场景，不像 last_used_mac 还要按列是否存在分支）用真实 MAC
   *   回填（`DEFAULT ''` 放行等于给 TTL 顺延留一个未认证的洞）。
   * - **successor 行**：旧表主键是 predecessor_lookup，根本不存在
   *   compactInputDigest / edge_lookup。想把它"升级"成 v4 edge，只能编一个
   *   通配或哨兵 digest —— 那会让任意一次不同输入的重试都命中这条边，拿到
   *   一个语义上根本不属于它的 marker。因此整表丢弃、按新形状重建：最坏结果
   *   只是升级后第一次 compact 少一层幂等保护，而不是发错 marker。
   *
   * 整个过程在**单个 BEGIN IMMEDIATE** 内完成，最后一步才改
   * `opaque_meta.schema_version`。任何异常都 ROLLBACK，因此崩溃后 SQLite/WAL
   * 恢复出来的只可能是「完整旧格式」或「完整新格式」，下一次启动要么继续迁移、
   * 要么正常打开，不存在半迁移状态。
   */
  private migrateSchema(fromVersion: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 拿到写锁之后复核版本：另一个进程可能刚刚迁移完（单实例锁之外还有
      // 手工运维路径），此时必须认已完成的结果而不是重做一遍。
      const current = Number(
        (
          this.db.prepare("SELECT value FROM opaque_meta WHERE key = 'schema_version'").get() as
            | { value: string }
            | undefined
        )?.value,
      );
      if (current === OPAQUE_REPOSITORY_SCHEMA_VERSION) {
        this.db.exec("COMMIT");
        return;
      }
      if (current !== fromVersion) {
        throw new Error(`schema version changed to ${String(current)} before migration`);
      }

      // v2 的真实历史里 last_used_mac 是后加的列，老库可能整列缺失。
      // 这一点必须按盘上实际形状判定，不能按版本号想当然。
      const hasLastUsedMac = (
        this.db.prepare("PRAGMA table_info(opaque_states)").all() as { name: string }[]
      ).some((column) => column.name === "last_used_mac");

      const rows = this.db
        .prepare(
          `SELECT lookup_digest, key_id, binding, generation, created_at, expires_at, last_used_at,
                  ${hasLastUsedMac ? "last_used_mac" : "'' AS last_used_mac"},
                  byte_size, account_binding, predecessor_lookup, nonce, tag, ciphertext
             FROM opaque_states`,
        )
        .all() as unknown as RecordRow[];

      // 先全部解封 + 重封再落盘：任何一行认证失败都要让整批回滚，不能"迁一半"。
      const resealed = rows.map((row) => this.resealRecordForMigration(row, fromVersion, hasLastUsedMac));

      // 旧 edge 表整体丢弃并按新形状重建。DROP 会连带清掉它的旧索引。
      this.db.exec("DROP TABLE IF EXISTS opaque_successors");
      this.db.exec("DROP TABLE IF EXISTS opaque_states");
      this.createCurrentSchemaObjects();

      const insert = this.db.prepare(
        `INSERT INTO opaque_states
           (lookup_digest, key_id, binding, generation, created_at, expires_at, expires_at_mac,
            last_used_at, last_used_mac, byte_size, account_binding, predecessor_lookup,
            nonce, tag, ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of resealed) {
        insert.run(
          row.lookup_digest,
          row.key_id,
          row.binding,
          row.generation,
          row.created_at,
          row.expires_at,
          row.expires_at_mac,
          row.last_used_at,
          row.last_used_mac,
          row.byte_size,
          row.account_binding,
          row.predecessor_lookup,
          row.nonce,
          row.tag,
          row.ciphertext,
        );
      }

      // 版本号最后写：它是"迁移已完成"的唯一权威标记。
      this.db
        .prepare("UPDATE opaque_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      // 迁移失败必须有自己的结构化原因：旧库此刻**完好无损**，
      // 报成 state_corrupt 会把"可以重试升级"误导成"数据已损坏"。
      throw new OpaqueCompactRepositoryError(
        "migration_failed",
        `migration from schema ${fromVersion} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 迁移单行：按旧版本 AAD 解封、按当前版本 AAD 重封。
   *
   * 认证一项都不能省。迁移是唯一一次全库重写的机会，若在这里放行未认证的行，
   * 等于用新密文给旧的篡改盖章——之后所有 recover 都会认为它合法。
   */
  private resealRecordForMigration(
    row: RecordRow,
    fromVersion: number,
    hasLastUsedMac: boolean,
  ): RecordRow {
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      throw new Error("record key id is not in the keyring");
    }
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    if (Number(row.byte_size) !== actualByteSize) {
      throw new Error("record byte size does not match");
    }
    const expectedMac = computeMutableMetaMac(
      this.keyring,
      row.lookup_digest,
      "last_used_at",
      row.last_used_at,
    );
    // 列存在就必须验：v2 后期已经带上了这一列，放行不匹配的 MAC 等于
    // 借迁移把运行期篡改洗白。列不存在（v2 早期）才是回填场景。
    if (hasLastUsedMac && row.last_used_mac !== expectedMac) {
      throw new Error("last_used_at is not authenticated");
    }

    const dataKey = deriveAccountKeyFromBinding(key, row.account_binding);
    const aadFields = {
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
    };
    const plaintext = openRecord(dataKey, buildAad({ schemaVersion: fromVersion, ...aadFields }), {
      nonce: Buffer.from(row.nonce),
      tag: Buffer.from(row.tag),
      ciphertext: Buffer.from(row.ciphertext),
    });
    const sealed = sealRecord(
      dataKey,
      buildAad({ schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION, ...aadFields }),
      plaintext,
    );
    // AES-GCM 密文长度恒等于明文长度，重封不得改变 byte_size；一旦改变，
    // 列值就会与已进 AAD 的 byteSize 漂移，下一次读取必然认证失败。
    const resealedSize = sealed.ciphertext.length + sealed.nonce.length + sealed.tag.length;
    if (resealedSize !== actualByteSize) {
      throw new Error("resealed record size drifted");
    }
    // expires_at_mac 是 8.4 新增列，任何历史 schema 版本都不存在——不像
    // last_used_mac 还要按列是否存在分支，这里永远是"从无到有"的回填，
    // 用当前行的 expires_at 值算出真实 MAC 即可（迁移本身不改变到期时间，
    // 只是把它从 AAD 移到独立 MAC 保护）。
    const expiresAtMac = computeMutableMetaMac(
      this.keyring,
      row.lookup_digest,
      "expires_at",
      row.expires_at,
    );
    return {
      ...row,
      last_used_mac: expectedMac,
      expires_at_mac: expiresAtMac,
      nonce: sealed.nonce,
      tag: sealed.tag,
      ciphertext: sealed.ciphertext,
    };
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

  /**
   * 内容寻址 edge 键。账号域与授权域必须直接进入索引，不能先用一个跨域 edge
   * 命中行、再靠解密候选事后筛选；否则 root 查询遍历账号时会把 A 的 winner
   * 当成 B 的回放结果，variant 变化也会永久撞上旧 marker。所有分量都经过稳定
   * 索引 HMAC，不会把账号、variant 或 digest 明文落盘。
   */
  edgeFor(
    sessionId: string,
    model: string,
    predecessorStateId: string | null,
    compactInputDigest: string,
    accountBinding: string,
    binding: string,
  ): string {
    return computeIndexBinding(this.keyring, [
      "edge",
      sessionId,
      model,
      predecessorStateId ?? "root",
      compactInputDigest,
      accountBinding,
      binding,
    ]);
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
   * 在单个事务里：edge 回放检查 → predecessor 认证 → CAS → 写新 generation →
   * 记录 edge 映射 → 修剪。只有本方法返回 `committed`（COMMIT 成功）之后，
   * 调用方才可以把新 marker 发给客户端。
   *
   * 返回 `replayed` 表示这条 edge 已经有 winner：并发或崩溃重试的 loser 必须
   * 原样交出 winner 的 marker，绝不能写入自己的候选 state——否则同一次逻辑
   * compact 会在盘上留下两条分叉，客户端拿到的 marker 也就不再唯一。
   *
   * 注意 predecessor **不在这里删除**——见文件头的交付语义说明。
   */
  saveWithCas(options: {
    stateId: string;
    binding: string;
    /** edge 的会话维度，与 bindingFor 使用同一组值。 */
    sessionId: string;
    model: string;
    accountEntryId: string;
    /** 回放 winner 时用于解封 edge 的账号候选集合。 */
    accountCandidates: readonly string[];
    expectedGeneration: number;
    plaintext: Buffer;
    createdAt: number;
    expiresAt: number;
    /** 本次 compact 所基于的 predecessor stateId（首次为 null）。 */
    predecessorStateId: string | null;
    /** 成功后要幂等回放的 marker 全文，加密后存入 edge 映射。 */
    successorMarker: string;
    /** 本次 compact 请求的语义摘要，edge 的内容寻址分量。 */
    compactInputDigest: string;
  }):
    | { kind: "committed"; generation: number; keyId: string; byteSize: number; lookupDigest: string }
    | { kind: "replayed"; marker: string; generation: number; lookupDigest: string } {
    const key = this.keyring.active();
    const lookupDigest = this.lookupFor(options.stateId);
    const accountBinding = this.accountBindingFor(options.accountEntryId);
    // root edge 的 predecessor 用空串占位：root 与非 root 因此走同一条认证
    // 路径，edge 表也不需要 nullable 主键分量。
    const predecessorLookup = options.predecessorStateId === null
      ? ""
      : this.lookupFor(options.predecessorStateId);
    const edgeLookup = this.edgeFor(
      options.sessionId,
      options.model,
      options.predecessorStateId,
      options.compactInputDigest,
      accountBinding,
      options.binding,
    );

    const dataKey = deriveAccountKey(this.keyring, key, options.accountEntryId);
    // byteSize 参与 AAD，必须在封装前定稿。
    const provisional = sealRecord(dataKey, Buffer.alloc(0), options.plaintext);
    const byteSize = provisional.ciphertext.length + provisional.nonce.length + provisional.tag.length;

    // 单条超预算必须在 COMMIT 之前拒绝：绝不能既落了行又返回失败，
    // 也不能返回一个指向被立刻淘汰的行的 marker。
    // root 现在同样写 edge 映射，因此 successorBytes 始终计入预算——
    // 按 root 不计会让 root 的实际占用超出 maxBytes 一个 marker 的量。
    const successorBytes = sealedSizeFor(Buffer.byteLength(options.successorMarker, "utf-8"));
    if (byteSize + successorBytes > this.maxBytes) {
      throw new OpaqueCompactRepositoryError("state_too_large");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. 回放检查必须在 BEGIN IMMEDIATE 之内：写锁已经拿到，此后不可能有
      //    另一个 writer 插进来，"查不到 winner" 与 "我来当 winner" 之间
      //    因此没有窗口。
      const winner = this.openEdgeMapping(
        edgeLookup,
        options.accountEntryId,
        accountBinding,
        options.binding,
      );
      if (winner !== null) {
        const targetRow = this.requireSuccessorTarget(winner.row, accountBinding, options.binding);
        this.db.exec("COMMIT");
        return {
          kind: "replayed",
          marker: winner.marker,
          generation: targetRow.generation,
          lookupDigest: winner.row.successor_lookup,
        };
      }

      // 2. 授权与 CAS 全部在同一事务内完成。
      let generation: number;
      if (options.predecessorStateId === null) {
        // root：没有前驱可比对，唯一可接受的期望代数就是 0。放行非 0 等于
        // 允许调用方凭空指定代数，CAS 就形同虚设。
        if (options.expectedGeneration !== 0) {
          throw new OpaqueCompactRepositoryError("stale_generation");
        }
        generation = 1;
      } else {
        const predecessor = this.authenticatePredecessorWithinTransaction(
          predecessorLookup,
          accountBinding,
          options.binding,
          options.expectedGeneration,
        );
        generation = predecessor.generation + 1;
      }

      // generation 由事务内的 predecessor 决定，因此 state 的 AAD 与封装
      // 都必须在这之后才能定稿。
      const sealed = sealRecord(
        dataKey,
        buildAad({
          schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
          storeId: this.storeId,
          keyId: key.id,
          lookupDigest,
          generation,
          binding: options.binding,
          accountBinding,
          createdAt: options.createdAt,
          expiresAt: options.expiresAt,
          byteSize,
          predecessorLookup: options.predecessorStateId === null ? null : predecessorLookup,
        }),
        options.plaintext,
      );

      this.stmtInsert.run(
        lookupDigest,
        key.id,
        options.binding,
        generation,
        options.createdAt,
        options.expiresAt,
        computeMutableMetaMac(this.keyring, lookupDigest, "expires_at", options.expiresAt),
        options.createdAt,
        computeMutableMetaMac(this.keyring, lookupDigest, "last_used_at", options.createdAt),
        byteSize,
        accountBinding,
        options.predecessorStateId === null ? null : predecessorLookup,
        sealed.nonce,
        sealed.tag,
        sealed.ciphertext,
      );

      // 3. edge → successor marker 的加密映射，与 state 行同事务落盘。
      //    root 也要写：否则 root compact 的"COMMIT 成功但响应没送达"没有任何
      //    幂等凭据，客户端重试只能重打上游并产生第二条分叉。
      const sealedMarker = sealRecord(
        dataKey,
        buildSuccessorAad({
          schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
          storeId: this.storeId,
          keyId: key.id,
          edgeLookup,
          predecessorLookup,
          successorLookup: lookupDigest,
          accountBinding,
          binding: options.binding,
          createdAt: options.createdAt,
          expiresAt: options.expiresAt,
          byteSize: successorBytes,
        }),
        Buffer.from(options.successorMarker, "utf-8"),
      );
      this.stmtInsertSuccessor.run(
        edgeLookup,
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

      this.pruneWithinTransaction(
        options.createdAt,
        lookupDigest,
        options.predecessorStateId === null ? null : predecessorLookup,
      );
      this.db.exec("COMMIT");
      return { kind: "committed", generation, keyId: key.id, byteSize, lookupDigest };
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
  }

  /**
   * 事务内认证 predecessor 并做 CAS。
   *
   * 这里刻意**不**用 `currentGeneration(binding)` 做 CAS：那只看 binding 下的
   * 最大代数，同一 binding 上的两条合法分叉会互相判定为 stale。内容寻址之后
   * 正确的授权对象是"客户端手里这一条 predecessor"本身——它必须存在、属于
   * 当前账号与 binding、代数恰好等于期望值，且自身通过完整 AEAD 认证。
   */
  private authenticatePredecessorWithinTransaction(
    predecessorLookup: string,
    accountBinding: string,
    binding: string,
    expectedGeneration: number,
  ): { generation: number } {
    const row = this.stmtSelectByLookup.get(predecessorLookup) as RecordRow | undefined;
    // 缺失 predecessor 必须 fail-closed：无凭据地放行等于允许任何人凭一个
    // 编造的 predecessorStateId 往这个 binding 上挂新 state。
    if (row === undefined) {
      throw new OpaqueCompactRepositoryError("stale_generation", "predecessor state is gone");
    }
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      throw new OpaqueCompactRepositoryError("key_mismatch", "predecessor key id is not in the keyring");
    }
    if (row.account_binding !== accountBinding) {
      throw new OpaqueCompactRepositoryError("binding_mismatch", "predecessor belongs to another account");
    }
    if (row.binding !== binding) {
      throw new OpaqueCompactRepositoryError("binding_mismatch", "predecessor belongs to another variant");
    }
    if (row.generation !== expectedGeneration) {
      throw new OpaqueCompactRepositoryError("stale_generation");
    }
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    if (Number(row.byte_size) !== actualByteSize) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "predecessor byte size does not match");
    }
    if (
      row.last_used_mac !==
      computeMutableMetaMac(this.keyring, row.lookup_digest, "last_used_at", row.last_used_at)
    ) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "predecessor last_used_at is not authenticated");
    }
    try {
      openRecord(
        deriveAccountKeyFromBinding(key, row.account_binding),
        buildAad({
          schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
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
      throw new OpaqueCompactRepositoryError("state_corrupt", "predecessor failed AEAD verification");
    }
    // 认证之后 expires_at 才可信。过期的 predecessor 不能再派生新代。
    if (row.expires_at <= this.now()) {
      throw new OpaqueCompactRepositoryError("stale_generation", "predecessor has expired");
    }
    return { generation: row.generation };
  }

  /**
   * 解封并全量认证一条 edge。返回 null 表示"没有可回放的映射"（行不存在，
   * 或已认证为过期并就地删除）——这是正常的首次 compact 路径。
   *
   * 其余任何失败都必须抛错而不是返回 null：装作没有映射会让调用方重打一次
   * 上游，随后撞上 stale_generation，把真正的损坏原因彻底掩盖。
   */
  private openEdgeMapping(
    edgeLookup: string,
    accountEntryId: string,
    expectedAccountBinding: string,
    expectedBinding: string,
  ): { marker: string; row: SuccessorRow } | null {
    const row = this.stmtSelectSuccessor.get(edgeLookup) as unknown as SuccessorRow | undefined;
    if (row === undefined) return null;

    if (row.account_binding !== expectedAccountBinding || row.binding !== expectedBinding) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "edge authorization binding does not match its lookup");
    }
    const key = this.keyring.get(row.key_id);
    if (key === undefined) {
      throw new OpaqueCompactRepositoryError("key_mismatch", "edge key id is not in the keyring");
    }
    const actualByteSize = row.ciphertext.length + row.nonce.length + row.tag.length;
    if (Number(row.byte_size) !== actualByteSize) {
      throw new OpaqueCompactRepositoryError("state_corrupt", "edge byte size does not match");
    }

    let marker: string;
    try {
      marker = openRecord(
          deriveAccountKey(this.keyring, key, accountEntryId),
          buildSuccessorAad({
            schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
            storeId: this.storeId,
            keyId: row.key_id,
            edgeLookup: row.edge_lookup,
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
      throw new OpaqueCompactRepositoryError("state_corrupt", "edge failed AEAD verification");
    }

    if (row.expires_at <= this.now()) {
      this.stmtDeleteSuccessor.run(row.edge_lookup);
      return null;
    }
    if (this.validateSuccessorMarker !== null &&
        !this.validateSuccessorMarker(marker, row.successor_lookup)) {
      throw new OpaqueCompactRepositoryError(
        "state_corrupt",
        "edge mapping does not contain a valid marker for its target",
      );
    }
    return { marker, row };
  }

  /** 已认证 edge 的 target state 必须存在，且属于同一账号与授权域。 */
  private requireSuccessorTarget(
    row: SuccessorRow,
    expectedAccountBinding: string,
    expectedBinding: string,
  ): RecordRow {
    const target = this.stmtSelectByLookup.get(row.successor_lookup) as RecordRow | undefined;
    if (target === undefined) {
      // edge 已认证但目标 state 不在了：这不是"没有映射"，而是 store 自相
      // 矛盾。返回 null 会让调用方重打上游并撞上 stale_generation，把真正
      // 的原因掩盖掉。
      throw new OpaqueCompactRepositoryError(
        "state_corrupt",
        "edge mapping points at a state that no longer exists",
      );
    }
    if (target.account_binding !== expectedAccountBinding || target.binding !== expectedBinding) {
      throw new OpaqueCompactRepositoryError(
        "state_corrupt",
        "edge target authorization binding does not match",
      );
    }
    return target;
  }

  /**
   * 幂等回放：内容寻址查询这条 edge 是否已经产生过 successor。
   *
   * edge = (session/model, predecessor-或-root, compact 语义 digest, account binding,
   * authorization binding)。这些分量齐全
   * 才能区分"同一次 compact 的重试"与"同一 predecessor 上的另一条分叉"——
   * 前者必须回放同一个 marker，后者必须各自成功。
   *
   * root（predecessorStateId=null）同样支持：首次 compact 的 post-commit 崩溃
   * 窗口与后续 compact 完全一样需要幂等凭据。
   */
  findSuccessorMarker(options: {
    sessionId: string;
    model: string;
    predecessorStateId: string | null;
    compactInputDigest: string;
    binding: string;
    accountCandidates: readonly string[];
  }): string | null {
    for (const accountEntryId of options.accountCandidates) {
      const accountBinding = this.accountBindingFor(accountEntryId);
      const edgeLookup = this.edgeFor(
        options.sessionId,
        options.model,
        options.predecessorStateId,
        options.compactInputDigest,
        accountBinding,
        options.binding,
      );
      const winner = this.openEdgeMapping(
        edgeLookup,
        accountEntryId,
        accountBinding,
        options.binding,
      );
      if (winner === null) continue;
      this.requireSuccessorTarget(winner.row, accountBinding, options.binding);
      return winner.marker;
    }
    return null;
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
   * 2. 认证通过后才验证 expires_at_mac，确认 expires_at 列本身没被篡改；
   * 3. 只有 1、2 都过了才敢相信 expires_at 做 TTL 判定与删除，或者顺延它。
   *
   * 反过来（先信任 expires_at 再解封/验 MAC）会给磁盘攻击者一条捷径：把
   * expires_at 改早即可让损坏记录被静默删除，绕过 state_corrupt 并销毁证据；
   * 或者改晚来延长一个本该过期的记录的寿命而不留痕迹。所有依赖元数据的
   * 删除/顺延动作都必须在认证之后。
   *
   * `accountCandidates` 是当前进程已知的账号集合。数据密钥按账号派生，
   * 候选里没有匹配账号 → 该记录不属于本实例可访问的任何账号，fail-closed。
   *
   * `slideTtlMs`：8.4 sliding TTL。restore 成功（即将返回 `kind: "found"`）时，
   * 把 `expires_at` 顺延到 `now() + slideTtlMs`，与 `last_used_at` 在同一条
   * UPDATE 里一起写、各自的 MAC 也一起重算——不是"读取后再补一次写"，是同一
   * 次 touch 的两个字段。团队安全复核结论（供实现对照，不一致需要停下重新
   * 评估）：把 expires_at 移出 AAD、改用独立 MAC 保护后，攻击者能做的至多是
   * 重放这一行**自己曾经合法达到过**的某个 (expires_at, mac) 对——MAC 绑定了
   * lookupDigest + 字段名 + 值，无法跨行搬运、无法伪造未曾出现过的新值
   * （需要 keyring）。也就是说残余风险只是"把寿命改回更早"（DoS 量级，与
   * last_used_at 现有风险同构），而不是"推到从未合法达到过的更晚时间"。
   */
  load(stateId: string, accountCandidates: readonly string[], slideTtlMs: number): OpaqueCompactLoadResult {
    const lookupDigest = this.lookupFor(stateId);
    const row = this.stmtSelectByLookup.get(lookupDigest) as RecordRow | undefined;
    if (row === undefined) return { kind: "not_found" };

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
        schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
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
      // 8.4：expires_at 现在也是可变字段（sliding TTL），与 last_used_at 同等
      // 待遇——同样必须在信任它、或用它顺延之前先验旧 MAC，理由完全一样。
      if (
        row.expires_at_mac !==
        computeMutableMetaMac(this.keyring, row.lookup_digest, "expires_at", row.expires_at)
      ) {
        throw new OpaqueCompactRepositoryError("state_corrupt", "expires_at is not authenticated");
      }

      // 认证通过之后才敢相信 expires_at，此时删除过期记录是安全的。
      if (row.expires_at <= this.now()) {
        this.deleteStateInOwnTransaction(lookupDigest);
        return { kind: "expired" };
      }

      // 8.4 sliding TTL：restore 成功 = 顺延，而不是仅仅 touch last_used_at。
      // 新值与新 MAC 在同一条 UPDATE 里一起写——单条语句本身就是原子的，
      // 不需要额外包一层事务。
      const touchedAt = this.now();
      const slidExpiresAt = touchedAt + slideTtlMs;
      this.stmtTouch.run(
        touchedAt,
        computeMutableMetaMac(this.keyring, lookupDigest, "last_used_at", touchedAt),
        slidExpiresAt,
        computeMutableMetaMac(this.keyring, lookupDigest, "expires_at", slidExpiresAt),
        lookupDigest,
      );
      return {
        kind: "found",
        plaintext,
        matchedAccountEntryId: account,
        meta: {
          lookupDigest: row.lookup_digest,
          keyId: row.key_id,
          binding: row.binding,
          generation: row.generation,
          createdAt: row.created_at,
          // 顺延后的新值，不是这一行刚刚被认证时读到的旧值——调用方看到的
          // 应该是"这次 restore 之后"的真实状态。
          expiresAt: slidExpiresAt,
          byteSize: actualByteSize,
          predecessorLookup: row.predecessor_lookup,
        },
      };
    }
    throw new OpaqueCompactRepositoryError("binding_mismatch", "record belongs to another account");
  }

  /**
   * 确认客户端已经用上这个 state：回收所有指向它的 incoming edge。
   *
   * 刻意**不**在这里删除 predecessor state 本身。内容寻址之后同一个
   * predecessor 可以合法地长出多条分叉（不同 digest 各自成边），一条分叉被
   * 确认送达并不代表其他分叉不再需要这个共同前驱——按 predecessor 删除会把
   * 兄弟分叉的幂等回放和 restore 一起打掉。
   *
   * 失去 incoming edge 之后，predecessor 不再受 prune 的保护集合覆盖，会按
   * 正常 LRU/TTL 自然回收，容量语义因此仍然收敛。
   */
  confirmSuccessorUsed(meta: OpaqueCompactRecordMeta): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.stmtDeleteSuccessorByTarget.run(meta.lookupDigest);
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

  /** 在已有事务内原子删除 state 及所有关联 edge；不递归删除 successor state。 */
  private deleteStateWithinTransaction(lookupDigest: string): void {
    this.stmtDeleteSuccessorByTarget.run(lookupDigest);
    this.stmtDeleteSuccessorByPredecessor.run(lookupDigest);
    this.stmtDeleteByLookup.run(lookupDigest);
  }

  private deleteStateInOwnTransaction(lookupDigest: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteStateWithinTransaction(lookupDigest);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 事务已结束 */
      }
      throw new OpaqueCompactRepositoryError(
        "store_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  deleteByStateId(stateId: string): void {
    this.deleteStateInOwnTransaction(this.lookupFor(stateId));
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
            schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
            storeId: this.storeId,
            keyId: row.key_id,
            edgeLookup: row.edge_lookup,
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
      // 删除按主键走：edge 表现在以 edge_lookup 为主键，同一 predecessor 上
      // 可能挂着多条分叉，按 predecessor 删会连带清掉尚未过期的兄弟边。
      if (row.expires_at <= now) expiredSuccessors.push(row.edge_lookup);
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
      // 8.4：expires_at 现在同样可变（sliding TTL），同等待遇——冷启动扫描
      // 也要验证它的独立 MAC，否则攻击者篡改这一列就能在离线状态下伪造一个
      // 从未合法达到过的到期时间，且不会被 recover() 发现。
      if (
        row.expires_at_mac !==
        computeMutableMetaMac(this.keyring, row.lookup_digest, "expires_at", row.expires_at)
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
            schemaVersion: OPAQUE_REPOSITORY_SCHEMA_VERSION,
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
    if (unreadable === 0 && (expiredLookups.length > 0 || expiredSuccessors.length > 0)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const lookup of expiredLookups) {
          this.deleteStateWithinTransaction(lookup);
        }
        for (const lookup of expiredSuccessors) {
          this.stmtDeleteSuccessor.run(lookup);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* 事务已结束 */
        }
        throw new OpaqueCompactRepositoryError(
          "store_unavailable",
          error instanceof Error ? error.message : String(error),
        );
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
   * state 容量与总磁盘字节统计。
   *
   * `capacity` 的单位始终是可恢复的 state 数量；edge 是 state 的交付凭据，不能
   * 因为 root edge 也落盘就把一条 state 算成两个容量单位。否则 capacity=1 连
   * 首次 compact 都无法提交。edge 仍必须计入 bytes，防止映射绕过 maxBytes。
   */
  stats(): { count: number; bytes: number } {
    const row = this.stmtTotals.get() as { count: number; bytes: number } | undefined;
    const successors = this.stmtSuccessorTotals.get() as
      | { count: number; bytes: number }
      | undefined;
    return {
      count: Number(row?.count ?? 0),
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
      // 只保护当前事务刚写入的行及其 predecessor。其他 victim 若有关联 edge，
      // 统一删除 helper 会在同一事务中先清 incoming/outgoing edge 再删 state，
      // 因而既能收敛容量，也不会留下指向不存在 state 的幂等凭据。
      const victim = this.db
        .prepare(
          `SELECT lookup_digest, last_used_at, last_used_mac FROM opaque_states
           WHERE lookup_digest <> ?
             AND (? IS NULL OR lookup_digest <> ?)
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
      this.deleteStateWithinTransaction(victim.lookup_digest);
    }
    throw new OpaqueCompactRepositoryError("state_too_large", "prune did not converge");
  }
}
