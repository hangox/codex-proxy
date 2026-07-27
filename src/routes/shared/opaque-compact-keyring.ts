/**
 * Opaque compact state 的稳定主密钥环（master key ring）。
 *
 * 设计意图：opaque marker 必须在进程重启、升级、部署之后仍然可用，因此
 * 签名密钥和记录加密密钥都不能由 `randomBytes()` 在进程内生成，而要来自
 * 一份外部稳定、可轮换的密钥环文件。
 *
 * 三个密钥域，**轮换行为刻意不同**：
 *
 * - `marker-hmac`（随轮换）：marker 签名。旧 key 在 retention 窗口内继续参与验签。
 * - `record-aead`（随轮换）：记录加密根，再按 account 二次派生出每账号数据密钥。
 * - `index-root`（**不随轮换**）：索引/CAS 绑定。这一项必须跨 rotation 稳定，
 *   否则同一逻辑会话在轮换后算出不同 binding，CAS 看不到旧代，会同时存在两个
 *   active state 并绕过 stale-loser 串行化。indexRoot 独立存储、独立 HKDF info，
 *   与 marker/AEAD 域仍然完全分离。
 *
 * 其它硬约束：
 * - 已有落盘状态时绝不自动创建密钥环（丢密钥≠可以重来，那会把既有密文变成垃圾）。
 * - previous key 按 `retiredAt + retention` 退役，而不是按 `createdAt`：一把用了
 *   很久才轮换的 key，在轮换瞬间其 createdAt 早已超过 TTL，按创建时间会把它
 *   立即丢弃，而它几分钟前签发的 marker 仍在有效期内。
 * - keyring 创建/轮换是关键 durable commit，目录 fsync 失败必须报错，不能吞。
 */

import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
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

/** 密钥环文件格式版本。与 SQLite schema 版本独立演进。 */
export const OPAQUE_KEYRING_VERSION = 1;

const HKDF_SALT = "codex-opaque-state:v1:hkdf";
const HKDF_INFO_MARKER_HMAC = "codex-opaque-state:v1:marker-hmac";
const HKDF_INFO_RECORD_AEAD = "codex-opaque-state:v1:record-aead";
/** 稳定索引域。由独立的 indexRoot 派生，不参与 master key 轮换。 */
const HKDF_INFO_INDEX_BINDING = "codex-opaque-state:v1:index-binding";
/** 稳定 lookup 域：把 marker 里的 stateId 折叠成落库用的不可逆摘要。 */
const HKDF_INFO_LOOKUP = "codex-opaque-state:v1:lookup";
/** 每账号数据密钥的二次派生。 */
const HKDF_INFO_ACCOUNT_AEAD = "codex-opaque-state:v1:account-aead";

const MASTER_KEY_BYTES = 32;
const SUBKEY_BYTES = 32;
const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;

/** 轮换后 previous key 至少还要能用这么久（在 state TTL 之外的安全余量）。 */
export const KEY_RETENTION_SAFETY_MARGIN_MS = 60 * 60_000;

/** keyId 允许的形态。进 AAD 和日志，必须受限。 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type OpaqueCompactKeyringFailure =
  | "key_unavailable"
  | "key_invalid"
  | "key_write_failed"
  /** retention 策略不足以覆盖 state TTL。 */
  | "key_policy_invalid";

export class OpaqueCompactKeyringError extends Error {
  constructor(readonly reason: OpaqueCompactKeyringFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactKeyringError";
  }
}

/** 单个可轮换 key 派生出的密钥。索引/lookup 不在此处——它们属于稳定域。 */
export interface OpaqueCompactKey {
  readonly id: string;
  readonly createdAt: number;
  /** 轮换成 previous 的时刻；仍是 active 时为 null。 */
  readonly retiredAt: number | null;
  readonly markerHmacKey: Buffer;
  /** 记录加密根。真正用于封装的是按 account 派生的子密钥。 */
  readonly recordRootKey: Buffer;
}

export interface OpaqueCompactKeyring {
  readonly activeKeyId: string;
  /** active 在前，previous 在后。验签按此顺序尝试。 */
  readonly keys: readonly OpaqueCompactKey[];
  active(): OpaqueCompactKey;
  get(keyId: string): OpaqueCompactKey | undefined;
  /** 稳定索引域密钥，跨 rotation 不变。 */
  readonly indexKey: Buffer;
  /** 稳定 lookup 域密钥，跨 rotation 不变。 */
  readonly lookupKey: Buffer;
}

