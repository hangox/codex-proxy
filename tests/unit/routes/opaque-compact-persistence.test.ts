/**
 * Opaque compact state 加密持久化的**同进程**不变量测试。
 *
 * 分工：跨进程才能成立的语义（真实 kill -9、内核锁争用、并发 CAS、跨进程轮换、
 * 磁盘隐私扫描）在 opaque-compact-fault-injection.test.ts 里用真实子进程验证。
 * 本文件只测那些在同一进程内就能确定性验证的逻辑：密钥派生与域分离、AEAD/AAD
 * 语义、schema 版本、sentinel 判定、TTL/LRU、以及默认关闭时的零 IO。
 *
 * 刻意不在这里做的事：不用"把全局 store 置 null"冒充进程崩溃，也不用顺序调用
 * 冒充并发——那类断言看似通过，实际什么故障语义都没证明。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  computeIndexBinding,
  computeLookupDigest,
  computeMarkerSignature,
  deriveAccountKey,
  encodeTuple,
  loadOpaqueCompactKeyring,
  openRecord,
  OpaqueCompactKeyringError,
  rotateOpaqueCompactKeyring,
  sealRecord,
  sealedSizeFor,
} from "@src/routes/shared/opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
  OpaqueCompactRepositoryError,
  OPAQUE_REPOSITORY_SCHEMA_VERSION,
} from "@src/routes/shared/opaque-compact-repository.js";
import { loadOpaqueCompactSentinel } from "@src/routes/shared/opaque-compact-sentinel.js";
import { acquireOpaqueCompactStoreLock } from "@src/routes/shared/opaque-compact-store-lock.js";
import {
  OpaqueCompactStateError,
  OpaqueCompactStateStore,
  getOpaqueCompactStateReadiness,
  getOpaqueCompactStateStore,
  isOpaqueCompactStateStoreReady,
  setOpaqueCompactStateStore,
} from "@src/routes/shared/opaque-compact-state.js";
import {
  forgetOpaqueCompactRuntimeForTesting,
  reconfigureOpaqueCompactRuntime,
  startOpaqueCompactRuntime,
} from "@src/routes/shared/opaque-compact-runtime.js";
import { opaqueCompactVariantHash } from "@src/routes/shared/opaque-compact-bridge.js";
import { getDataDir } from "@src/paths.js";

const CANARIES = {
  session: "session-canary-8f2a",
  account: "entry-canary-51bd",
  output: "opaque-output-canary-c93e",
  encrypted: "encrypted-content-canary-7a10",
  tail: "preserved-tail-canary-2d64",
  variant: "variant-canary-b7f3",
} as const;

const OUTPUT = [
  { type: "reasoning", encrypted_content: CANARIES.encrypted, summary: [] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: CANARIES.output }] },
];

const PRESERVED_TAIL = [
  { type: "function_call", call_id: "tool-1", name: "Read", arguments: "{}" },
  { type: "function_call_output", call_id: "tool-1", output: CANARIES.tail },
];

const TTL_MS = 30 * 60_000;

let dir: string;
let keyDir: string;
const openHandles: { close(): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "opaque-persist-"));
  keyDir = mkdtempSync(resolve(tmpdir(), "opaque-keys-"));
});

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
  setOpaqueCompactStateStore(null);
  forgetOpaqueCompactRuntimeForTesting();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

/** 密钥环刻意放在 store 目录之外——生产要求密钥与密文不同卷。 */
function keyringFile(): string {
  return resolve(keyDir, "keyring.json");
}

function freshKeyring(allowCreate = true) {
  return loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate, stateTtlMs: TTL_MS });
}

function makeStore(options: { capacity?: number; maxBytes?: number; now?: () => number } = {}) {
  const keyring = freshKeyring();
  const sentinel = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: true })!;
  const repository = new OpaqueCompactRepository({
    databasePath: resolve(dir, "state.db"),
    keyring,
    storeId: sentinel.storeId,
    sentinelCreated: !sentinel.ready,
    capacity: options.capacity ?? 128,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    ...(options.now ? { now: options.now } : {}),
  });
  openHandles.push(repository);
  const store = new OpaqueCompactStateStore({
    keyring,
    repository,
    capacity: options.capacity ?? 128,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    ttlMs: TTL_MS,
    ...(options.now ? { now: options.now } : {}),
  });
  return { keyring, repository, store, sentinel };
}

function saveCanaryState(store: OpaqueCompactStateStore, expectedGeneration = 0) {
  return store.save({
    output: OUTPUT,
    preservedTail: [...PRESERVED_TAIL],
    sessionId: CANARIES.session,
    model: "gpt-5.4",
    accountEntryId: CANARIES.account,
    variantHash: CANARIES.variant,
    expectedGeneration,
  });
}

function resolveCanary(store: OpaqueCompactStateStore, marker: string, overrides = {}) {
  return store.resolve({
    marker,
    sessionId: CANARIES.session,
    model: "gpt-5.4",
    variantHash: CANARIES.variant,
    accountCandidates: [CANARIES.account],
    ...overrides,
  });
}

