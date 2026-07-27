/**
 * Opaque compact state 的稳定主密钥环（master key ring）。
 *
 * 设计意图：opaque marker 必须在进程重启、升级、部署之后仍然可用，因此
 * 签名密钥和记录加密密钥都不能再由 `randomBytes()` 在进程内生成，而要来自
 * 一份外部稳定、可轮换的密钥环文件。
 *
 * 三条硬约束：
 * 1. 密钥环里保存的是 master key，**所有实际使用的子密钥都通过 HKDF 派生**，
 *    marker-HMAC / 索引绑定 / 记录 AEAD 三者域分离，互相不可推导。
 * 2. 只有在"确实没有任何已落盘状态"时才允许自动创建密钥环；一旦数据库已经
 *    存在而密钥环缺失，必须 fail-closed，绝不能生成新密钥把旧记录变成永久垃圾。
 * 3. previous keys 至少覆盖最长 TTL，保证轮换当天签发的 marker 仍能验签/解密。
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

/** HKDF salt。固定字符串即可：master key 本身已是 32 字节高熵随机数。 */
const HKDF_SALT = "codex-opaque-state:v1:hkdf";

/** 三个子密钥的 HKDF info，互相域分离。 */
const HKDF_INFO_MARKER_HMAC = "codex-opaque-state:v1:marker-hmac";
const HKDF_INFO_INDEX_BINDING = "codex-opaque-state:v1:index-binding";
const HKDF_INFO_RECORD_AEAD = "codex-opaque-state:v1:record-aead";

const MASTER_KEY_BYTES = 32;
const SUBKEY_BYTES = 32;
const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;

export type OpaqueCompactKeyringFailure =
  /** 密钥环文件缺失，且当前上下文不允许自动创建（已有落盘状态）。 */
  | "key_unavailable"
  /** 密钥环文件存在但内容不可解析 / 字段非法 / active 指向缺失的 key。 */
  | "key_invalid"
  /** 无法写入新密钥环（权限、磁盘等）。 */
  | "key_write_failed";

export class OpaqueCompactKeyringError extends Error {
  constructor(readonly reason: OpaqueCompactKeyringFailure, message?: string) {
    super(message ?? reason);
    this.name = "OpaqueCompactKeyringError";
  }
}

/** 单个 key 派生出的三个子密钥。master key 本身不对外暴露。 */
export interface OpaqueCompactKey {
  readonly id: string;
  readonly createdAt: number;
  readonly markerHmacKey: Buffer;
  readonly indexKey: Buffer;
  readonly aeadKey: Buffer;
}

export interface OpaqueCompactKeyring {
  readonly activeKeyId: string;
  /** active 在前，previous 在后。验签 / 索引匹配按此顺序尝试。 */
  readonly keys: readonly OpaqueCompactKey[];
  active(): OpaqueCompactKey;
  get(keyId: string): OpaqueCompactKey | undefined;
}

export interface LoadOpaqueCompactKeyringOptions {
  keyringFile: string;
  /** 只有在确认没有任何已落盘状态时才允许 true。 */
  allowCreate: boolean;
  now?: () => number;
  /** previous key 保留窗口，必须 >= 最长 state TTL。 */
  previousKeyRetentionMs?: number;
}

interface StoredKey {
  id: string;
  material: string;
  createdAt: number;
}

interface StoredKeyring {
  version: number;
  activeKeyId: string;
  keys: StoredKey[];
}

function deriveSubkey(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, info, SUBKEY_BYTES));
}