export interface LoadOpaqueCompactKeyringOptions {
  keyringFile: string;
  /** 只有在确认没有任何已落盘状态时才允许 true。 */
  allowCreate: boolean;
  /** 实际 state TTL。retention 必须覆盖它，否则拒绝开启。 */
  stateTtlMs: number;
  /**
   * 已落盘记录中最大的 expires_at（没有记录时省略）。
   *
   * 只按"当前配置 TTL"裁剪 previous key 是不够的：管理员把 ttl_minutes 调小后
   * 重启，会用新的短窗口裁掉那些以长 TTL 创建、尚未过期的 state 所对应的密钥，
   * 于是仍在有效期内的 marker 直接失效。retention 必须同时覆盖磁盘上真实存活
   * 的记录。
   */
  liveStateExpiresAtMax?: number;
  now?: () => number;
  /** previous key 保留窗口；默认 TTL + 安全余量。 */
  previousKeyRetentionMs?: number;
}

interface StoredKey {
  id: string;
  material: string;
  createdAt: number;
  retiredAt?: number | null;
}

interface StoredKeyring {
  version: number;
  activeKeyId: string;
  /** 稳定索引根。与可轮换的 master key 分开存储。 */
  indexRoot: string;
  keys: StoredKey[];
}

function deriveSubkey(material: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", material, HKDF_SALT, info, SUBKEY_BYTES));
}

/** base64 往返一致才算 canonical，杜绝同一密钥的多种编码写法。 */
function decodeCanonicalBase64(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new OpaqueCompactKeyringError("key_invalid", `${label} is not canonical base64`);
  }
  if (decoded.length !== MASTER_KEY_BYTES) {
    throw new OpaqueCompactKeyringError(
      "key_invalid",
      `${label} must be ${MASTER_KEY_BYTES} bytes`,
    );
  }
  return decoded;
}

function toRuntimeKey(stored: StoredKey): OpaqueCompactKey {
  const master = decodeCanonicalBase64(stored.material, "key material");
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    retiredAt: stored.retiredAt ?? null,
    markerHmacKey: deriveSubkey(master, HKDF_INFO_MARKER_HMAC),
    recordRootKey: deriveSubkey(master, HKDF_INFO_RECORD_AEAD),
  };
}

function parseStoredKeyring(raw: string): StoredKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpaqueCompactKeyringError("key_invalid", "keyring file is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpaqueCompactKeyringError("key_invalid", "keyring file must be a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== OPAQUE_KEYRING_VERSION) {
    throw new OpaqueCompactKeyringError(
      "key_invalid",
      `unsupported keyring version ${String(candidate.version)}`,
    );
  }
  if (typeof candidate.activeKeyId !== "string" || candidate.activeKeyId.length === 0) {
    throw new OpaqueCompactKeyringError("key_invalid", "activeKeyId missing");
  }
  if (typeof candidate.indexRoot !== "string" || candidate.indexRoot.length === 0) {
    throw new OpaqueCompactKeyringError("key_invalid", "indexRoot missing");
  }
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new OpaqueCompactKeyringError("key_invalid", "keys missing");
  }
  const keys: StoredKey[] = [];
  const seen = new Set<string>();
  for (const entry of candidate.keys) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new OpaqueCompactKeyringError("key_invalid", "key entry must be an object");
    }
    const key = entry as Record<string, unknown>;
    // keyId 限定字符集与长度：它会进 AAD 与日志，超长/异常值既无意义也不该被回显。
    if (typeof key.id !== "string" || !KEY_ID_PATTERN.test(key.id)) {
      throw new OpaqueCompactKeyringError("key_invalid", "key id is missing or malformed");
    }
    // 重复 id 会让 Map 后项静默覆盖前项，等于丢失一把仍被引用的密钥。
    if (seen.has(key.id)) {
      throw new OpaqueCompactKeyringError("key_invalid", "duplicate key id");
    }
    seen.add(key.id);
    if (typeof key.material !== "string" || key.material.length === 0) {
      throw new OpaqueCompactKeyringError("key_invalid", "key material missing");
    }
    if (typeof key.createdAt !== "number" || !Number.isFinite(key.createdAt) || key.createdAt < 0) {
      throw new OpaqueCompactKeyringError("key_invalid", "key createdAt is invalid");
    }
    let retiredAt: number | null = null;
    if (key.retiredAt !== undefined && key.retiredAt !== null) {
      if (typeof key.retiredAt !== "number" || !Number.isFinite(key.retiredAt)) {
        throw new OpaqueCompactKeyringError("key_invalid", "key retiredAt is invalid");
      }
      // 退役时间早于创建时间说明文件被改坏或时钟异常，退役判定不可信。
      if (key.retiredAt < key.createdAt) {
        throw new OpaqueCompactKeyringError("key_invalid", "key retiredAt precedes createdAt");
      }
      retiredAt = key.retiredAt;
    }
    keys.push({ id: key.id, material: key.material, createdAt: key.createdAt, retiredAt });
  }
  const activeEntry = keys.find((key) => key.id === candidate.activeKeyId);
  if (activeEntry === undefined) {
    throw new OpaqueCompactKeyringError("key_invalid", "activeKeyId not present in keys");
  }
  // active 必须未退役：否则一把被标记退役的密钥仍在签发新 marker，
  // 而 retention 逻辑又随时可能把它裁掉。
  if (activeEntry.retiredAt !== null) {
    throw new OpaqueCompactKeyringError("key_invalid", "active key is marked retired");
  }
  // previous 必须有退役时间：没有的话永远不会过期，密钥环只增不减。
  for (const key of keys) {
    if (key.id !== candidate.activeKeyId && key.retiredAt === null) {
      throw new OpaqueCompactKeyringError("key_invalid", "previous key is missing retiredAt");
    }
  }
  return {
    version: OPAQUE_KEYRING_VERSION,
    activeKeyId: candidate.activeKeyId,
    indexRoot: candidate.indexRoot,
    keys,
  };
}