function expectReason(fn: () => unknown, reason: string): void {
  try {
    fn();
    throw new Error(`expected failure with reason=${reason}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OpaqueCompactStateError);
    expect((error as OpaqueCompactStateError).reason).toBe(reason);
  }
}

function runtimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    ttlMinutes: 30,
    capacity: 128,
    maxBytes: 1024 * 1024,
    directory: dir,
    keyringFile: keyringFile(),
    allowKeyringBootstrap: true,
    ...overrides,
  };
}

describe("keyring — 密钥域分离与轮换策略", () => {
  it("以 0600 创建，并把三个密钥域分开", () => {
    const keyring = freshKeyring();
    const key = keyring.active();

    expect(statSync(keyringFile()).mode & 0o777).toBe(0o600);
    // marker 签名、记录加密根、稳定索引域两两不同：任一域泄漏不得推出另一域。
    expect(key.markerHmacKey.equals(key.recordRootKey)).toBe(false);
    expect(key.markerHmacKey.equals(keyring.indexKey)).toBe(false);
    expect(key.recordRootKey.equals(keyring.indexKey)).toBe(false);
    expect(keyring.indexKey.equals(keyring.lookupKey)).toBe(false);

    const raw = readFileSync(keyringFile(), "utf-8");
    expect(raw).not.toContain(key.markerHmacKey.toString("base64"));
    expect(raw).not.toContain(key.recordRootKey.toString("base64"));
  });

  it("跨重载稳定，marker 才能在重启后继续验签", () => {
    const first = freshKeyring();
    const second = loadOpaqueCompactKeyring({
      keyringFile: keyringFile(),
      allowCreate: false,
      stateTtlMs: TTL_MS,
    });

    expect(second.activeKeyId).toBe(first.activeKeyId);
    expect(
      computeMarkerSignature(second.active(), "m").equals(computeMarkerSignature(first.active(), "m")),
    ).toBe(true);
    expect(computeIndexBinding(second, ["b"])).toBe(computeIndexBinding(first, ["b"]));
  });

  it("轮换保持 indexRoot 不变，只换 marker/AEAD 域", () => {
    const before = freshKeyring();
    const indexBindingBefore = computeIndexBinding(before, ["state", "s", "m", "v"]);
    const lookupBefore = computeLookupDigest(before, "state-id");

    const rotated = rotateOpaqueCompactKeyring(keyringFile());
    const after = loadOpaqueCompactKeyring({
      keyringFile: keyringFile(),
      allowCreate: false,
      stateTtlMs: TTL_MS,
    });

    expect(after.activeKeyId).toBe(rotated.activeKeyId);
    expect(after.activeKeyId).not.toBe(rotated.previousKeyId);
    // 索引与 lookup 域必须稳定，否则轮换后 CAS 看不到旧代，会分裂出双 active。
    expect(computeIndexBinding(after, ["state", "s", "m", "v"])).toBe(indexBindingBefore);
    expect(computeLookupDigest(after, "state-id")).toBe(lookupBefore);
    // 旧 key 仍在环内，保留窗口内签发的 marker 仍可验签。
    expect(after.get(rotated.previousKeyId)).toBeDefined();
    expect(after.get(rotated.previousKeyId)!.retiredAt).not.toBeNull();
  });

  it("按 retiredAt 而非 createdAt 退役 previous key", () => {
    freshKeyring();
    const rotated = rotateOpaqueCompactKeyring(keyringFile());
    const stored = JSON.parse(readFileSync(keyringFile(), "utf-8")) as {
      keys: { id: string; createdAt: number; retiredAt: number | null }[];
    };
    // 把旧 key 的 createdAt 推到很久以前，但 retiredAt 就在刚刚。
    const old = stored.keys.find((entry) => entry.id === rotated.previousKeyId)!;
    old.createdAt = 1;
    old.retiredAt = Date.now();
    writeFileSync(keyringFile(), JSON.stringify(stored), { mode: 0o600 });

    const keyring = loadOpaqueCompactKeyring({
      keyringFile: keyringFile(),
      allowCreate: false,
      stateTtlMs: TTL_MS,
    });
    // 一把用了很久才轮换的 key，按 createdAt 会被立刻丢弃，
    // 但它几分钟前签发的 marker 仍在 TTL 内——必须保留。
    expect(keyring.get(rotated.previousKeyId)).toBeDefined();
  });

  it("retention 不足以覆盖 state TTL 时拒绝开启", () => {
    freshKeyring();
    try {
      loadOpaqueCompactKeyring({
        keyringFile: keyringFile(),
        allowCreate: false,
        stateTtlMs: TTL_MS,
        previousKeyRetentionMs: 1_000,
      });
      throw new Error("expected key_policy_invalid");
    } catch (error) {
      expect(error).toBeInstanceOf(OpaqueCompactKeyringError);
      expect((error as OpaqueCompactKeyringError).reason).toBe("key_policy_invalid");
    }
  });

  it("已有落盘状态时拒绝凭空造密钥", () => {
    try {
      loadOpaqueCompactKeyring({
        keyringFile: keyringFile(),
        allowCreate: false,
        stateTtlMs: TTL_MS,
      });
      throw new Error("expected key_unavailable");
    } catch (error) {
      expect((error as OpaqueCompactKeyringError).reason).toBe("key_unavailable");
    }
    expect(existsSync(keyringFile())).toBe(false);
  });

  it("拒绝畸形、重复 id、非 canonical base64 与过宽权限", () => {
    const good = Buffer.alloc(32, 7).toString("base64");
    const cases: [string, string][] = [
      ["not json", "key_invalid"],
      [JSON.stringify({ version: 99, activeKeyId: "a", indexRoot: good, keys: [{ id: "a", material: good }] }), "key_invalid"],
      [JSON.stringify({ version: 1, activeKeyId: "missing", indexRoot: good, keys: [{ id: "a", material: good }] }), "key_invalid"],
      [JSON.stringify({ version: 1, activeKeyId: "a", indexRoot: good, keys: [{ id: "a", material: "c2hvcnQ=" }] }), "key_invalid"],
      // 重复 id：Map 后项会静默覆盖前项，等于丢失一把仍被引用的密钥。
      [JSON.stringify({ version: 1, activeKeyId: "a", indexRoot: good, keys: [{ id: "a", material: good }, { id: "a", material: good }] }), "key_invalid"],
      [JSON.stringify({ version: 1, activeKeyId: "a", keys: [{ id: "a", material: good }] }), "key_invalid"],
    ];
    for (const [content, reason] of cases) {
      writeFileSync(keyringFile(), content, { mode: 0o600 });
      try {
        loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: true, stateTtlMs: TTL_MS });
        throw new Error(`expected ${reason} for ${content.slice(0, 40)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(OpaqueCompactKeyringError);
        expect((error as OpaqueCompactKeyringError).reason).toBe(reason);
      }
    }

    // writeFileSync 的 mode 只在创建新文件时生效，这里必须显式 chmod。
    rmSync(keyringFile(), { force: true });
    writeFileSync(
      keyringFile(),
      JSON.stringify({ version: 1, activeKeyId: "a", indexRoot: good, keys: [{ id: "a", material: good }] }),
    );
    chmodSync(keyringFile(), 0o644);
    try {
      loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: true, stateTtlMs: TTL_MS });
      throw new Error("expected key_invalid for permissive mode");
    } catch (error) {
      expect((error as OpaqueCompactKeyringError).reason).toBe("key_invalid");
    }
  });

  it("按账号派生不同数据密钥，且 AAD/密文任一改动都解不开", () => {
    const keyring = freshKeyring();
    const key = keyring.active();
    const alice = deriveAccountKey(keyring, key, "entry-alice");
    const bob = deriveAccountKey(keyring, key, "entry-bob");
    // 账号隔离靠不同数据密钥，而不仅仅是 AAD 里带个字段。
    expect(alice.equals(bob)).toBe(false);

    const aad = encodeTuple(["aad", "v1"]);
    const sealed = sealRecord(alice, aad, Buffer.from("secret"));
    expect(openRecord(alice, aad, sealed).toString()).toBe("secret");
    expect(() => openRecord(bob, aad, sealed)).toThrow();
    expect(() => openRecord(alice, encodeTuple(["aad", "v2"]), sealed)).toThrow();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => openRecord(alice, aad, { ...sealed, ciphertext: flipped })).toThrow();
  });

  it("tuple 编码对含 NUL 的字段不产生别名", () => {
    const keyring = freshKeyring();
    // 直接用分隔符拼接时，这两组输入会折叠成同一串。
    expect(computeIndexBinding(keyring, ["a b", "c"]))
      .not.toBe(computeIndexBinding(keyring, ["a", "b c"]));
    expect(computeIndexBinding(keyring, ["ab", "c"]))
      .not.toBe(computeIndexBinding(keyring, ["a", "bc"]));
  });
});

