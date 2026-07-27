/**
 * Opaque compact state 加密持久化的单元测试。
 *
 * 覆盖四类不变量：
 * 1. 磁盘上不得出现任何明文（session / account / opaque output / encrypted_content / tail）；
 * 2. 密钥环稳定、可轮换、缺失时 fail-closed；
 * 3. generation CAS 让并发 recompact 的落败方失败，而不是静默作废对方的 marker；
 * 4. 单实例锁、schema、损坏隔离、默认关闭不碰磁盘。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import {
  loadOpaqueCompactKeyring,
  OpaqueCompactKeyringError,
  computeIndexBinding,
  computeMarkerSignature,
  sealRecord,
  openRecord,
} from "@src/routes/shared/opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
  OpaqueCompactRepositoryError,
  OPAQUE_REPOSITORY_SCHEMA_VERSION,
} from "@src/routes/shared/opaque-compact-repository.js";
import {
  acquireOpaqueCompactStoreLock,
  OpaqueCompactStoreLockError,
} from "@src/routes/shared/opaque-compact-store-lock.js";
import {
  OpaqueCompactStateError,
  OpaqueCompactStateStore,
  getOpaqueCompactStateStore,
  isOpaqueCompactStateStoreReady,
  setOpaqueCompactStateStore,
} from "@src/routes/shared/opaque-compact-state.js";
import { startOpaqueCompactRuntime } from "@src/routes/shared/opaque-compact-runtime.js";

/** 全部 canary 字符串。任何一个出现在磁盘上都判定为泄漏。 */
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

let dir: string;
const runtimeHandles: { close(): void }[] = [];

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "opaque-persist-"));
});

afterEach(() => {
  for (const handle of runtimeHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
  setOpaqueCompactStateStore(null);
  rmSync(dir, { recursive: true, force: true });
});

function keyringFile(): string {
  return resolve(dir, "keyring.json");
}

function freshKeyring(allowCreate = true) {
  return loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate });
}