function toRuntimeKey(stored: StoredKey): OpaqueCompactKey {
  let master: Buffer;
  try {
    master = Buffer.from(stored.material, "base64");
  } catch {
    throw new OpaqueCompactKeyringError("key_invalid", "key material is not base64");
  }
  if (master.length !== MASTER_KEY_BYTES) {
    throw new OpaqueCompactKeyringError(
      "key_invalid",
      `key material must be ${MASTER_KEY_BYTES} bytes`,
    );
  }
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    markerHmacKey: deriveSubkey(master, HKDF_INFO_MARKER_HMAC),
    indexKey: deriveSubkey(master, HKDF_INFO_INDEX_BINDING),
    aeadKey: deriveSubkey(master, HKDF_INFO_RECORD_AEAD),
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
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new OpaqueCompactKeyringError("key_invalid", "keys missing");
  }
  const keys: StoredKey[] = [];
  for (const entry of candidate.keys) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new OpaqueCompactKeyringError("key_invalid", "key entry must be an object");
    }
    const key = entry as Record<string, unknown>;
    if (typeof key.id !== "string" || key.id.length === 0) {
      throw new OpaqueCompactKeyringError("key_invalid", "key id missing");
    }
    if (typeof key.material !== "string" || key.material.length === 0) {
      throw new OpaqueCompactKeyringError("key_invalid", "key material missing");
    }
    const createdAt = typeof key.createdAt === "number" && Number.isFinite(key.createdAt)
      ? key.createdAt
      : 0;
    keys.push({ id: key.id, material: key.material, createdAt });
  }
  if (!keys.some((key) => key.id === candidate.activeKeyId)) {
    throw new OpaqueCompactKeyringError("key_invalid", "activeKeyId not present in keys");
  }
  return { version: OPAQUE_KEYRING_VERSION, activeKeyId: candidate.activeKeyId, keys };
}

/** 原子写：临时文件 → fsync → rename → fsync(dir)。0600 权限。 */
function writeKeyringAtomically(path: string, keyring: StoredKeyring): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.${randomBytes(8).toString("hex")}.keyring.tmp`);
  const payload = `${JSON.stringify(keyring, null, 2)}\n`;
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
      fd = null;
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new OpaqueCompactKeyringError(
      "key_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new OpaqueCompactKeyringError(
      "key_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  // 目录项也要落盘，否则 rename 可能在崩溃后丢失。
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // 某些文件系统不支持对目录 fsync；rename 本身已经是原子的，可接受。
  }
}

function buildKeyring(stored: StoredKeyring): OpaqueCompactKeyring {
  const runtime = new Map<string, OpaqueCompactKey>();
  for (const entry of stored.keys) {
    runtime.set(entry.id, toRuntimeKey(entry));
  }
  const activeKey = runtime.get(stored.activeKeyId);
  if (!activeKey) throw new OpaqueCompactKeyringError("key_invalid", "activeKeyId not present");
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
  };
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

  if (!existsSync(keyringFile)) {
    if (!options.allowCreate) {
      throw new OpaqueCompactKeyringError(
        "key_unavailable",
        "opaque compact keyring is missing while persisted state exists",
      );
    }
    const created: StoredKeyring = {
      version: OPAQUE_KEYRING_VERSION,
      activeKeyId: `k${now().toString(36)}${randomBytes(4).toString("hex")}`,
      keys: [],
    };
    created.keys.push({
      id: created.activeKeyId,
      material: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      createdAt: now(),
    });
    writeKeyringAtomically(keyringFile, created);
    return buildKeyring(created);
  }

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

  // 过期的 previous key 只在内存里裁剪，不改写磁盘：轮换与保留策略由运维
  // 显式控制，进程不应该擅自销毁还可能被引用的密钥材料。
  const retentionMs = options.previousKeyRetentionMs;
  const pruned = retentionMs === undefined
    ? stored
    : {
        ...stored,
        keys: stored.keys.filter(
          (key) => key.id === stored.activeKeyId || now() - key.createdAt <= retentionMs,
        ),
      };
  return buildKeyring(pruned);
}

/** 索引绑定：把 session|model|variant 这类明文折叠成不可逆的 HMAC 十六进制串。 */
export function computeIndexBinding(key: OpaqueCompactKey, bindingKey: string): string {
  return createHmac("sha256", key.indexKey).update(bindingKey).digest("hex");
}

/** marker 签名。与索引、记录密钥严格域分离。 */
export function computeMarkerSignature(key: OpaqueCompactKey, message: string): Buffer {
  return createHmac("sha256", key.markerHmacKey).update(message).digest();
}

export function safeEqualBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface SealedRecord {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/** 记录级 AEAD 封装。AAD 由调用方绑定 schema/keyId/stateId/generation/binding。 */
export function sealRecord(key: OpaqueCompactKey, aad: Buffer, plaintext: Buffer): SealedRecord {
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, key.aeadKey, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** 解封。任何认证失败都抛错，绝不返回半可信明文。 */
export function openRecord(key: OpaqueCompactKey, aad: Buffer, sealed: SealedRecord): Buffer {
  const decipher = createDecipheriv(AEAD_ALGORITHM, key.aeadKey, sealed.nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  decipher.setAAD(aad, { plaintextLength: sealed.ciphertext.length });
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