describe("repository — 存储语义", () => {
  it("跨 repository 实例解析 marker（同进程重开库）", () => {
    const first = makeStore();
    const { marker } = saveCanaryState(first.store);
    first.repository.close();

    const second = makeStore();
    const restored = resolveCanary(second.store, marker);
    expect(restored.output).toEqual(OUTPUT);
    expect(restored.preservedTail).toEqual(PRESERVED_TAIL);
    expect(restored.generation).toBe(1);
  });

  it("绑定 session / model / variant / 账号", () => {
    const { store } = makeStore();
    const { marker } = saveCanaryState(store);

    expectReason(() => resolveCanary(store, marker, { sessionId: "other" }), "session_mismatch");
    expectReason(() => resolveCanary(store, marker, { model: "gpt-5.5" }), "model_mismatch");
    expectReason(() => resolveCanary(store, marker, { variantHash: "other" }), "variant_mismatch");
    // 账号不对时连数据密钥都派生不出来，谈不上"解密后再比较字段"。
    expectReason(
      () => resolveCanary(store, marker, { accountCandidates: ["entry-other"] }),
      "account_mismatch",
    );
  });

  it("AAD 覆盖 TTL 字段：篡改 expires_at 无法延长寿命", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET expires_at = ?").run(Date.now() + 10 * 365 * 24 * 3600_000);
    db.close();

    const reopened = makeStore();
    // expires_at 参与 AAD，改了就过不了认证。
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });

  it("密文单 bit 翻转报 state_corrupt（integrity_check 检不出的场景）", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array }
      | undefined;
    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, row!.lookup_digest);
    // 证明这正是 integrity_check 的盲区：库本身仍然"健康"。
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe("ok");
    db.close();

    const reopened = makeStore();
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });

  it("拒绝不认识的 schema 版本，且不改动原库", () => {
    const seeded = makeStore();
    saveCanaryState(seeded.store);
    seeded.repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(OPAQUE_REPOSITORY_SCHEMA_VERSION + 1));
    const before = db.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    db.close();

    const keyring = freshKeyring();
    const sentinel = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: false })!;
    try {
      new OpaqueCompactRepository({
        databasePath: resolve(dir, "state.db"),
        keyring,
        storeId: sentinel.storeId,
        sentinelCreated: false,
        capacity: 8,
        maxBytes: 1024 * 1024,
      });
      throw new Error("expected schema_unsupported");
    } catch (error) {
      expect(error).toBeInstanceOf(OpaqueCompactRepositoryError);
      expect((error as OpaqueCompactRepositoryError).reason).toBe("schema_unsupported");
    }

    // 旧版本二进制遇到新 schema 必须原库不变，不能"顺手迁移"。
    const after = new DatabaseSync(resolve(dir, "state.db"));
    const rows = after.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    expect(rows.n).toBe(before.n);
    after.close();
  });

  it("单条超过字节预算时在 COMMIT 前拒绝，不留下行", () => {
    const { store, repository } = makeStore({ maxBytes: 4096 });
    expectReason(() => store.save({
      output: [{ value: "x".repeat(20_000) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 0,
    }), "state_too_large");
    // 既没落行，也就不会有指向被立即淘汰记录的 marker。
    expect(repository.stats().count).toBe(0);
  });

  it("超预算时按 LRU 淘汰，但恢复过程不触碰 last_used_at", () => {
    const { store, repository } = makeStore({ capacity: 10, maxBytes: 2_400 });
    const first = store.save({
      output: [{ value: "a".repeat(700) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "v1",
      expectedGeneration: 0,
    });
    store.save({
      output: [{ value: "b".repeat(700) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "v2",
      expectedGeneration: 0,
    });
    store.save({
      output: [{ value: "c".repeat(700) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "v3",
      expectedGeneration: 0,
    });
    expect(repository.stats().bytes).toBeLessThanOrEqual(2_400);
    expectReason(
      () => resolveCanary(store, first.marker, { variantHash: "v1" }),
      "missing",
    );

    // recover() 必须只读：若它顺手 touch 每一行，重启就会抹平 LRU 顺序。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const beforeRows = db.prepare("SELECT lookup_digest, last_used_at FROM opaque_states").all();
    db.close();
    repository.recover();
    const after = new DatabaseSync(resolve(dir, "state.db"));
    const afterRows = after.prepare("SELECT lookup_digest, last_used_at FROM opaque_states").all();
    after.close();
    expect(afterRows).toEqual(beforeRows);
  });

  it("recover() 不删除损坏记录，把隔离决策留给调用方", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array }
      | undefined;
    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, row!.lookup_digest);
    db.close();

    const reopened = makeStore();
    reopened.repository.recover();
    // 证据必须还在：先删掉再让调用方"决定是否 quarantine"是自相矛盾的。
    const check = new DatabaseSync(resolve(dir, "state.db"));
    const count = check.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    check.close();
    expect(count.n).toBe(1);
  });

  it("过期记录在恢复时清理", () => {
    let now = 1_000_000;
    const keyring = freshKeyring();
    const sentinel = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: true })!;
    const repository = new OpaqueCompactRepository({
      databasePath: resolve(dir, "state.db"),
      keyring,
      storeId: sentinel.storeId,
      sentinelCreated: sentinel.created,
      capacity: 128,
      maxBytes: 1024 * 1024,
      now: () => now,
    });
    openHandles.push(repository);
    const store = new OpaqueCompactStateStore({
      keyring,
      repository,
      ttlMs: 1000,
      now: () => now,
    });
    saveCanaryState(store);
    expect(repository.stats().count).toBe(1);

    now += 5000;
    const recovered = repository.recover();
    expect(recovered.expired).toBe(1);
    expect(repository.stats().count).toBe(0);
  });

  it("WAL 与 synchronous=FULL 必须读回验证而不仅是设置", () => {
    const { repository } = makeStore();
    void repository;
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    db.close();
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    expect(sync.synchronous).toBeGreaterThanOrEqual(2);
  });
});

describe("交付语义 — predecessor 不在 COMMIT 时立即销毁", () => {
  it("新 generation 落库后，旧 marker 在客户端确认前仍可用", () => {
    const { store } = makeStore();
    const first = saveCanaryState(store, 0);
    const firstResolved = resolveCanary(store, first.marker);

    const second = store.save({
      output: OUTPUT,
      preservedTail: [...PRESERVED_TAIL],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: firstResolved.generation,
      predecessorStateId: firstResolved.stateId,
    });
    expect(second.generation).toBe(2);

    // 关键：COMMIT 之后、marker 送达之前若崩溃，客户端手里只有旧 marker。
    // 此刻旧 marker 必须仍然有效，否则会话直接断掉。
    const stillUsable = resolveCanary(store, first.marker);
    expect(stillUsable.output).toEqual(OUTPUT);
  });

  it("拿旧 marker 重试时幂等回放同一个 successor marker，不重复打上游", () => {
    const { store } = makeStore();
    const first = saveCanaryState(store, 0);
    const firstResolved = resolveCanary(store, first.marker);
    const second = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: firstResolved.generation,
      predecessorStateId: firstResolved.stateId,
    });

    const replayed = store.findSuccessorMarker(first.marker, CANARIES.account);
    expect(replayed).toBe(second.marker);
    // 账号不对是安全边界，必须抛结构化错误而不是返回 null——
    // 返回 null 会让调用方以为"没有映射"，重打一次上游并掩盖真实原因。
    expectReason(
      () => store.findSuccessorMarker(first.marker, "entry-other"),
      "account_mismatch",
    );
  });

  it("客户端用上 successor 之后才回收 predecessor", () => {
    const { store } = makeStore();
    const first = saveCanaryState(store, 0);
    const firstResolved = resolveCanary(store, first.marker);
    const second = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: firstResolved.generation,
      predecessorStateId: firstResolved.stateId,
    });

    // 使用 successor == 客户端确实收到了它。
    resolveCanary(store, second.marker);
    // 此时 predecessor 才被回收。
    expectReason(() => resolveCanary(store, first.marker), "missing");
  });
});

