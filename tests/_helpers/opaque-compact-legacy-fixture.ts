/**
 * 历史 schema（v2 / v3）的 opaque store fixture。
 *
 * 为什么要手工复刻旧库而不是"跑一遍旧代码"：旧写入路径已经随版本演进被改写，
 * 仓库里不再有能产出 v2/v3 磁盘布局的代码。迁移测试如果拿当前实现造库，测的
 * 就只是"新格式读新格式"，一个字节的升级语义都没覆盖。
 *
 * 因此这里按 git 历史里的**真实**旧实现逐字复刻：
 *
 * | 版本 | opaque_states                | opaque_successors 主键        | state AAD 前缀 |
 * |------|------------------------------|-------------------------------|----------------|
 * | v2   | 无 last_used_mac 列（e790f0b）| predecessor_lookup            | `schema:2`     |
 * | v3   | 有 last_used_mac 列           | predecessor_lookup            | `schema:3`     |
 * | v4   | 有 last_used_mac 列           | edge_lookup（内容寻址）        | `schema:4`     |
 *
 * 关键事实（迁移实现依赖它，不能凭印象）：v2→v3→v4 的 **state 行列形状与 AAD
 * 字段集合完全一致**，唯一变化是 AAD 首段的 `schema:N`。v2 早期缺 last_used_mac
 * 那一列是历史上后补的（4d2ef3d 加列但没提版本号），所以 v2 库两种形状都可能
 * 存在——fixture 用 `includeLastUsedMac` 显式覆盖两种。
 *
 * successor 表则在 v4 被彻底换成内容寻址（edge_lookup + compactInputDigest），
 * 旧行没有 digest 分量，无法无损升级，只能整表丢弃——fixture 照样种进去，好让
 * 测试能断言"旧 edge 确实被丢弃且没有变成通配边"。
 *
 * ★ 8.4 新增 v4 支持：`migrateSchema()` 对 fromVersion 完全不做 v3/v4 区分
 * （state 行走同一套 `resealRecordForMigration`，successor 表不论源版本
 * 一律整表丢弃重建），所以这里复刻 v4 时 state 行直接复用 v3 的列形状
 * （两者本就相同，唯一差异是 AAD 里的 `schema:N`），successor 行也复用
 * v3 的 fixture 形状——反正会被丢弃，不影响"state 行迁移+回填"这个被测目标。
 */

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  computeIndexBinding,
  computeLookupDigest,
  computeMarkerSignature,
  computeMutableMetaMac,
  deriveAccountKey,
  encodeTuple,
  loadOpaqueCompactKeyring,
  sealRecord,
  sealedSizeFor,
  type OpaqueCompactKeyring,
} from "@src/routes/shared/opaque-compact-keyring.js";
import {
  commitOpaqueCompactSentinel,
  loadOpaqueCompactSentinel,
} from "@src/routes/shared/opaque-compact-sentinel.js";

const MARKER_PREFIX = "codex-opaque-state:v1";
const MARKER_ANALYSIS = "Opaque compact state retained locally.";

/** 落盘 payload 的 schema 版本。v2 时代至今未变，因此迁移只需处理记录 AAD。 */
const PERSISTED_PAYLOAD_VERSION = 2;

export interface LegacySeedOptions {
  /** store 目录（放 state.db 与 store.sentinel）。 */
  dir: string;
  /** 密钥环文件（必须在 store 目录之外）。 */
  keyringFile: string;
  /** 要复刻的历史 schema 版本。 */
  schemaVersion: 2 | 3 | 4;
  /**
   * v2 库是否已经带上 last_used_mac 列。
   * 默认按最初的 v2（e790f0b）——整列缺失，迁移必须回填真实 MAC。
   * v3/v4 强制为 true。
   */
  includeLastUsedMac?: boolean;
  sessionId?: string;
  model?: string;
  accountEntryId?: string;
  variantHash?: string;
  output?: unknown[];
  preservedTail?: unknown[];
  now?: number;
  ttlMs?: number;
  /**
   * 除了主记录之外，额外再种几条独立的旧格式 canary 记录（各自独立的
   * stateId/session/marker，共享同一把 keyring/sentinel/schema）。
   *
   * 用途：`migrateSchema()` 是 `rows.map(row => resealRecordForMigration(...))`，
   * 单条记录的迁移测试结构上无法验证"多条记录中某一条 reseal 失败时，已经
   * 处理成功的其他行是否真的一并回滚，而不是部分落盘"——这只是论证不是验证。
   * 传 >0 才能在迁移测试里手工损坏其中一条（篡改 AEAD tag 或 last_used_mac），
   * 断言整体 ROLLBACK 且健康的那几条也没有提前落盘。默认 0，不影响现有单记录
   * 调用方的行为。
   */
  extraRecords?: number;
}