function makeStore(options: { capacity?: number; maxBytes?: number; ttlMs?: number; now?: () => number } = {}) {
  const keyring = freshKeyring();
  const repository = new OpaqueCompactRepository({
    databasePath: resolve(dir, "state.db"),
    keyring,
    capacity: options.capacity ?? 128,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    ...(options.now ? { now: options.now } : {}),
  });
  const store = new OpaqueCompactStateStore({
    keyring,
    repository,
    capacity: options.capacity ?? 128,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    ttlMs: options.ttlMs ?? 30 * 60_000,
    ...(options.now ? { now: options.now } : {}),
  });
  return { keyring, repository, store };
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

function expectReason(fn: () => unknown, reason: string): void {
  try {
    fn();
    throw new Error(`expected failure with reason=${reason}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OpaqueCompactStateError);
    expect((error as OpaqueCompactStateError).reason).toBe(reason);
  }
}

/** 把目录下所有文件（含 WAL / SHM）拼成一个 buffer 做 canary 扫描。 */
function readAllBytes(target: string): Buffer {
  const chunks: Buffer[] = [];
  for (const name of readdirSync(target)) {
    const path = resolve(target, name);
    if (statSync(path).isDirectory()) {
      chunks.push(readAllBytes(path));
      continue;
    }
    chunks.push(readFileSync(path));
  }
  return Buffer.concat(chunks);
}

describe("opaque compact keyring", () => {
  it("creates a 0600 keyring and derives three domain-separated subkeys", () => {
    const keyring = freshKeyring();
    const key = keyring.active();

    expect(keyring.keys).toHaveLength(1);
    expect(statSync(keyringFile()).mode & 0o777).toBe(0o600);
    // 三个子密钥必须互不相同，否则 marker 签名可以被用来伪造索引或解密记录。
    expect(key.markerHmacKey.equals(key.indexKey)).toBe(false);
    expect(key.markerHmacKey.equals(key.aeadKey)).toBe(false);
    expect(key.indexKey.equals(key.aeadKey)).toBe(false);
    // 磁盘上不保存派生结果，只保存 master material。
    const raw = readFileSync(keyringFile(), "utf-8");
    expect(raw).not.toContain(key.markerHmacKey.toString("base64"));
    expect(raw).not.toContain(key.aeadKey.toString("base64"));
  });

  it("is stable across reloads so markers survive a restart", () => {
    const first = freshKeyring().active();
    const second = loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: false }).active();

    expect(second.id).toBe(first.id);
    expect(computeMarkerSignature(second, "m").equals(computeMarkerSignature(first, "m"))).toBe(true);
    expect(computeIndexBinding(second, "b")).toBe(computeIndexBinding(first, "b"));
  });

  it("refuses to mint a new key when persisted state already exists", () => {
    expect(() => loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: false }))
      .toThrowError(OpaqueCompactKeyringError);
    try {
      loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: false });
    } catch (error) {
      expect((error as OpaqueCompactKeyringError).reason).toBe("key_unavailable");
    }
    expect(existsSync(keyringFile())).toBe(false);
  });

  it("rejects malformed keyrings instead of silently regenerating", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ version: 99, activeKeyId: "a", keys: [{ id: "a", material: "AA==" }] }),
      JSON.stringify({ version: 1, activeKeyId: "missing", keys: [{ id: "a", material: "AA==" }] }),
      JSON.stringify({ version: 1, activeKeyId: "a", keys: [{ id: "a", material: "c2hvcnQ=" }] }),
    ]) {
      writeFileSync(keyringFile(), bad);
      try {
        loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: true });
        throw new Error("expected key_invalid");
      } catch (error) {
        expect(error).toBeInstanceOf(OpaqueCompactKeyringError);
        expect((error as OpaqueCompactKeyringError).reason).toBe("key_invalid");
      }
    }
  });

  it("keeps previous keys valid for verification after rotation", () => {
    const original = freshKeyring().active();
    const rotatedId = "k-rotated";
    const stored = JSON.parse(readFileSync(keyringFile(), "utf-8")) as {
      keys: { id: string; material: string; createdAt: number }[];
      activeKeyId: string;
      version: number;
    };
    stored.keys.push({
      id: rotatedId,
      material: Buffer.alloc(32, 9).toString("base64"),
      createdAt: Date.now(),
    });
    stored.activeKeyId = rotatedId;
    writeFileSync(keyringFile(), JSON.stringify(stored));

    const rotated = loadOpaqueCompactKeyring({ keyringFile: keyringFile(), allowCreate: false });
    expect(rotated.activeKeyId).toBe(rotatedId);
    // active 在前，previous 仍在环内 → 旧 marker 仍可验签。
    expect(rotated.keys[0]!.id).toBe(rotatedId);
    expect(rotated.get(original.id)).toBeDefined();
  });

  it("fails AEAD verification when AAD or ciphertext is altered", () => {
    const key = freshKeyring().active();
    const aad = Buffer.from("aad-v1");
    const sealed = sealRecord(key, aad, Buffer.from("secret"));

    expect(openRecord(key, aad, sealed).toString()).toBe("secret");
    expect(() => openRecord(key, Buffer.from("aad-v2"), sealed)).toThrow();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => openRecord(key, aad, { ...sealed, ciphertext: flipped })).toThrow();
  });
});

describe("opaque compact repository", () => {
  it("stores nothing readable on disk — every canary must be absent", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    const bytes = readAllBytes(dir);
    for (const [label, canary] of Object.entries(CANARIES)) {
      expect(bytes.includes(Buffer.from(canary)), `${label} leaked to disk`).toBe(false);
    }
    // 连列名之外的结构性明文也不该出现。
    expect(bytes.includes(Buffer.from("function_call_output"))).toBe(false);
    expect(bytes.includes(Buffer.from("encrypted_content"))).toBe(false);
  });

  it("survives a process restart: marker resolves against a fresh store", () => {
    const first = makeStore();
    const { marker } = saveCanaryState(first.store);
    first.repository.close();

    // 模拟重启：全新 keyring 加载 + 全新 repository。
    const second = makeStore();
    const restored = second.store.resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    });

    expect(restored.output).toEqual(OUTPUT);
    expect(restored.preservedTail).toEqual(PRESERVED_TAIL);
    expect(restored.accountEntryId).toBe(CANARIES.account);
    expect(restored.generation).toBe(1);
    second.repository.close();
  });

  it("binds state to session, model, variant, and account", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);

    expectReason(() => store.resolve({ marker, sessionId: "other", model: "gpt-5.4" }), "session_mismatch");
    expectReason(() => store.resolve({ marker, sessionId: CANARIES.session, model: "gpt-5.5" }), "model_mismatch");
    expectReason(() => store.resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: "different-variant",
    }), "variant_mismatch");
    expectReason(() => store.resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: "other-entry",
    }), "account_mismatch");
    repository.close();
  });

  it("advances generations and invalidates the superseded marker in one transaction", () => {
    const { store, repository } = makeStore();
    const first = saveCanaryState(store, 0);
    expect(first.generation).toBe(1);

    const resolved = store.resolve({
      marker: first.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    });
    const second = saveCanaryState(store, resolved.generation);
    expect(second.generation).toBe(2);

    // 旧 marker 在同一事务里被废止 → 立刻 missing，不留悬挂状态。
    expectReason(() => store.resolve({
      marker: first.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }), "missing");
    expect(store.resolve({
      marker: second.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }).output).toEqual(OUTPUT);
    repository.close();
  });

  it("fails the losing side of a concurrent recompact instead of silently voiding its marker", () => {
    const { store, repository } = makeStore();
    const base = saveCanaryState(store, 0);
    const resolved = store.resolve({
      marker: base.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    });

    // 两个并发 recompact 都基于同一个 generation 出发。先完成的赢。
    const winner = saveCanaryState(store, resolved.generation);
    expectReason(() => saveCanaryState(store, resolved.generation), "stale_generation");

    // 赢家的 marker 必须仍然有效——这正是之前"后完成者删掉先完成者"的回归点。
    expect(store.resolve({
      marker: winner.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }).generation).toBe(2);
    repository.close();
  });

  it("keeps independent variants isolated under the same session and model", () => {
    const { store, repository } = makeStore();
    const main = store.save({
      output: [{ value: "main" }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "variant-main",
      expectedGeneration: 0,
    });
    const sub = store.save({
      output: [{ value: "sub" }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "variant-sub",
      expectedGeneration: 0,
    });

    // 子代理的 compact 不得作废主线程的 marker。
    expect(store.resolve({
      marker: main.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: "variant-main",
    }).output).toEqual([{ value: "main" }]);
    expect(store.resolve({
      marker: sub.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: "variant-sub",
    }).output).toEqual([{ value: "sub" }]);
    repository.close();
  });

  it("rejects markers signed by a foreign keyring", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const otherDir = mkdtempSync(resolve(tmpdir(), "opaque-other-"));
    try {
      const otherKeyring = loadOpaqueCompactKeyring({
        keyringFile: resolve(otherDir, "keyring.json"),
        allowCreate: true,
      });
      const otherRepo = new OpaqueCompactRepository({
        databasePath: resolve(dir, "state.db"),
        keyring: otherKeyring,
        capacity: 128,
        maxBytes: 64 * 1024 * 1024,
      });
      const otherStore = new OpaqueCompactStateStore({ keyring: otherKeyring, repository: otherRepo });
      // 签名用的是别的密钥环 → 在读记录之前就被拒绝。
      expectReason(() => otherStore.resolve({
        marker,
        sessionId: CANARIES.session,
        model: "gpt-5.4",
      }), "tampered");
      otherRepo.close();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("reports state_corrupt when ciphertext is tampered with on disk", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare("SELECT state_id, ciphertext FROM opaque_states LIMIT 1").get() as
      | { state_id: string; ciphertext: Uint8Array }
      | undefined;
    expect(row).toBeDefined();
    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE state_id = ?").run(corrupted, row!.state_id);
    db.close();

    const reopened = makeStore();
    expectReason(() => reopened.store.resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }), "state_corrupt");
    reopened.repository.close();
  });

  it("refuses to open a database written by an unsupported schema version", () => {
    const keyring = freshKeyring();
    const databasePath = resolve(dir, "state.db");
    const seeded = new OpaqueCompactRepository({ databasePath, keyring, capacity: 8, maxBytes: 1024 * 1024 });
    seeded.close();

    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE opaque_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(OPAQUE_REPOSITORY_SCHEMA_VERSION + 1));
    db.close();

    try {
      new OpaqueCompactRepository({ databasePath, keyring, capacity: 8, maxBytes: 1024 * 1024 });
      throw new Error("expected schema_unsupported");
    } catch (error) {
      expect(error).toBeInstanceOf(OpaqueCompactRepositoryError);
      expect((error as OpaqueCompactRepositoryError).reason).toBe("schema_unsupported");
    }
  });

  it("drops expired states on startup recovery", () => {
    let now = 1_000_000;
    const { store, repository } = makeStore({ ttlMs: 1000, now: () => now });
    saveCanaryState(store);
    expect(repository.stats().count).toBe(1);

    now += 5000;
    const recovered = repository.recover();
    expect(recovered.expired).toBe(1);
    expect(recovered.retained).toBe(0);
    expect(repository.stats().count).toBe(0);
    repository.close();
  });

  it("evicts least-recently-used records once the byte budget is exceeded", () => {
    const { store, repository } = makeStore({ capacity: 10, maxBytes: 2_000 });
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

    expect(repository.stats().bytes).toBeLessThanOrEqual(2_000);
    expectReason(() => store.resolve({
      marker: first.marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: "v1",
    }), "missing");
    repository.close();
  });
});

describe("opaque compact store lock", () => {
  it("grants the lock to one holder and refuses the second instance", () => {
    const lockPath = resolve(dir, "store.lock");
    const first = acquireOpaqueCompactStoreLock(lockPath);

    try {
      acquireOpaqueCompactStoreLock(lockPath);
      throw new Error("expected store_locked");
    } catch (error) {
      expect(error).toBeInstanceOf(OpaqueCompactStoreLockError);
      expect((error as OpaqueCompactStoreLockError).reason).toBe("store_locked");
    }

    first.release();
    const second = acquireOpaqueCompactStoreLock(lockPath);
    expect(second.pid).toBe(process.pid);
    second.release();
  });

  it("reclaims a lock whose holder process is gone (kill -9 recovery)", () => {
    const lockPath = resolve(dir, "store.lock");
    // pid 中不存在的高位值模拟被 kill -9 的前一个实例。
    writeFileSync(lockPath, JSON.stringify({ pid: 0x7ffffff0, nonce: "dead", acquiredAt: 1 }));

    const handle = acquireOpaqueCompactStoreLock(lockPath);
    expect(handle.pid).toBe(process.pid);
    handle.release();
  });

  it("does not delete a lock re-acquired by someone else", () => {
    const lockPath = resolve(dir, "store.lock");
    const handle = acquireOpaqueCompactStoreLock(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: "other", acquiredAt: 2 }));

    handle.release();
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("opaque compact runtime lifecycle", () => {
  it("touches nothing on disk while the feature is disabled", () => {
    const handle = startOpaqueCompactRuntime({
      enabled: false,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    runtimeHandles.push(handle);

    expect(handle.ready).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(isOpaqueCompactStateStoreReady()).toBe(false);
    // 关闭状态下取 store 必须抛结构化错误，而不是返回一个能用的内存 store。
    expect(() => getOpaqueCompactStateStore()).toThrowError(OpaqueCompactStateError);
  });

  it("becomes ready when enabled and persists markers across a restart", () => {
    const first = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    expect(first.ready).toBe(true);
    const { marker } = saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    const second = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    runtimeHandles.push(second);
    expect(second.ready).toBe(true);
    expect(getOpaqueCompactStateStore().resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }).output).toEqual(OUTPUT);
  });

  it("refuses to start a second instance and reports store_locked", () => {
    const first = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    runtimeHandles.push(first);
    expect(first.ready).toBe(true);

    const second = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("store_locked");
    expect(isOpaqueCompactStateStoreReady()).toBe(false);
  });

  it("fails closed with key_unavailable when the keyring is lost but the database remains", () => {
    const first = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    rmSync(resolve(dir, "keyring.json"));
    const second = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    runtimeHandles.push(second);

    // 绝不能重新生成密钥：那会把既有密文变成永久不可读的垃圾。
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("key_unavailable");
    expect(existsSync(resolve(dir, "keyring.json"))).toBe(false);
    expect(existsSync(resolve(dir, "state.db"))).toBe(true);
  });

  it("survives an abrupt kill: state committed before the crash is still resolvable", () => {
    const first = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    const { marker } = saveCanaryState(getOpaqueCompactStateStore());
    // 模拟 kill -9：不调用 close()（DB 连接和 WAL 都没有被优雅收尾），并把锁文件
    // 改成一个已经消失的 pid —— 崩溃进程留下的锁正是这个样子。
    runtimeHandles.push(first);
    setOpaqueCompactStateStore(null);
    writeFileSync(
      resolve(dir, "store.lock"),
      JSON.stringify({ pid: 0x7ffffff0, nonce: "crashed", acquiredAt: 1 }),
    );

    const restarted = startOpaqueCompactRuntime({
      enabled: true,
      ttlMinutes: 30,
      capacity: 128,
      maxBytes: 1024 * 1024,
      directory: dir,
    });
    runtimeHandles.push(restarted);

    // 正确性不依赖 graceful shutdown：WAL + synchronous=FULL 已经保证了这一点。
    expect(restarted.ready).toBe(true);
    expect(getOpaqueCompactStateStore().resolve({
      marker,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      variantHash: CANARIES.variant,
    }).output).toEqual(OUTPUT);
  });
});