describe("runtime — 生命周期与 readiness", () => {
  it("功能关闭时不碰磁盘，且 readiness 给出结构化原因", () => {
    const handle = startOpaqueCompactRuntime(runtimeConfig({ enabled: false }));
    openHandles.push(handle);

    expect(handle.ready).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(isOpaqueCompactStateStoreReady()).toBe(false);
    expect(() => getOpaqueCompactStateStore()).toThrowError(OpaqueCompactStateError);
  });

  it("开启后就绪，marker 跨 runtime 重启可用", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    expect(first.ready).toBe(true);
    const { marker } = saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    const second = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(second);
    expect(second.ready).toBe(true);
    expect(resolveCanary(getOpaqueCompactStateStore(), marker).output).toEqual(OUTPUT);
  });

  it("第二实例被拒绝并给出 store_locked", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(first);
    expect(first.ready).toBe(true);

    const second = startOpaqueCompactRuntime(runtimeConfig());
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("store_locked");
    // readiness 必须透出真实原因，不能折叠成笼统的 store_unavailable。
    expect(getOpaqueCompactStateReadiness()).toEqual({ ready: false, reason: "store_locked" });
  });

  it("热切换 false→true→false：先原子初始化，关闭后回到 zero-touch", () => {
    const off = startOpaqueCompactRuntime(runtimeConfig({ enabled: false }));
    expect(off.ready).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    const on = reconfigureOpaqueCompactRuntime(runtimeConfig());
    expect(on.ready).toBe(true);
    expect(isOpaqueCompactStateStoreReady()).toBe(true);
    const { marker } = saveCanaryState(getOpaqueCompactStateStore());

    const backOff = reconfigureOpaqueCompactRuntime(runtimeConfig({ enabled: false }));
    openHandles.push(backOff);
    // 关掉之后不得继续持有 store，否则既违反 disabled 语义也白挡第二实例。
    expect(backOff.ready).toBe(false);
    expect(isOpaqueCompactStateStoreReady()).toBe(false);

    // 再开回来，之前的 state 仍在（关闭不等于销毁数据）。
    const onAgain = reconfigureOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(onAgain);
    expect(onAgain.ready).toBe(true);
    expect(resolveCanary(getOpaqueCompactStateStore(), marker).output).toEqual(OUTPUT);
  });

  it("sentinel 在但 DB 被清零时 fail-closed", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    writeFileSync(resolve(dir, "state.db"), Buffer.alloc(0));
    rmSync(resolve(dir, "state.db-wal"), { force: true });
    rmSync(resolve(dir, "state.db-shm"), { force: true });

    const second = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(second);
    // 清零库与全新空库在 SQLite 层面不可区分，只有 DB 外的 sentinel 能兜住。
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("store_reset_detected");
  });
});