export interface LegacySeedResult {
  keyring: OpaqueCompactKeyring;
  storeId: string;
  databasePath: string;
  /** 旧库里那条 state 的 marker 全文——迁移后必须仍然可 resolve。 */
  marker: string;
  stateId: string;
  lookupDigest: string;
  /** 旧 successor 行的 predecessor_lookup（等于上面的 lookupDigest）。 */
  legacySuccessorPredecessor: string;
  sessionId: string;
  model: string;
  accountEntryId: string;
  variantHash: string;
  output: unknown[];
  preservedTail: unknown[];
  createdAt: number;
  expiresAt: number;
  /**
   * 本次调用种下的**全部**记录（主记录 + `extraRecords`），主记录是 `records[0]`
   * 且与本对象顶层字段一一对应。`extraRecords` 未传或为 0 时只有一个元素。
   */
  records: LegacySeedRecord[];
}

/** 单条种下的 canary 记录的关键定位信息，供多记录迁移测试挑选"篡改哪一条"。 */
export interface LegacySeedRecord {
  stateId: string;
  lookupDigest: string;
  marker: string;
  sessionId: string;
  model: string;
  accountEntryId: string;
  variantHash: string;
  output: unknown[];
  preservedTail: unknown[];
  createdAt: number;
  expiresAt: number;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

/** 与 state 层同一套 compHash 定义。 */
function statePayloadHash(output: unknown[], preservedTail: unknown[]): string {
  return base64Url(
    createHash("sha256").update(JSON.stringify({ output, preservedTail })).digest(),
  );
}

/** v2/v3 的 state AAD：字段集合与 v4 相同，只有首段 `schema:N` 不同。 */
function legacyStateAad(fields: {
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
  return encodeTuple([
    `schema:${fields.schemaVersion}`,
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

/**
 * v2/v3 的 successor AAD。
 * v3 比 v2 多一个 successorLookup 分量（4d2ef3d 引入），两者都**没有** edgeLookup。
 */
function legacySuccessorAad(fields: {
  schemaVersion: 2 | 3 | 4;
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
  const parts = [
    `successor:${fields.schemaVersion}`,
    fields.storeId,
    fields.keyId,
    fields.predecessorLookup,
    ...(fields.schemaVersion >= 3 ? [fields.successorLookup] : []),
    fields.accountBinding,
    fields.binding,
    String(fields.createdAt),
    String(fields.expiresAt),
    String(fields.byteSize),
  ];
  return encodeTuple(parts);
}

const DEFAULT_OUTPUT = [
  { type: "reasoning", encrypted_content: "encrypted-content-canary-7a10", summary: [] },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "opaque-output-canary-c93e" }],
  },
];

const DEFAULT_TAIL = [
  { type: "function_call", call_id: "tool-1", name: "Read", arguments: "{}" },
  { type: "function_call_output", call_id: "tool-1", output: "preserved-tail-canary-2d64" },
];

/**
 * 造一份**完整可用**的旧格式 store：sentinel 已 ready、keyring 已就绪、
 * DB 是纯粹的 v2/v3 形状，里面有一条能用 marker 取回的 state 和一条旧 successor。
 */
export function seedLegacyOpaqueStore(options: LegacySeedOptions): LegacySeedResult {
  const {
    dir,
    keyringFile,
    schemaVersion,
    sessionId = "session-canary-8f2a",
    model = "gpt-5.4",
    accountEntryId = "entry-canary-51bd",
    variantHash = "variant-canary-b7f3",
    output = DEFAULT_OUTPUT,
    preservedTail = DEFAULT_TAIL,
    now = Date.now(),
    ttlMs = 30 * 60_000,
    extraRecords = 0,
  } = options;
  const includeLastUsedMac = schemaVersion >= 3 ? true : options.includeLastUsedMac ?? false;

  const keyring = loadOpaqueCompactKeyring({
    keyringFile,
    allowCreate: true,
    stateTtlMs: ttlMs,
  });
  const key = keyring.active();

  // sentinel 必须是 ready：真实升级场景里 store 早已完整初始化过。
  const sentinelFile = resolve(dir, "store.sentinel");
  const sentinel = loadOpaqueCompactSentinel(sentinelFile, { allowCreate: true })!;
  commitOpaqueCompactSentinel(sentinelFile, sentinel.storeId, () => now);
  const storeId = sentinel.storeId;

  const databasePath = resolve(dir, "state.db");
  const db = new DatabaseSync(databasePath);
  const records: LegacySeedRecord[] = [];
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_states (
         lookup_digest      TEXT PRIMARY KEY,
         key_id             TEXT NOT NULL,
         binding            TEXT NOT NULL,
         generation         INTEGER NOT NULL,
         created_at         INTEGER NOT NULL,
         expires_at         INTEGER NOT NULL,
         last_used_at       INTEGER NOT NULL,
         ${includeLastUsedMac ? "last_used_mac      TEXT NOT NULL," : ""}
         byte_size          INTEGER NOT NULL,
         account_binding    TEXT NOT NULL,
         predecessor_lookup TEXT,
         nonce              BLOB NOT NULL,
         tag                BLOB NOT NULL,
         ciphertext         BLOB NOT NULL
       )`,
    );
    // 旧 successor 表：主键是 predecessor_lookup，没有 edge_lookup。
    db.exec(
      `CREATE TABLE IF NOT EXISTS opaque_successors (
         predecessor_lookup TEXT PRIMARY KEY,
         ${schemaVersion >= 3 ? "successor_lookup   TEXT NOT NULL," : ""}
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
    db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_binding ON opaque_states (binding)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_opaque_expires ON opaque_states (expires_at)");
    db.prepare("INSERT INTO opaque_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(schemaVersion));
    db.prepare("INSERT INTO opaque_meta (key, value) VALUES ('store_id', ?)").run(storeId);

    // 主记录 + extraRecords 条独立记录，逐条插入。每条记录独立生成 stateId
    // （因此 lookup_digest 天然不同），session 加数字后缀避免 binding 撞车，
    // 其余参数（model/accountEntryId/variantHash/output/preservedTail/
    // createdAt/ttl）共享，保持这个 fixture 的既有语义不变。
    for (let index = 0; index <= extraRecords; index += 1) {
      const recordSessionId = index === 0 ? sessionId : `${sessionId}-extra-${index}`;

      const stateId = base64Url(randomBytes(24));
      const compHash = statePayloadHash(output, preservedTail);
      const signature = base64Url(
        computeMarkerSignature(key, `${MARKER_PREFIX}:${stateId}:${compHash}`),
      );
      const marker =
        `<analysis>${MARKER_ANALYSIS}</analysis>\n` +
        `<summary>${MARKER_PREFIX}:${stateId}:${compHash}:${signature}</summary>`;

      const createdAt = now;
      const expiresAt = now + ttlMs;
      const lookupDigest = computeLookupDigest(keyring, stateId);
      const binding = computeIndexBinding(keyring, ["state", recordSessionId, model, variantHash]);
      const accountBinding = computeIndexBinding(keyring, ["account", accountEntryId]);
      const generation = 1;

      const payload = Buffer.from(
        JSON.stringify({
          version: PERSISTED_PAYLOAD_VERSION,
          output,
          preservedTail,
          sessionId: recordSessionId,
          model,
          accountEntryId,
          variantHash,
          compHash,
          createdAt,
          expiresAt,
        }),
        "utf-8",
      );
      const byteSize = sealedSizeFor(payload.length);
      const dataKey = deriveAccountKey(keyring, key, accountEntryId);
      const sealed = sealRecord(
        dataKey,
        legacyStateAad({
          schemaVersion,
          storeId,
          keyId: key.id,
          lookupDigest,
          generation,
          binding,
          accountBinding,
          createdAt,
          expiresAt,
          byteSize,
          predecessorLookup: null,
        }),
        payload,
      );

      const stateColumns = [
        "lookup_digest",
        "key_id",
        "binding",
        "generation",
        "created_at",
        "expires_at",
        "last_used_at",
        ...(includeLastUsedMac ? ["last_used_mac"] : []),
        "byte_size",
        "account_binding",
        "predecessor_lookup",
        "nonce",
        "tag",
        "ciphertext",
      ];
      db.prepare(
        `INSERT INTO opaque_states (${stateColumns.join(", ")})
         VALUES (${stateColumns.map(() => "?").join(", ")})`,
      ).run(
        lookupDigest,
        key.id,
        binding,
        generation,
        createdAt,
        expiresAt,
        createdAt,
        ...(includeLastUsedMac
          ? [computeMutableMetaMac(keyring, lookupDigest, "last_used_at", createdAt)]
          : []),
        byteSize,
        accountBinding,
        null,
        sealed.nonce,
        sealed.tag,
        sealed.ciphertext,
      );

      // 旧 edge：predecessor 就是上面那条 state（历史实现允许自指的链式映射，
      // 这里只需要一条格式正确的旧行，用来断言迁移把它整表丢弃）。
      const legacyMarkerBytes = Buffer.from(marker, "utf-8");
      const successorBytes = sealedSizeFor(legacyMarkerBytes.length);
      const sealedSuccessor = sealRecord(
        dataKey,
        legacySuccessorAad({
          schemaVersion,
          storeId,
          keyId: key.id,
          predecessorLookup: lookupDigest,
          successorLookup: lookupDigest,
          accountBinding,
          binding,
          createdAt,
          expiresAt,
          byteSize: successorBytes,
        }),
        legacyMarkerBytes,
      );
      const successorColumns = [
        "predecessor_lookup",
        ...(schemaVersion >= 3 ? ["successor_lookup"] : []),
        "key_id",
        "account_binding",
        "binding",
        "created_at",
        "expires_at",
        "byte_size",
        "nonce",
        "tag",
        "ciphertext",
      ];
      db.prepare(
        `INSERT INTO opaque_successors (${successorColumns.join(", ")})
         VALUES (${successorColumns.map(() => "?").join(", ")})`,
      ).run(
        lookupDigest,
        ...(schemaVersion >= 3 ? [lookupDigest] : []),
        key.id,
        accountBinding,
        binding,
        createdAt,
        expiresAt,
        successorBytes,
        sealedSuccessor.nonce,
        sealedSuccessor.tag,
        sealedSuccessor.ciphertext,
      );

      records.push({
        stateId,
        lookupDigest,
        marker,
        sessionId: recordSessionId,
        model,
        accountEntryId,
        variantHash,
        output,
        preservedTail,
        createdAt,
        expiresAt,
      });
    }
  } finally {
    db.close();
  }

  const primary = records[0]!;
  return {
    keyring,
    storeId,
    databasePath,
    marker: primary.marker,
    stateId: primary.stateId,
    lookupDigest: primary.lookupDigest,
    legacySuccessorPredecessor: primary.lookupDigest,
    sessionId: primary.sessionId,
    model: primary.model,
    accountEntryId: primary.accountEntryId,
    variantHash: primary.variantHash,
    output: primary.output,
    preservedTail: primary.preservedTail,
    createdAt: primary.createdAt,
    expiresAt: primary.expiresAt,
    records,
  };
}