/**
 * 原子且 durable 地写密钥环：临时文件 → fsync(file) → rename → fsync(dir)。
 * 目录 fsync 失败必须报错：密钥环是关键 durable commit，若 rename 的目录项在
 * 崩溃后丢失，DB 里的密文就永久不可读了。
 */
function writeKeyringAtomically(path: string, keyring: StoredKeyring): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.${randomBytes(8).toString("hex")}.keyring.tmp`);
  const payload = `${JSON.stringify(keyring, null, 2)}\n`;

  const fail = (error: unknown): never => {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new OpaqueCompactKeyringError(
      "key_write_failed",
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
  // 目录项必须落盘，否则崩溃后 rename 可能丢失。这里不再吞错。
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch (error) {
    throw new OpaqueCompactKeyringError(
      "key_write_failed",
      `keyring directory fsync failed: ${error instanceof Error ? error.message : String(error)}`,
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

function buildKeyring(stored: StoredKeyring): OpaqueCompactKeyring {
  const runtime = new Map<string, OpaqueCompactKey>();
  for (const entry of stored.keys) {
    runtime.set(entry.id, toRuntimeKey(entry));
  }
  const activeKey = runtime.get(stored.activeKeyId);
  if (!activeKey) throw new OpaqueCompactKeyringError("key_invalid", "activeKeyId not present");
  const indexRoot = decodeCanonicalBase64(stored.indexRoot, "indexRoot");
  const ordered: OpaqueCompactKey[] = [
    activeKey,
    ...[...runtime.values()]
      .filter((key) => key.id !== activeKey.id)
      .sort((left, right) => right.createdAt - left.createdAt),
  ];
  return {
    activeKeyId: activeKey.id,
    keys: ordered,
    active: () => activeKey,
    get: (keyId: string) => runtime.get(keyId),
    indexKey: deriveSubkey(indexRoot, HKDF_INFO_INDEX_BINDING),
    lookupKey: deriveSubkey(indexRoot, HKDF_INFO_LOOKUP),
  };
}

/** 密钥环文件必须是普通文件、属主为当前用户、权限不宽于 0600。 */
function assertKeyringFileSafe(keyringFile: string): void {
  const stats = lstatSync(keyringFile);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new OpaqueCompactKeyringError("key_invalid", "keyring path is not a regular file");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new OpaqueCompactKeyringError(
      "key_invalid",
      `keyring permissions are too permissive (${(stats.mode & 0o777).toString(8)})`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpaqueCompactKeyringError("key_invalid", "keyring is not owned by the current user");
  }
}

/**
 * 加载（必要时创建）密钥环。
 *
 * `allowCreate=false` 时缺失文件一定抛 `key_unavailable`：调用方必须在已有
 * 落盘状态时传 false，避免"丢了密钥就重新生成"这种静默数据破坏。
 */
export function loadOpaqueCompactKeyring(
  options: LoadOpaqueCompactKeyringOptions,
): OpaqueCompactKeyring {
  const now = options.now ?? Date.now;
  const keyringFile = options.keyringFile;
  const retentionMs = options.previousKeyRetentionMs
    ?? options.stateTtlMs + KEY_RETENTION_SAFETY_MARGIN_MS;

  // retention 必须真正覆盖 state TTL：靠注释和调用约定不构成安全保证。
  if (!Number.isFinite(retentionMs) || retentionMs < options.stateTtlMs) {
    throw new OpaqueCompactKeyringError(
      "key_policy_invalid",
      "previous key retention must be at least the state TTL",
    );
  }

  if (!existsSync(keyringFile)) {
    if (!options.allowCreate) {
      throw new OpaqueCompactKeyringError(
        "key_unavailable",
        "opaque compact keyring is missing while persisted state exists",
      );
    }
    const createdAt = now();
    const activeKeyId = `k${createdAt.toString(36)}${randomBytes(4).toString("hex")}`;
    const created: StoredKeyring = {
      version: OPAQUE_KEYRING_VERSION,
      activeKeyId,
      indexRoot: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      keys: [{
        id: activeKeyId,
        material: randomBytes(MASTER_KEY_BYTES).toString("base64"),
        createdAt,
        retiredAt: null,
      }],
    };
    writeKeyringAtomically(keyringFile, created);
    return buildKeyring(created);
  }

  assertKeyringFileSafe(keyringFile);
  let raw: string;
  try {
    raw = readFileSync(keyringFile, "utf-8");
  } catch (error) {
    throw new OpaqueCompactKeyringError(
      "key_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  const stored = parseStoredKeyring(raw);

  // 按 retiredAt 退役，不按 createdAt。
  //
  // 除了配置 retention，还要保证覆盖磁盘上真实存活记录的最晚过期时间：
  // 管理员调小 TTL 后重启，不能把仍未过期 state 所依赖的密钥裁掉。
  const current = now();
  const liveFloor = options.liveStateExpiresAtMax ?? 0;
  const pruned: StoredKeyring = {
    ...stored,
    keys: stored.keys.filter((key) => {
      if (key.id === stored.activeKeyId) return true;
      if (key.retiredAt === null || key.retiredAt === undefined) return true;
      if (current - key.retiredAt <= retentionMs) return true;
      // 仍有记录活到那个时刻 → 密钥必须留着，否则那些 marker 会立刻失效。
      return liveFloor > current;
    }),
  };
  return buildKeyring(pruned);
}

/**
 * 轮换出一把新 active key，并给旧 active 打上 retiredAt。
 * indexRoot 保持不变——索引/CAS 域必须跨轮换稳定。
 */
export function rotateOpaqueCompactKeyring(
  keyringFile: string,
  options: { now?: () => number; expectedActiveKeyId?: string } = {},
): { previousKeyId: string; activeKeyId: string; alreadyRotated: boolean } {
  const now = options.now ?? Date.now;
  assertKeyringFileSafe(keyringFile);
  const stored = parseStoredKeyring(readFileSync(keyringFile, "utf-8"));

  // 幂等保护：rename 成功但目录 fsync 失败时，提交状态是不确定的——盲目重试
  // 会再轮换一次，白白多产生一代密钥。调用方传入它开始时看到的 activeKeyId；
  // 若磁盘上已经不是那个值，说明上一次其实已经提交成功，直接返回既有结果。
  if (options.expectedActiveKeyId !== undefined && stored.activeKeyId !== options.expectedActiveKeyId) {
    const previous = stored.keys
      .filter((key) => key.id !== stored.activeKeyId && key.retiredAt !== null)
      .sort((left, right) => (right.retiredAt ?? 0) - (left.retiredAt ?? 0))[0];
    return {
      previousKeyId: previous?.id ?? options.expectedActiveKeyId,
      activeKeyId: stored.activeKeyId,
      alreadyRotated: true,
    };
  }

  const rotatedAt = now();
  const activeKeyId = `k${rotatedAt.toString(36)}${randomBytes(4).toString("hex")}`;
  const rotated: StoredKeyring = {
    ...stored,
    activeKeyId,
    keys: [
      ...stored.keys.map((key) =>
        key.id === stored.activeKeyId ? { ...key, retiredAt: rotatedAt } : key),
      {
        id: activeKeyId,
        material: randomBytes(MASTER_KEY_BYTES).toString("base64"),
        createdAt: rotatedAt,
        retiredAt: null,
      },
    ],
  };
  writeKeyringAtomically(keyringFile, rotated);
  return { previousKeyId: stored.activeKeyId, activeKeyId, alreadyRotated: false };
}

/**
 * 无歧义 tuple 编码：每段前置 4 字节长度。
 * 直接用分隔符拼接会产生别名（字段内含分隔符或 NUL 时不同 tuple 折叠成同一串）。
 */
export function encodeTuple(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf-8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

/** 索引绑定：稳定域，跨 rotation 不变。 */
export function computeIndexBinding(
  keyring: OpaqueCompactKeyring,
  parts: readonly string[],
): string {
  return createHmac("sha256", keyring.indexKey).update(encodeTuple(parts)).digest("hex");
}

/** stateId → 落库用的不可逆 lookup 摘要。DB 中不出现原始 stateId。 */
export function computeLookupDigest(keyring: OpaqueCompactKeyring, stateId: string): string {
  return createHmac("sha256", keyring.lookupKey).update(encodeTuple([stateId])).digest("hex");
}

/** marker 签名。与索引、lookup、记录密钥严格域分离。 */
export function computeMarkerSignature(key: OpaqueCompactKey, message: string): Buffer {
  return createHmac("sha256", key.markerHmacKey).update(message).digest();
}

export function safeEqualBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 按账号二次派生数据密钥。
 *
 * 把 account 放进 AAD 只是认证绑定；真正的隔离要求不同账号使用**不同的数据
 * 密钥**，这样跨账号的调用即使拿到密文也无法取得对应密钥。account binding
 * 先用稳定 index key 折叠成不可逆值，再作为 HKDF info 的一部分。
 */
export function deriveAccountKey(
  keyring: OpaqueCompactKeyring,
  key: OpaqueCompactKey,
  accountEntryId: string,
): Buffer {
  return deriveAccountKeyFromBinding(key, computeAccountBinding(keyring, accountEntryId));
}

/** 账号绑定：不可逆，落库与 AAD 都用它，raw 账号 ID 不上盘。 */
export function computeAccountBinding(
  keyring: OpaqueCompactKeyring,
  accountEntryId: string,
): string {
  return createHmac("sha256", keyring.indexKey)
    .update(encodeTuple(["account", accountEntryId]))
    .digest("hex");
}

/**
 * 直接由 account binding 派生数据密钥。
 *
 * 这是解开"冷启动恢复死结"的关键：启动时没有 raw 账号 ID，但 row 里存着
 * account_binding，而密钥派生实际只依赖 binding。因此恢复阶段可以在完全
 * 不知道账号是谁的情况下完成 AEAD 验证；raw 账号 ID 的核对留到真正的读取
 * 路径（解封后用 payload 里的账号重算 binding 比对）。
 */
export function deriveAccountKeyFromBinding(
  key: OpaqueCompactKey,
  accountBinding: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      key.recordRootKey,
      HKDF_SALT,
      `${HKDF_INFO_ACCOUNT_AEAD}:${accountBinding}`,
      SUBKEY_BYTES,
    ),
  );
}

export interface SealedRecord {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * 封装后的总字节数（nonce + ciphertext + tag）。
 *
 * AES-GCM 是流式模式，密文长度恒等于明文长度，因此这个值可以在封装之前
 * 确定性算出。调用方需要它是因为 byteSize 要进 AAD——否则就得先封一次拿到
 * 长度、再用真实长度重封一次。
 */
export function sealedSizeFor(plaintextLength: number): number {
  return plaintextLength + AEAD_NONCE_BYTES + AEAD_TAG_BYTES;
}

/** 记录级 AEAD 封装。dataKey 必须来自 deriveAccountKey。 */
export function sealRecord(dataKey: Buffer, aad: Buffer, plaintext: Buffer): SealedRecord {
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, dataKey, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** 解封。任何认证失败都抛错，绝不返回半可信明文。 */
export function openRecord(dataKey: Buffer, aad: Buffer, sealed: SealedRecord): Buffer {
  const decipher = createDecipheriv(AEAD_ALGORITHM, dataKey, sealed.nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  decipher.setAAD(aad, { plaintextLength: sealed.ciphertext.length });
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