describe("元数据篡改 — 必须先认证再采取任何动作", () => {
  /** 直接改库里的某一列，模拟磁盘攻击者。 */
  function tamperColumn(column: string, value: unknown): void {
    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare(`UPDATE opaque_states SET ${column} = ?`).run(value as never);
    db.close();
  }

  it("改短 expires_at 不能把损坏记录静默删掉、销毁证据", () => {
    const first = makeStore();
    const { marker } = saveCanaryState(first.store);
    first.repository.close();

    // 先破坏密文，再把过期时间改到过去。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ?, expires_at = ?")
      .run(corrupted, 1);
    db.close();

    const reopened = makeStore();
    // 若先信任 expires_at，这条记录会被当作"过期"直接删掉，
    // 攻击者因此可以抹掉损坏证据并绕过 state_corrupt。
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
    const check = new DatabaseSync(resolve(dir, "state.db"));
    const count = check.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    check.close();
    expect(count.n).toBe(1);
  });

  it("把 byte_size 改成 0 无法绕过字节预算", () => {
    const first = makeStore();
    const { marker } = saveCanaryState(first.store);
    first.repository.close();
    tamperColumn("byte_size", 0);

    const reopened = makeStore();
    // byte_size 必须与密文实测长度比对；只把实测值塞进 AAD 而不校验列，
    // 等于让 stats/prune 按 0 计预算。
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });

  it.each([
    ["generation", 999],
    ["binding", "forged-binding"],
    ["account_binding", "forged-account"],
    ["created_at", 1],
    ["key_id", "forged-key"],
  ])("翻转 AAD 字段 %s 后必须 fail-closed", (column, value) => {
    const first = makeStore();
    const { marker } = saveCanaryState(first.store);
    first.repository.close();
    tamperColumn(column, value);

    const reopened = makeStore();
    // 每个进 AAD 的字段都必须真正参与认证。
    expect(() => resolveCanary(reopened.store, marker)).toThrowError(OpaqueCompactStateError);
  });
});

describe("账号绑定 — payload 必须与实际解密账号一致", () => {
  it("用 A 的密钥封装但 payload 声称 B 时拒绝返回", () => {
    const { store, repository, keyring } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    // 构造"A 封装、payload 声称 B"的记录：正常写入不可能产生，
    // 只会来自迁移 bug 或恶意构造。若信任 payload，A 的 opaque output
    // 就会被当作 B 的状态路由出去（requiredEntryId 来自 payload）。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT * FROM opaque_states LIMIT 1").get() as Record<string, unknown>;
    const key = keyring.get(String(row.key_id))!;
    const dataKey = deriveAccountKey(keyring, key, CANARIES.account);
    const forged = {
      version: 1,
      output: OUTPUT,
      preservedTail: PRESERVED_TAIL,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: "entry-victim-b",
      variantHash: CANARIES.variant,
      compHash: String(row.lookup_digest),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
    const plaintext = Buffer.from(JSON.stringify(forged), "utf-8");
    const byteSize = sealedSizeFor(plaintext.length);
    const aad = encodeTuple([
      "schema:1",
      String((JSON.parse(readFileSync(resolve(dir, "store.sentinel"), "utf-8")) as { storeId: string }).storeId),
      String(row.key_id),
      String(row.lookup_digest),
      String(row.generation),
      String(row.binding),
      String(row.account_binding),
      String(row.created_at),
      String(row.expires_at),
      String(byteSize),
      "",
    ]);
    const sealed = sealRecord(dataKey, aad, plaintext);
    db.prepare(
      "UPDATE opaque_states SET nonce = ?, tag = ?, ciphertext = ?, byte_size = ? WHERE lookup_digest = ?",
    ).run(sealed.nonce, sealed.tag, sealed.ciphertext, byteSize, String(row.lookup_digest));
    db.close();

    const reopened = makeStore();
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });
});

describe("payload schema — 合法密文也要结构校验", () => {
  it("output 非数组等畸形 payload 报 state_corrupt 而不是崩溃", () => {
    const { store, repository, keyring } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT * FROM opaque_states LIMIT 1").get() as Record<string, unknown>;
    const key = keyring.get(String(row.key_id))!;
    const dataKey = deriveAccountKey(keyring, key, CANARIES.account);
    // 合法 AEAD、但 output 不是数组：裸 JSON.parse 会让它一路穿到 .length 崩溃。
    const malformed = Buffer.from(JSON.stringify({
      version: 1,
      output: "not-an-array",
      preservedTail: [],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      compHash: "x",
      createdAt: 1,
      expiresAt: Number(row.expires_at),
    }), "utf-8");
    const byteSize = sealedSizeFor(malformed.length);
    const storeId = (JSON.parse(readFileSync(resolve(dir, "store.sentinel"), "utf-8")) as { storeId: string }).storeId;
    const sealed = sealRecord(dataKey, encodeTuple([
      "schema:1", storeId, String(row.key_id), String(row.lookup_digest),
      String(row.generation), String(row.binding), String(row.account_binding),
      String(row.created_at), String(row.expires_at), String(byteSize), "",
    ]), malformed);
    db.prepare(
      "UPDATE opaque_states SET nonce = ?, tag = ?, ciphertext = ?, byte_size = ? WHERE lookup_digest = ?",
    ).run(sealed.nonce, sealed.tag, sealed.ciphertext, byteSize, String(row.lookup_digest));
    db.close();

    const reopened = makeStore();
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });
});

describe("冷启动恢复 — 必须做真正的 AEAD 验证", () => {
  it("bit flip 之后 recover 报告 unreadable，且不删除证据", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, row.lookup_digest);
    db.close();

    const reopened = makeStore();
    const recovered = reopened.repository.recover();
    // 只查"非空"是不够的：冷启动必须真的验证 AEAD，否则 bit flip 后
    // store 看起来完全健康。
    expect(recovered.unreadable).toBe(1);
    expect(recovered.retained).toBe(0);
    expect(reopened.repository.stats().count).toBe(1);
  });

  it("发现损坏时 runtime 整体进入 not-ready（quarantine）", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT lookup_digest, ciphertext FROM opaque_states LIMIT 1").get() as
      | { lookup_digest: string; ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, row.lookup_digest);
    db.close();

    const second = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(second);
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("state_corrupt");
    // 原始字节必须保留，交由运维处置。
    const check = new DatabaseSync(resolve(dir, "state.db"));
    const count = check.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number };
    check.close();
    expect(count.n).toBe(1);
  });
});

describe("successor 映射 — 与 state 同等的认证标准", () => {
  /** 建立 predecessor → successor 映射，返回两代 marker。 */
  function seedSuccessor(): { first: string; second: string } {
    const { store, repository } = makeStore();
    const first = saveCanaryState(store);
    const resolved = resolveCanary(store, first.marker);
    const second = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: resolved.generation,
      predecessorStateId: resolved.stateId,
    });
    repository.close();
    return { first: first.marker, second: second.marker };
  }

  it("篡改 successor 密文后冷启动必须 quarantine，且不删除证据", () => {
    seedSuccessor();

    // 同时破坏密文并把 TTL 改到过去：若 recover 先信任 expires_at 批量删除，
    // 攻击者就能销毁 post-commit 幂等映射，重新打开"双失"窗口。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT predecessor_lookup, ciphertext FROM opaque_successors LIMIT 1")
      .get() as { predecessor_lookup: string; ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_successors SET ciphertext = ?, expires_at = 1 WHERE predecessor_lookup = ?")
      .run(corrupted, row.predecessor_lookup);
    db.close();

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("state_corrupt");

    const check = new DatabaseSync(resolve(dir, "state.db"));
    const count = check.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number };
    check.close();
    expect(count.n).toBe(1);
  });

  it("successor 损坏时查询抛结构化错误，而不是伪装成没有映射", () => {
    const { first } = seedSuccessor();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT predecessor_lookup, ciphertext FROM opaque_successors LIMIT 1")
      .get() as { predecessor_lookup: string; ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_successors SET ciphertext = ? WHERE predecessor_lookup = ?")
      .run(corrupted, row.predecessor_lookup);
    db.close();

    const reopened = makeStore();
    // 返回 null 会让调用方重打一次上游、随后撞 stale_generation，
    // 把真正的损坏原因彻底掩盖。
    expectReason(
      () => reopened.store.findSuccessorMarker(first, CANARIES.account),
      "state_corrupt",
    );
  });
});

describe("容量上限 — 不可满足时必须回滚", () => {
  it("capacity=1 时 recompact 被拒绝，盘上仍只有一条 state", () => {
    const { store, repository } = makeStore({ capacity: 1 });
    const first = saveCanaryState(store);
    const resolved = resolveCanary(store, first.marker);

    // 新 state 与 predecessor 都受保护、不可淘汰，因此 capacity=1 无法满足。
    // 此前 prune 遇到这种情况直接 return，save 仍 COMMIT，盘上留下 2 条。
    expectReason(() => store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: resolved.generation,
      predecessorStateId: resolved.stateId,
    }), "state_too_large");

    repository.close();
    const db = new DatabaseSync(resolve(dir, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("可变元数据 last_used_at — 必须认证", () => {
  it("篡改 last_used_at 后冷启动判为不可读，不能用于定向逐出", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    // last_used_at 决定 LRU victim。它不在记录 AAD 里（每次读取都会变），
    // 因此必须有独立 MAC；否则攻击者改这一列就能在容量压力下点名逐出。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET last_used_at = 1").run();
    db.close();

    const reopened = makeStore();
    expect(reopened.repository.recover().unreadable).toBe(1);
  });
});

describe("初始化零副作用", () => {
  it("peekMaxExpiresAt 不得创建空库（否则两阶段初始化不可重入）", () => {
    const databasePath = resolve(dir, "state.db");
    expect(existsSync(databasePath)).toBe(false);

    OpaqueCompactRepository.peekMaxExpiresAt(databasePath);

    // 默认 DatabaseSync 是读写打开，库不存在时会留下 0 字节 0644 文件；
    // 那会让后续 keyring 失败后的重启误判成 store_reset_detected。
    expect(existsSync(databasePath)).toBe(false);
  });
});

describe("格式版本 — 与 store 重置区分", () => {
  it("旧版本 sentinel 报 schema_unsupported 而不是 store_reset_detected", () => {
    // 旧格式是"需要升级/回滚"，不是"store 被重置"——后者会诱导运维重建 store。
    writeFileSync(
      resolve(dir, "store.sentinel"),
      JSON.stringify({ version: 1, storeId: "abc123", createdAt: 1 }),
      { mode: 0o600 },
    );

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("schema_unsupported");
  });
});

describe("外部密钥边界", () => {
  it("未配置 keyring_file 时 fail-closed，且不碰磁盘", () => {
    const handle = startOpaqueCompactRuntime(runtimeConfig({ keyringFile: null }));
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("key_unavailable");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("拒绝把密钥环放在 data 目录内", () => {
    const handle = startOpaqueCompactRuntime(runtimeConfig({
      keyringFile: resolve(getDataDir(), "opaque-compact", "keyring.json"),
    }));
    openHandles.push(handle);
    // 钥匙与密文同卷时，拿到数据卷或备份即可全量解密。
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("key_unavailable");
  });

  it("已初始化的 store 不允许自动重建密钥环", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    saveCanaryState(getOpaqueCompactStateStore());
    first.close();
    rmSync(keyringFile());

    // 即使允许 bootstrap，store 已 ready 就不能再造新密钥。
    const second = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(second);
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("key_unavailable");
    expect(existsSync(keyringFile())).toBe(false);
  });
});

describe("初始化可重入 — sentinel 两阶段", () => {
  it("sentinel 已写但 keyring/DB 未建时，下次启动可以补完而不是永久失败", () => {
    // 模拟"首次启动写完 sentinel 后立刻被 SIGKILL"。
    const sentinel = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: true })!;
    expect(sentinel.created).toBe(true);
    expect(sentinel.ready).toBe(false);

    // 只看"sentinel 是否存在"会误判为"store 已存在但密钥丢了"，永久 key_unavailable。
    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(true);
  });
});

describe("variantHash — 绑定必须跨 compact 边界稳定", () => {
  it("compact 前后历史不同，variantHash 必须不变（否则 restore 永远 variant_mismatch）", () => {
    const tools = [{ type: "function", name: "Read" }];
    const beforeCompact = {
      model: "gpt-5.4",
      instructions: "system prompt",
      tools,
      input: [{ role: "user", content: [{ type: "input_text", text: "原始的第一条用户消息" }] }],
      prompt_cache_key: "conv-1",
    } as unknown as Parameters<typeof opaqueCompactVariantHash>[0];
    // compact 之后历史被 marker 取代，"第一条用户消息"必然变了。
    const afterCompact = {
      ...beforeCompact,
      input: [{ role: "user", content: [{ type: "input_text", text: "<analysis>Opaque…</analysis>" }] }],
    } as unknown as Parameters<typeof opaqueCompactVariantHash>[0];

    // 这正是 opaque compact 的本质：历史会变。绑定绝不能建立在会变的东西上，
    // 否则 save 与 restore 永远算不出同一个 hash。
    expect(opaqueCompactVariantHash(afterCompact)).toBe(opaqueCompactVariantHash(beforeCompact));
  });

  it("不同 Codex 窗口 / 不同 system prompt 仍然互相隔离", () => {
    const base = {
      model: "gpt-5.4",
      instructions: "main thread",
      tools: [{ type: "function", name: "Read" }],
      input: [],
    } as unknown as Parameters<typeof opaqueCompactVariantHash>[0];

    const otherWindow = { ...base, codexWindowId: "window-2" } as typeof base;
    const subagent = { ...base, instructions: "subagent prompt" } as typeof base;

    // 需要隔离的并行维度必须仍然产生不同 hash。
    expect(opaqueCompactVariantHash(otherWindow)).not.toBe(opaqueCompactVariantHash(base));
    expect(opaqueCompactVariantHash(subagent)).not.toBe(opaqueCompactVariantHash(base));
  });
});

describe("store lock — 同进程语义", () => {
  it("同一进程内重复获取会被拒绝，释放后可再取", () => {
    const lockPath = resolve(dir, "store.lock");
    const first = acquireOpaqueCompactStoreLock(lockPath);
    expect(() => acquireOpaqueCompactStoreLock(lockPath))
      .toThrowError(/another instance holds/i);
    first.release();
    const second = acquireOpaqueCompactStoreLock(lockPath);
    second.release();
  });
});
