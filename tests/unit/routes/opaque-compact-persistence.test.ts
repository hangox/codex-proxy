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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
  validateSuccessorMarkerForRecovery,
} from "@src/routes/shared/opaque-compact-state.js";
import {
  forgetOpaqueCompactRuntimeForTesting,
  reconfigureOpaqueCompactRuntime,
  startOpaqueCompactRuntime,
} from "@src/routes/shared/opaque-compact-runtime.js";
import { seedLegacyOpaqueStore } from "@helpers/opaque-compact-legacy-fixture.js";
import { opaqueCompactVariantHash } from "@src/routes/shared/opaque-compact-bridge.js";
import { opaqueCompactSemanticDigest } from "@src/routes/shared/codex-compact-service.js";
import { normalizeServiceTierForUpstream } from "@src/proxy/codex-api.js";
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
const DIGESTS = {
  canary: "digest-canary-v1",
  oversized: "digest-oversized-v1",
  lru1: "digest-lru-v1",
  lru2: "digest-lru-v2",
  lru3: "digest-lru-v3",
  successor: "digest-successor-v1",
  forged: "digest-forged-v1",
} as const;

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
  // 与生产一致地接线 successor marker 语义校验。
  repository.setSuccessorMarkerValidator((marker, expected) =>
    validateSuccessorMarkerForRecovery(store, repository, marker, expected));
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
    compactInputDigest: DIGESTS.canary,
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

function findCanarySuccessor(
  store: OpaqueCompactStateStore,
  predecessorMarker: string | null,
  overrides: Partial<Parameters<OpaqueCompactStateStore["findSuccessorMarker"]>[0]> = {},
) {
  return store.findSuccessorMarker({
    predecessorMarker,
    sessionId: CANARIES.session,
    model: "gpt-5.4",
    compactInputDigest: DIGESTS.successor,
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

  it("8.5 reason 拆分：状态过期但行曾经存在，报 expired；再次 resolve（行已被删）报 not_found", () => {
    let now = 1_000_000;
    const { store } = makeStore({ now: () => now });
    const { marker } = saveCanaryState(store);

    now += 31 * 60_000; // 跨过 makeStore 默认的 30 分钟 TTL

    // 行确实存在过（刚刚 save 成功），只是 TTL 到了——8.5 拆分之前，持久化
    // 模式下这个分支永远抛 missing（load() 过期即删、返回 null，state.ts
    // 把 null 一律读成 missing），调用方因此无法区分"从未存在"与"曾经有
    // 过、已过期"。现在必须是 expired。
    expectReason(() => resolveCanary(store, marker), "expired");
    // load() 在上一次 resolve 里已经把过期行删掉了：同一个 marker 第二次
    // resolve 必须是 not_found（行确实不在了），不能继续报 expired
    // ——那会造成"反复读到同一条过期记录"的假象。
    expectReason(() => resolveCanary(store, marker), "not_found");
  });

  it("8.5 reason 拆分：行被直接删除（如隔离/取证清理）报 not_found，不与 expired 混淆", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("DELETE FROM opaque_states").run();
    db.close();

    // 同一密钥环重开：marker 签名仍然有效，只是它指向的行已经不在了——
    // 这是"从未过期，纯粹查无此行"的场景，必须是 not_found 而不是 expired。
    const reopened = makeStore();
    expectReason(() => resolveCanary(reopened.store, marker), "not_found");
  });

  it("篡改 expires_at 无法延长寿命（8.4 起由 expires_at_mac 独立保护，不再是 AAD）", () => {
    const { store, repository } = makeStore();
    const { marker } = saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET expires_at = ?").run(Date.now() + 10 * 365 * 24 * 3600_000);
    db.close();

    const reopened = makeStore();
    // 8.4 之前 expires_at 在 AAD 里，篡改会让 AEAD 认证失败；8.4 之后
    // expires_at 移出 AAD、改由独立的 expires_at_mac 保护（sliding TTL 需要
    // 能顺延它而不用整条重新封装密文），但"篡改后过不了认证"这个结论必须
    // 原样成立，只是把关的机制换了——这里验证的正是这条不变式没有因为
    // 8.4 的重构而悄悄松掉。
    expectReason(() => resolveCanary(reopened.store, marker), "state_corrupt");
  });

  it("8.4：restore 成功会把 expires_at 顺延到 now()+ttlMs，新值同样受 expires_at_mac 保护", () => {
    let now = 1_000_000;
    const { store, keyring } = makeStore({ now: () => now });
    const { marker } = saveCanaryState(store);

    const dbBefore = new DatabaseSync(resolve(dir, "state.db"));
    const before = dbBefore.prepare(
      "SELECT lookup_digest, expires_at, expires_at_mac FROM opaque_states",
    ).get() as { lookup_digest: string; expires_at: number; expires_at_mac: string };
    dbBefore.close();
    // TTL_MS 是这个文件顶部的 30 分钟常量；save() 时 expires_at = createdAt + TTL_MS。
    expect(before.expires_at).toBe(now + TTL_MS);

    // 快进到接近（但还没到）原本的到期时间，再 restore 一次。
    now += TTL_MS - 60_000;
    const restored = resolveCanary(store, marker);
    expect(restored.output).toEqual(OUTPUT);

    const dbAfter = new DatabaseSync(resolve(dir, "state.db"));
    const after = dbAfter.prepare(
      "SELECT expires_at, expires_at_mac FROM opaque_states WHERE lookup_digest = ?",
    ).get(before.lookup_digest) as { expires_at: number; expires_at_mac: string };
    dbAfter.close();

    // 决定性断言：顺延后的新值 = 本次 restore 时刻 + TTL，而不是旧值原地不动，
    // 也不是简单地"往后加一点"——sliding TTL 是重置窗口，不是累加窗口。
    expect(after.expires_at).toBe(now + TTL_MS);
    expect(after.expires_at).toBeGreaterThan(before.expires_at);
    // 新值必须配一个与之匹配的、真实计算出来的新 MAC，而不是沿用旧 MAC 或
    // 留空——旧 MAC 绑定的是旧值，沿用会在下次 load() 时被判定为不可信。
    expect(after.expires_at_mac).not.toBe(before.expires_at_mac);
    expect(after.expires_at_mac).toBe(
      computeMutableMetaMac(keyring, before.lookup_digest, "expires_at", after.expires_at),
    );
  });

  it("8.4 blocker 回归（reviewer 实测复现）：顺延后再次 resolve，now() 跨过原始绝对期限但落在新窗口内必须成功，不能报 expired", () => {
    // 根因：loadPersisted()（opaque-compact-state.ts）此前把 store.resolve()
    // 返回值的 expiresAt 写成了 payload.expiresAt——加密 payload 里冻结的
    // 创建时快照，sliding TTL 的设计前提就是"不重新封装密文，只改列 + MAC"，
    // 所以这个字段从创建那一刻起永远不变。repository.load() 明明已经把顺延
    // 后的新值算好、写回 DB、并通过 loaded.meta.expiresAt 返回——上一条用例
    // （"restore 成功会把 expires_at 顺延..."）只验证了"DB 列被正确顺延"，
    // 从未验证"顺延之后 store.resolve() 本身是否真的认这个新值"，是同一个
    // "验证账本记对了，而非账本被正确读出"的盲区在另一层再次出现。这条用例
    // 直接对着 resolve() 的返回值/是否抛错断言，不下钻到 DB 列。
    let now = 1_000_000;
    const { store } = makeStore({ now: () => now });
    const { marker } = saveCanaryState(store);
    // save() 时 expires_at = now + TTL_MS，这是"原始绝对期限"。
    const originalDeadline = now + TTL_MS;

    // 第一次 resolve：仍在原始窗口内，repository 层把 expires_at 顺延到
    // (此刻 now) + TTL_MS——新窗口比原始窗口晚。
    now += TTL_MS - 60_000;
    resolveCanary(store, marker);

    // 第二次 resolve：now 已经越过 originalDeadline（若应用层错误地读了
    // payload 里冻结的创建时快照，这里会被误判为 expired 并把仍然合法的
    // state 删掉），但仍落在上一步顺延出的新窗口之内——顺延真正生效时，
    // 这里必须是一次成功的 restore，而不是 OpaqueCompactStateError("expired")。
    now = originalDeadline + 200_000;
    const restored = resolveCanary(store, marker);
    expect(restored.output).toEqual(OUTPUT);

    // 再验证一次：这不是"侥幸没删"，state 在第三次 resolve 时依然存在、
    // 内容依然完整（真正被误删的话，这里会变成 not_found/expired）。
    const restoredAgain = resolveCanary(store, marker);
    expect(restoredAgain.output).toEqual(OUTPUT);
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
      compactInputDigest: DIGESTS.oversized,
      accountCandidates: [CANARIES.account],
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
      compactInputDigest: DIGESTS.lru1,
      accountCandidates: [CANARIES.account],
    });
    // direct save 只代表 COMMIT，不代表 marker 已送达。先 resolve 模拟客户端确实
    // 用上 marker，释放 incoming root edge 后该 state 才能参与正常 LRU 淘汰。
    resolveCanary(store, first.marker, { variantHash: "v1" });
    const second = store.save({
      output: [{ value: "b".repeat(700) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "v2",
      expectedGeneration: 0,
      compactInputDigest: DIGESTS.lru2,
      accountCandidates: [CANARIES.account],
    });
    resolveCanary(store, second.marker, { variantHash: "v2" });
    store.save({
      output: [{ value: "c".repeat(700) }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: "v3",
      expectedGeneration: 0,
      compactInputDigest: DIGESTS.lru3,
      accountCandidates: [CANARIES.account],
    });
    expect(repository.stats().bytes).toBeLessThanOrEqual(2_400);
    // 持久化模式下"行被 LRU 淘汰后查无此行"是 not_found（8.5 拆分），
    // 不再是内存模式专用的 missing。
    expectReason(
      () => resolveCanary(store, first.marker, { variantHash: "v1" }),
      "not_found",
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

  it("过期记录在 recover 时连同 incoming/outgoing edge 原子清理", () => {
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
    repository.setSuccessorMarkerValidator((marker, expected) =>
      validateSuccessorMarkerForRecovery(store, repository, marker, expected));
    const first = saveCanaryState(store);
    const predecessor = resolveCanary(store, first.marker);
    store.save({
      output: [{ generation: 2 }],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: predecessor.generation,
      predecessorStateId: predecessor.stateId,
      compactInputDigest: "recover-expired-child",
      accountCandidates: [CANARIES.account],
    });
    expect(repository.stats().count).toBe(2);

    now += 5000;
    const recovered = repository.recover();
    expect(recovered.expired).toBe(2);
    expect(repository.stats()).toEqual({ count: 0, bytes: 0 });
    const db = new DatabaseSync(resolve(dir, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number }).n).toBe(0);
    db.close();
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
      compactInputDigest: DIGESTS.successor,
      accountCandidates: [CANARIES.account],
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
      compactInputDigest: DIGESTS.successor,
      accountCandidates: [CANARIES.account],
    });

    const replayed = findCanarySuccessor(store, first.marker);
    expect(replayed).toBe(second.marker);
    // 账号域进入 edge lookup 后，其他账号只能得到未命中，不能看到 winner。
    expect(findCanarySuccessor(store, first.marker, { accountCandidates: ["entry-other"] })).toBeNull();
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
      compactInputDigest: DIGESTS.successor,
      accountCandidates: [CANARIES.account],
    });

    // 使用 successor == 客户端确实收到了它。
    resolveCanary(store, second.marker);
    // 此时只回收指向 successor 的 incoming edge；predecessor state 仍需支持
    // 同一前驱上的其他 digest 分叉，之后再按正常 LRU/TTL 自然回收。
    expect(findCanarySuccessor(store, first.marker)).toBeNull();
    expect(resolveCanary(store, first.marker).output).toEqual(OUTPUT);
  });
});

describe("内容寻址 edge — Task #44 回归", () => {
  it("digest 对对象键顺序稳定、对数组顺序敏感，并忽略 transport 字段", () => {
    const base = {
      model: "gpt-5.4",
      instructions: "system",
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "assistant", content: [{ type: "output_text", text: "second" }] },
      ],
      tools: [{ type: "function", name: "Read", parameters: { b: 2, a: 1 } }],
      reasoning: { summary: "auto", effort: "high" },
      text: { format: { type: "json_schema", name: "result", schema: { z: 1, a: 2 } } },
      service_tier: "fast",
      prompt_cache_key: "cache-a",
      client_metadata: { installation: "one" },
      turnState: "turn-a",
      turnMetadata: "metadata-a",
      betaFeatures: "beta-a",
      version: "1.0.0",
      includeTimingMetrics: "true",
      codexWindowId: "window-a",
      parentThreadId: "parent-a",
    } as Parameters<typeof opaqueCompactSemanticDigest>[0];
    const reordered = {
      ...base,
      tools: [{ parameters: { a: 1, b: 2 }, name: "Read", type: "function" }],
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { schema: { a: 2, z: 1 }, name: "result", type: "json_schema" } },
    } as Parameters<typeof opaqueCompactSemanticDigest>[0];
    const transportChanged = {
      ...base,
      prompt_cache_key: "cache-b",
      client_metadata: { installation: "two" },
      turnState: "turn-b",
      turnMetadata: "metadata-b",
      betaFeatures: "beta-b",
      version: "2.0.0",
      includeTimingMetrics: "false",
      codexWindowId: "window-b",
      parentThreadId: "parent-b",
    } as Parameters<typeof opaqueCompactSemanticDigest>[0];
    const reversedInput = { ...base, input: [...base.input].reverse() } as typeof base;

    expect(opaqueCompactSemanticDigest(reordered)).toBe(opaqueCompactSemanticDigest(base));
    expect(opaqueCompactSemanticDigest(transportChanged)).toBe(opaqueCompactSemanticDigest(base));
    expect(opaqueCompactSemanticDigest(reversedInput)).not.toBe(opaqueCompactSemanticDigest(base));

    const priority = { ...base, service_tier: "priority" } as typeof base;
    expect(normalizeServiceTierForUpstream(base.service_tier)).toBe("priority");
    expect(opaqueCompactSemanticDigest(priority)).toBe(opaqueCompactSemanticDigest(base));
  });

  it("同 session/model/variant/digest 的不同账号各自产生 generation=1，绝不跨账号回放", () => {
    const { store, repository } = makeStore();
    const common = {
      sessionId: "shared-session",
      model: "gpt-5.4",
      variantHash: "shared-variant",
      expectedGeneration: 0,
      predecessorStateId: null,
      compactInputDigest: "shared-digest",
    } as const;
    const accountA = store.save({
      ...common,
      output: [{ owner: "a" }],
      accountEntryId: "entry-a",
      accountCandidates: ["entry-a", "entry-b"],
    });
    const accountB = store.save({
      ...common,
      output: [{ owner: "b" }],
      accountEntryId: "entry-b",
      accountCandidates: ["entry-a", "entry-b"],
    });

    expect(accountA.replayed).toBe(false);
    expect(accountB.replayed).toBe(false);
    expect(accountA.marker).not.toBe(accountB.marker);
    expect(accountA.generation).toBe(1);
    expect(accountB.generation).toBe(1);
    expect(store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: common.sessionId,
      model: common.model,
      compactInputDigest: common.compactInputDigest,
      variantHash: common.variantHash,
      accountCandidates: ["entry-a"],
    })).toBe(accountA.marker);
    expect(store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: common.sessionId,
      model: common.model,
      compactInputDigest: common.compactInputDigest,
      variantHash: common.variantHash,
      accountCandidates: ["entry-b"],
    })).toBe(accountB.marker);
    expect(store.resolve({
      marker: accountA.marker,
      sessionId: common.sessionId,
      model: common.model,
      variantHash: common.variantHash,
      accountCandidates: ["entry-a"],
      confirmDelivery: false,
    }).output).toEqual([{ owner: "a" }]);
    expect(store.resolve({
      marker: accountB.marker,
      sessionId: common.sessionId,
      model: common.model,
      variantHash: common.variantHash,
      accountCandidates: ["entry-b"],
      confirmDelivery: false,
    }).output).toEqual([{ owner: "b" }]);
    expect(repository.stats().count).toBe(2);
  });

  it("同账号/session/model/digest 的不同 variant 各自命中自己的 edge", () => {
    const { store } = makeStore();
    const common = {
      sessionId: "variant-session",
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      expectedGeneration: 0,
      predecessorStateId: null,
      compactInputDigest: "variant-shared-digest",
      accountCandidates: [CANARIES.account],
    } as const;
    const variantA = store.save({ ...common, output: [{ window: "a" }], variantHash: "variant-a" });
    const variantB = store.save({ ...common, output: [{ window: "b" }], variantHash: "variant-b" });

    expect(variantA.replayed).toBe(false);
    expect(variantB.replayed).toBe(false);
    expect(variantA.marker).not.toBe(variantB.marker);
    expect(store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: common.sessionId,
      model: common.model,
      compactInputDigest: common.compactInputDigest,
      variantHash: "variant-a",
      accountCandidates: common.accountCandidates,
    })).toBe(variantA.marker);
    expect(store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: common.sessionId,
      model: common.model,
      compactInputDigest: common.compactInputDigest,
      variantHash: "variant-b",
      accountCandidates: common.accountCandidates,
    })).toBe(variantB.marker);
    expect(store.resolve({
      marker: variantB.marker,
      sessionId: common.sessionId,
      model: common.model,
      variantHash: "variant-b",
      accountCandidates: common.accountCandidates,
      confirmDelivery: false,
    }).output).toEqual([{ window: "b" }]);
  });

  it("显式删除 root state 时同步删除 incoming/outgoing edge，stats 完全收敛", () => {
    const { store, repository } = makeStore();
    const saved = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      compactInputDigest: "explicit-delete-root",
      accountCandidates: [CANARIES.account],
    });
    store.delete(saved.marker);

    expect(repository.stats()).toEqual({ count: 0, bytes: 0 });
    const db = new DatabaseSync(resolve(dir, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number }).n).toBe(0);
    db.close();
    expect(store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      compactInputDigest: "explicit-delete-root",
      variantHash: CANARIES.variant,
      accountCandidates: [CANARIES.account],
    })).toBeNull();
  });

  it("LRU 淘汰 state 时同步删除其 incoming 与 outgoing edge", () => {
    const { store, repository } = makeStore({ capacity: 2 });
    const first = store.save({
      output: [{ n: 1 }], sessionId: "lru-a", model: "gpt-5.4",
      accountEntryId: CANARIES.account, variantHash: "v", compactInputDigest: "lru-a",
      accountCandidates: [CANARIES.account],
    });
    const second = store.save({
      output: [{ n: 2 }], sessionId: "lru-b", model: "gpt-5.4",
      accountEntryId: CANARIES.account, variantHash: "v", compactInputDigest: "lru-b",
      accountCandidates: [CANARIES.account],
    });
    // 释放第二条的 incoming edge，使其可独立保留；第一条仍带 root edge，正是攻击路径。
    store.resolve({ marker: second.marker, sessionId: "lru-b", model: "gpt-5.4", variantHash: "v", accountCandidates: [CANARIES.account] });
    store.save({
      output: [{ n: 3 }], sessionId: "lru-c", model: "gpt-5.4",
      accountEntryId: CANARIES.account, variantHash: "v", compactInputDigest: "lru-c",
      accountCandidates: [CANARIES.account],
    });

    // 持久化模式下"行被 LRU 淘汰后查无此行"是 not_found（8.5 拆分），
    // 不再是内存模式专用的 missing。
    expectReason(() => store.resolve({ marker: first.marker, sessionId: "lru-a", model: "gpt-5.4", variantHash: "v", accountCandidates: [CANARIES.account] }), "not_found");
    expect(store.findSuccessorMarker({ predecessorMarker: null, sessionId: "lru-a", model: "gpt-5.4", compactInputDigest: "lru-a", variantHash: "v", accountCandidates: [CANARIES.account] })).toBeNull();
    const db = new DatabaseSync(resolve(dir, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM opaque_successors WHERE successor_lookup NOT IN (SELECT lookup_digest FROM opaque_states) OR predecessor_lookup <> '' AND predecessor_lookup NOT IN (SELECT lookup_digest FROM opaque_states)").get() as { n: number }).n).toBe(0);
    db.close();
    expect(repository.stats().count).toBe(2);
  });

  it("相同 root input 回放同一 marker，不同 root input 各自成边", () => {
    const { store, repository } = makeStore();
    const common = {
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 0,
      predecessorStateId: null,
      accountCandidates: [CANARIES.account],
    } as const;
    const first = store.save({ ...common, output: [{ root: "winner" }], compactInputDigest: "root-input-a" });
    const retry = store.save({ ...common, output: [{ root: "loser" }], compactInputDigest: "root-input-a" });
    const branch = store.save({ ...common, output: [{ root: "branch" }], compactInputDigest: "root-input-b" });

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.marker).toBe(first.marker);
    expect(retry.state.output).toEqual([{ root: "winner" }]);
    expect(branch.replayed).toBe(false);
    expect(branch.marker).not.toBe(first.marker);
    expect(first.generation).toBe(1);
    expect(branch.generation).toBe(1);
    expect(repository.stats().count).toBe(2);
  });

  it("同 predecessor + 相同 input 回放 winner，不同 input 形成独立分叉", () => {
    const { store, repository } = makeStore();
    const root = saveCanaryState(store);
    const predecessor = resolveCanary(store, root.marker);
    const common = {
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: predecessor.generation,
      predecessorStateId: predecessor.stateId,
      accountCandidates: [CANARIES.account],
    } as const;
    const first = store.save({ ...common, output: [{ branch: "winner" }], compactInputDigest: "child-input-a" });
    const retry = store.save({ ...common, output: [{ branch: "loser" }], compactInputDigest: "child-input-a" });
    const fork = store.save({ ...common, output: [{ branch: "fork" }], compactInputDigest: "child-input-b" });

    expect(retry.replayed).toBe(true);
    expect(retry.marker).toBe(first.marker);
    expect(retry.state.output).toEqual([{ branch: "winner" }]);
    expect(fork.replayed).toBe(false);
    expect(fork.marker).not.toBe(first.marker);
    expect(first.generation).toBe(2);
    expect(fork.generation).toBe(2);
    expect(repository.stats().count).toBe(3);
    expect(resolveCanary(store, first.marker).output).toEqual([{ branch: "winner" }]);
    expect(resolveCanary(store, fork.marker).output).toEqual([{ branch: "fork" }]);
  });

  it("重启后仍按 root edge 回放同一个 marker，并完整认证 target state", () => {
    const first = makeStore();
    const saved = first.store.save({
      output: OUTPUT,
      preservedTail: [...PRESERVED_TAIL],
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 0,
      predecessorStateId: null,
      compactInputDigest: "restart-root-input",
      accountCandidates: [CANARIES.account],
    });
    first.repository.close();

    const reopened = makeStore();
    const replayed = reopened.store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      compactInputDigest: "restart-root-input",
      variantHash: CANARIES.variant,
      accountCandidates: [CANARIES.account],
    });
    expect(replayed).toBe(saved.marker);
    expect(resolveCanary(reopened.store, replayed!).output).toEqual(OUTPUT);
  });

  it("missing predecessor 在事务内 fail-closed，state 与 edge 都零写入", () => {
    const { store, repository } = makeStore();
    const before = new DatabaseSync(resolve(dir, "state.db"));
    const beforeStates = (before.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number }).n;
    const beforeEdges = (before.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number }).n;
    before.close();

    expectReason(() => store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 1,
      predecessorStateId: "missing-predecessor-state-id",
      compactInputDigest: "missing-predecessor-input",
      accountCandidates: [CANARIES.account],
    }), "stale_generation");

    const after = new DatabaseSync(resolve(dir, "state.db"));
    expect((after.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number }).n)
      .toBe(beforeStates);
    expect((after.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as { n: number }).n)
      .toBe(beforeEdges);
    after.close();
    expect(repository.stats().count).toBe(beforeStates);
  });

  it("edge target state 缺失时 fail-closed，不返回孤儿 marker", () => {
    const { store, repository } = makeStore();
    const saved = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 0,
      predecessorStateId: null,
      compactInputDigest: "orphan-target-input",
      accountCandidates: [CANARIES.account],
    });
    // 绕过产品删除 helper，模拟旧版本遗留/手工破坏造成的历史孤儿 edge。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const stateId = saved.marker.match(/codex-opaque-state:v1:([A-Za-z0-9_-]{32}):/)![1]!;
    db.prepare("DELETE FROM opaque_states WHERE lookup_digest = ?").run(repository.lookupFor(stateId));
    db.close();

    expectReason(() => store.findSuccessorMarker({
      predecessorMarker: null,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      compactInputDigest: "orphan-target-input",
      variantHash: CANARIES.variant,
      accountCandidates: [CANARIES.account],
    }), "state_corrupt");
  });

  it("edge 查询继续执行 session/model/account 与 target 完整认证门禁", () => {
    const { store } = makeStore();
    const saved = store.save({
      output: OUTPUT,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      expectedGeneration: 0,
      predecessorStateId: null,
      compactInputDigest: "gated-root-input",
      accountCandidates: [CANARIES.account],
    });
    const query = {
      predecessorMarker: null,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      compactInputDigest: "gated-root-input",
      variantHash: CANARIES.variant,
      accountCandidates: [CANARIES.account],
    } as const;

    expect(store.findSuccessorMarker(query)).toBe(saved.marker);
    expect(store.findSuccessorMarker({ ...query, sessionId: "other-session" })).toBeNull();
    expect(store.findSuccessorMarker({ ...query, model: "gpt-5.5" })).toBeNull();
    expect(store.findSuccessorMarker({ ...query, accountCandidates: ["entry-other"] })).toBeNull();
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
    // detail（排查生产事故新补的字段）也必须带上真实的锁冲突异常文本，
    // 不锁死逐字节措辞，只断言确实有内容。
    expect(getOpaqueCompactStateReadiness()).toEqual({
      ready: false,
      reason: "store_locked",
      detail: expect.stringContaining("another instance holds the opaque compact store"),
    });
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
    // 真实隔离后原库已移出正常路径；证据在隔离快照里逐字节保留。
    expect(existsSync(resolve(dir, "state.db"))).toBe(false);
    const snapshot = resolve(dir, "quarantine", readdirSync(resolve(dir, "quarantine"))[0]!);
    const check = new DatabaseSync(resolve(snapshot, "state.db"));
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
      compactInputDigest: DIGESTS.successor,
      accountCandidates: [CANARIES.account],
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

    // 同上：证据随整库一起进入隔离快照，而不是留在原路径。
    expect(existsSync(resolve(dir, "state.db"))).toBe(false);
    const snapshot = resolve(dir, "quarantine", readdirSync(resolve(dir, "quarantine"))[0]!);
    const check = new DatabaseSync(resolve(snapshot, "state.db"));
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
      () => findCanarySuccessor(reopened.store, first),
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
      compactInputDigest: DIGESTS.successor,
      accountCandidates: [CANARIES.account],
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

describe("8.4 可变元数据 expires_at — 与 last_used_at 同等待遇，必须认证", () => {
  it("篡改 expires_at 后冷启动判为不可读，证据不删除（对齐 last_used_mac 的既有用例）", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    // 8.4 sliding TTL 之后，expires_at 也从 AAD 移到独立 MAC 保护
    // （expires_at_mac 列）——与 last_used_at 同一条 recover() 校验链，
    // 篡改任一个都必须让整行判为不可读，而不是被静默接受成"到期时间被
    // 悄悄改早/改晚"。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET expires_at = expires_at + 1").run();
    db.close();

    const reopened = makeStore();
    const recovered = reopened.repository.recover();
    expect(recovered.unreadable).toBe(1);
    expect(recovered.retained).toBe(0);
    // 不可读时不清理：证据必须原样留在库里供后续隔离/取证，不能被
    // recover() 自己的过期清理顺手删掉。
    expect(reopened.repository.stats().count).toBe(1);
  });

  it("篡改 expires_at_mac 本身（而不是 expires_at）同样判为不可读", () => {
    const { store, repository } = makeStore();
    saveCanaryState(store);
    repository.close();

    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET expires_at_mac = 'deadbeef'").run();
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

describe("密钥裁剪必须持久化", () => {
  it("过退役窗口的 previous key 要真的从磁盘删除，而不只是内存过滤", () => {
    freshKeyring();
    const rotated = rotateOpaqueCompactKeyring(keyringFile());

    // 把旧 key 的退役时间推到很久以前，使其超出保留窗口。
    const stored = JSON.parse(readFileSync(keyringFile(), "utf-8")) as {
      keys: { id: string; createdAt: number; retiredAt: number | null }[];
    };
    const old = stored.keys.find((k) => k.id === rotated.previousKeyId)!;
    old.createdAt = 1;
    old.retiredAt = 2;
    writeFileSync(keyringFile(), JSON.stringify(stored), { mode: 0o600 });

    const keyring = loadOpaqueCompactKeyring({
      keyringFile: keyringFile(),
      allowCreate: false,
      stateTtlMs: TTL_MS,
    });
    expect(keyring.get(rotated.previousKeyId)).toBeUndefined();

    // 关键：磁盘上也必须真的没有了。只在内存里过滤的话，旧密钥材料会一直
    // 留在文件里，"轮换后最终销毁"这条承诺在持久层面从未兑现。
    const onDisk = JSON.parse(readFileSync(keyringFile(), "utf-8")) as {
      keys: { id: string }[];
    };
    expect(onDisk.keys.map((k) => k.id)).not.toContain(rotated.previousKeyId);
  });
});

describe("successor 映射语义", () => {
  it("AEAD 合法但内容不是 marker 时拒绝返回", () => {
    const { store, repository } = makeStore();
    const first = saveCanaryState(store);
    const resolved = resolveCanary(store, first.marker);

    // 直接用仓库 API 写入一条 AEAD 完全合法、但内容不是 marker 的映射。
    // 缺少语义校验时，这段字符串会被原样当作 marker 交给客户端。
    repository.saveWithCas({
      stateId: "forged-state-id",
      binding: repository.bindingFor(CANARIES.session, "gpt-5.4", CANARIES.variant),
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      accountCandidates: [CANARIES.account],
      expectedGeneration: resolved.generation,
      plaintext: Buffer.from("{}", "utf-8"),
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
      predecessorStateId: resolved.stateId,
      successorMarker: "AEAD-valid-but-not-a-marker",
      compactInputDigest: DIGESTS.forged,
    });

    expect(() => findCanarySuccessor(store, first.marker, {
      compactInputDigest: DIGESTS.forged,
    })).toThrowError(OpaqueCompactStateError);
  });
});

describe("successor 冷启动语义校验", () => {
  it("state 完全合法、仅 successor 不是 marker 时，冷启动必须 quarantine", () => {
    // 关键：state 行本身结构完全合法，唯一的问题在 successor 映射。
    // 这样才能区分 quarantine 来自 payload 校验还是 successor 校验——
    // 若 validator 在 recover 之后安装，冷启动只过 AEAD，这条会照常 ready。
    const first = startOpaqueCompactRuntime(runtimeConfig());
    const store = getOpaqueCompactStateStore();
    const saved = saveCanaryState(store);
    const resolved = resolveCanary(store, saved.marker);
    first.close();

    const { repository } = makeStore();
    const now = Date.now();
    const payload = JSON.stringify({
      version: 2,
      output: OUTPUT,
      preservedTail: PRESERVED_TAIL,
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      variantHash: CANARIES.variant,
      compHash: createHash("sha256")
        .update(JSON.stringify({ output: OUTPUT, preservedTail: PRESERVED_TAIL }))
        .digest("base64url"),
      createdAt: now,
      expiresAt: now + TTL_MS,
    });
    repository.saveWithCas({
      stateId: "legit-looking-state",
      binding: repository.bindingFor(CANARIES.session, "gpt-5.4", CANARIES.variant),
      sessionId: CANARIES.session,
      model: "gpt-5.4",
      accountEntryId: CANARIES.account,
      accountCandidates: [CANARIES.account],
      expectedGeneration: resolved.generation,
      plaintext: Buffer.from(payload, "utf-8"),
      createdAt: now,
      expiresAt: now + TTL_MS,
      predecessorStateId: resolved.stateId,
      successorMarker: "AEAD-valid-but-not-a-marker",
      compactInputDigest: DIGESTS.forged,
    });
    repository.close();

    const second = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(second);
    expect(second.ready).toBe(false);
    expect(second.reason).toBe("state_corrupt");
  });
});

describe("真实 quarantine — 证据保全且原路径不可复用", () => {
  it("损坏后把原库移入隔离目录，字节保真并留下清单", () => {
    const first = startOpaqueCompactRuntime(runtimeConfig());
    saveCanaryState(getOpaqueCompactStateStore());
    first.close();

    const databasePath = resolve(dir, "state.db");
    const sizeBefore = statSync(databasePath).size;

    const db = new DatabaseSync(databasePath);
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

    // 只打日志 + not-ready 不算隔离：原库必须离开正常路径，
    // 否则下次启动照样撞上它，且没有任何取证快照。
    expect(existsSync(databasePath)).toBe(false);

    const quarantineDir = resolve(dir, "quarantine");
    expect(existsSync(quarantineDir)).toBe(true);
    const snapshots = readdirSync(quarantineDir);
    expect(snapshots).toHaveLength(1);

    const snapshot = resolve(quarantineDir, snapshots[0]!);
    const preserved = resolve(snapshot, "state.db");
    // 证据必须字节保真——rename 不读写内容，因此大小完全一致。
    expect(existsSync(preserved)).toBe(true);
    expect(statSync(preserved).size).toBe(sizeBefore);
    // 清单供运维取证，只含结构信息。
    const manifest = JSON.parse(
      readFileSync(resolve(snapshot, "QUARANTINE.json"), "utf-8"),
    ) as { reason: string; files: { name: string; bytes: number }[] };
    expect(manifest.reason).toBe("recover_unreadable");
    expect(manifest.files.some((f) => f.name === "state.db")).toBe(true);
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

  it("不同 Codex 窗口 / 不同工具集仍然互相隔离", () => {
    const base = {
      model: "gpt-5.4",
      instructions: "main thread",
      tools: [{ type: "function", name: "Read" }],
      input: [],
    } as unknown as Parameters<typeof opaqueCompactVariantHash>[0];

    const otherWindow = { ...base, codexWindowId: "window-2" } as typeof base;
    // tools 是团队裁决后仍然参与哈希的隔离维度（instructions 已经去掉，见下一条）。
    const differentTools = {
      ...base,
      tools: [{ type: "function", name: "WebFetch" }],
    } as typeof base;

    // 需要隔离的并行维度必须仍然产生不同 hash。
    expect(opaqueCompactVariantHash(otherWindow)).not.toBe(opaqueCompactVariantHash(base));
    expect(opaqueCompactVariantHash(differentTools)).not.toBe(opaqueCompactVariantHash(base));
  });

  it("仅 system prompt（instructions）不同不再产生隔离——团队裁决，instructions 已从 variant hash 里去掉", () => {
    // 团队三条证据链裁决（详见 opaqueCompactVariantHash 的文档注释）：compact
    // 的全部意义就是把历史换成一段摘要，instructions 在 compact 前后必然
    // 变化，把它留在跨 compact 边界的绑定里，等于让任何一次真实 compact
    // 后的第一句话都必然撞上 variant_mismatch——这正是本轮要修的事故本身。
    // 这条用例专门守住"只改 instructions、其余全同"这个最小场景，防止有人
    // 日后按直觉把 instructions 加回 opaqueCompactVariantHash 的调用参数
    // 里、重新踩上同一个坑而没有任何测试变红提醒。
    const base = {
      model: "gpt-5.4",
      instructions: "main thread system prompt, 22344 字符量级",
      tools: [{ type: "function", name: "Read" }],
      input: [],
    } as unknown as Parameters<typeof opaqueCompactVariantHash>[0];
    const rewrittenInstructions = {
      ...base,
      instructions: "compact 之后被翻译层重写过的 system prompt, 16472 字符量级",
    } as typeof base;

    expect(opaqueCompactVariantHash(rewrittenInstructions)).toBe(opaqueCompactVariantHash(base));
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

// ── Task #45：旧 store 原子迁移 ────────────────────────────────
//
// 设计意图：升级要保住旧 marker 仍能取回的 state，同时**绝不**把旧的
// predecessor→successor 单键映射伪造成新的内容寻址 edge。因此 state 行按旧
// AAD 解封 / 新 AAD 重封逐字保留，edge 表整体丢弃重建；整个过程一个事务，
// 失败即回滚成完整旧格式并给出自己的结构化原因。

/** 直接读盘断言 schema 形状，不经过任何实现代码。 */
function inspectSchema(): {
  version: string | undefined;
  stateColumns: string[];
  successorColumns: string[];
  stateCount: number;
  successorCount: number;
} {
  const db = new DatabaseSync(resolve(dir, "state.db"));
  try {
    return {
      version: (db.prepare("SELECT value FROM opaque_meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined)?.value,
      stateColumns: (db.prepare("PRAGMA table_info(opaque_states)").all() as { name: string }[])
        .map((column) => column.name),
      successorColumns: (db.prepare("PRAGMA table_info(opaque_successors)").all() as
        { name: string }[]).map((column) => column.name),
      stateCount: (db.prepare("SELECT COUNT(*) AS n FROM opaque_states").get() as { n: number }).n,
      successorCount: (db.prepare("SELECT COUNT(*) AS n FROM opaque_successors").get() as
        { n: number }).n,
    };
  } finally {
    db.close();
  }
}

function seedLegacy(schemaVersion: 2 | 3 | 4, includeLastUsedMac?: boolean, extraRecords?: number) {
  return seedLegacyOpaqueStore({
    dir,
    keyringFile: keyringFile(),
    schemaVersion,
    ...(includeLastUsedMac === undefined ? {} : { includeLastUsedMac }),
    ...(extraRecords === undefined ? {} : { extraRecords }),
  });
}

describe("schema 迁移 — v2/v3 原子升级到 v4", () => {
  it("v3→v4：旧 marker 仍可 resolve，旧 edge 全部丢弃且不产生通配边", () => {
    const seeded = seedLegacy(3);
    expect(inspectSchema().version).toBe("3");

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(true);

    const store = getOpaqueCompactStateStore();
    const restored = store.resolve({
      marker: seeded.marker,
      sessionId: seeded.sessionId,
      model: seeded.model,
      variantHash: seeded.variantHash,
      accountCandidates: [seeded.accountEntryId],
    });
    // stateId / binding / generation / payload / compHash 都必须逐字延续。
    expect(restored.output).toEqual(seeded.output);
    expect(restored.preservedTail).toEqual(seeded.preservedTail);
    expect(restored.stateId).toBe(seeded.stateId);
    expect(restored.generation).toBe(1);
    expect(restored.accountEntryId).toBe(seeded.accountEntryId);

    const schema = inspectSchema();
    expect(schema.version).toBe(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
    expect(schema.stateCount).toBe(1);
    // 旧 edge 没有 compactInputDigest 分量，无法无损升级 —— 只能整表丢弃。
    expect(schema.successorColumns).toContain("edge_lookup");
    expect(schema.successorCount).toBe(0);

    // 决定性断言：旧 predecessor 上不存在任何"通配"边。任意 digest 都必须查不到，
    // 否则升级后第一次重试就会拿到一个语义上不属于它的 marker。
    for (const digest of ["digest-a", "digest-b", DIGESTS.successor]) {
      expect(store.findSuccessorMarker({
        predecessorMarker: seeded.marker,
        sessionId: seeded.sessionId,
        model: seeded.model,
        compactInputDigest: digest,
        variantHash: seeded.variantHash,
        accountCandidates: [seeded.accountEntryId],
      })).toBeNull();
    }
  });

  it("8.4：v4→v5 正确迁移并回填真实 expires_at_mac，迁移后旧记录仍能正常 resolve", () => {
    const seeded = seedLegacy(4);
    expect(inspectSchema().version).toBe("4");
    // 前提核实：v4 库和所有历史版本一样，压根没有 expires_at_mac 这一列——
    // 这是 8.4 全新引入的列，不存在"列在但为空"的中间态。
    expect(inspectSchema().stateColumns).not.toContain("expires_at_mac");

    // 用严格单调递增的假时钟：下面要连续两次 resolve 验证 sliding TTL 确实
    // 顺延了，真实 Date.now() 在快机器上可能落在同一毫秒，导致 expires_at
    // 恰好相等而不是更大——那不是顺延没生效，只是时钟分辨率不够，会把这条
    // 决定性断言变成偶发 flaky。假时钟让"顺延"这个结论不依赖系统时钟粒度。
    let clock = Date.now();
    const handle = startOpaqueCompactRuntime(runtimeConfig({ now: () => ++clock }));
    openHandles.push(handle);
    expect(handle.ready).toBe(true);

    const store = getOpaqueCompactStateStore();
    const restored = store.resolve({
      marker: seeded.marker,
      sessionId: seeded.sessionId,
      model: seeded.model,
      variantHash: seeded.variantHash,
      accountCandidates: [seeded.accountEntryId],
    });
    expect(restored.output).toEqual(seeded.output);
    expect(restored.preservedTail).toEqual(seeded.preservedTail);
    expect(restored.stateId).toBe(seeded.stateId);

    const schema = inspectSchema();
    expect(schema.version).toBe(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
    expect(schema.stateColumns).toContain("expires_at_mac");
    expect(schema.stateCount).toBe(1);

    // 决定性断言：expires_at_mac 不是 DEFAULT '' 放行，而是用真实 MAC 回填——
    // 直接读裸行验证它能通过 computeMutableMetaMac 的独立校验（这正是
    // repository.load()/recover() 后续会做的同一个校验）。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare(
      "SELECT lookup_digest, expires_at, expires_at_mac FROM opaque_states WHERE lookup_digest = ?",
    ).get(seeded.lookupDigest) as { lookup_digest: string; expires_at: number; expires_at_mac: string };
    db.close();
    expect(row.expires_at_mac).not.toBe("");
    // seeded.keyring 与 runtime 内部加载的是同一份密钥环文件、期间未轮换，
    // 材料逐字相同，可以直接拿来算期望 MAC 对照。
    expect(row.expires_at_mac).toBe(
      computeMutableMetaMac(seeded.keyring, row.lookup_digest, "expires_at", row.expires_at),
    );

    // 迁移后再 resolve 一次（本次触发 8.4 sliding TTL）：expires_at 必须真的
    // 顺延了，且新值同样受 expires_at_mac 保护——证明迁移回填的不是一个
    // "只为了通过一次校验"的死值，而是能持续参与后续顺延链路的真实 MAC。
    const restoredAgain = store.resolve({
      marker: seeded.marker,
      sessionId: seeded.sessionId,
      model: seeded.model,
      variantHash: seeded.variantHash,
      accountCandidates: [seeded.accountEntryId],
    });
    void restoredAgain;
    const dbAfter = new DatabaseSync(resolve(dir, "state.db"));
    const rowAfter = dbAfter.prepare(
      "SELECT expires_at, expires_at_mac FROM opaque_states WHERE lookup_digest = ?",
    ).get(seeded.lookupDigest) as { expires_at: number; expires_at_mac: string };
    dbAfter.close();
    expect(rowAfter.expires_at).toBeGreaterThan(row.expires_at);
    expect(rowAfter.expires_at_mac).toBe(
      computeMutableMetaMac(seeded.keyring, seeded.lookupDigest, "expires_at", rowAfter.expires_at),
    );
  });

  it("v2→v4：补齐并回填 last_used_mac，而不是 DEFAULT '' 放行", () => {
    const seeded = seedLegacy(2, false);
    // 前提核实：最初的 v2 库整列缺失，不是"有列但为空"。
    expect(inspectSchema().stateColumns).not.toContain("last_used_mac");

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(true);

    const restored = getOpaqueCompactStateStore().resolve({
      marker: seeded.marker,
      sessionId: seeded.sessionId,
      model: seeded.model,
      variantHash: seeded.variantHash,
      accountCandidates: [seeded.accountEntryId],
    });
    expect(restored.output).toEqual(seeded.output);
    expect(restored.stateId).toBe(seeded.stateId);

    // 回填的必须是**真实 MAC**：空串会让 LRU 排序依据永远处于未认证状态。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const row = db.prepare(
      "SELECT lookup_digest, last_used_at, last_used_mac FROM opaque_states LIMIT 1",
    ).get() as { lookup_digest: string; last_used_at: number; last_used_mac: string };
    db.close();
    expect(row.last_used_mac).not.toBe("");
    expect(row.last_used_mac).toBe(
      computeMutableMetaMac(seeded.keyring, row.lookup_digest, "last_used_at", row.last_used_at),
    );
  });

  it("重封之后冷启动全扫 unreadable=0（新 AAD 与新版本严格一致）", () => {
    const seeded = seedLegacy(3);
    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(true);
    handle.close();

    // 用一个全新 repository 重扫：迁移写下的密文必须能被当前版本 AAD 完整认证。
    const reopened = makeStore();
    const recovered = reopened.repository.recover();
    expect(recovered.unreadable).toBe(0);
    expect(recovered.retained).toBe(1);
    void seeded;
  });

  it("迁移中途失败：整体 ROLLBACK，旧库仍是完整旧 schema，且可再次迁移", () => {
    const seeded = seedLegacy(3);

    // 注入失败：破坏密文让旧 AAD 解封失败。迁移必须整体回滚，而不是丢掉这一行
    // 继续写新格式——那等于用一次升级悄悄吞掉用户的 state。
    const db = new DatabaseSync(resolve(dir, "state.db"));
    const original = Buffer.from(
      (db.prepare("SELECT ciphertext FROM opaque_states LIMIT 1").get() as
        { ciphertext: Uint8Array }).ciphertext,
    );
    const corrupted = Buffer.from(original);
    corrupted[0] = corrupted[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(corrupted, seeded.lookupDigest);
    db.close();

    const failed = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(failed);
    expect(failed.ready).toBe(false);
    // 迁移失败必须自成一类：旧库完好，正确动作是排查后重试升级，
    // 报成 state_corrupt 会误导运维去隔离/重建。
    expect(failed.reason).toBe("migration_failed");

    // 旧库原地未动：版本号、列形状、行数全部保持 v3。
    const schema = inspectSchema();
    expect(schema.version).toBe("3");
    expect(schema.successorColumns).not.toContain("edge_lookup");
    expect(schema.stateCount).toBe(1);
    expect(schema.successorCount).toBe(1);
    // 迁移失败不是数据损坏，绝不能顺手隔离掉一份仍然可用的库。
    expect(existsSync(resolve(dir, "quarantine"))).toBe(false);
    expect(existsSync(resolve(dir, "QUARANTINED.json"))).toBe(false);
    failed.close();

    // 修好注入的损坏后，同一份库必须还能正常迁移 —— 证明上一次真的只是回滚。
    const repaired = new DatabaseSync(resolve(dir, "state.db"));
    repaired.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(original, seeded.lookupDigest);
    repaired.close();

    const retried = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(retried);
    expect(retried.ready).toBe(true);
    expect(inspectSchema().version).toBe(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
    expect(getOpaqueCompactStateStore().resolve({
      marker: seeded.marker,
      sessionId: seeded.sessionId,
      model: seeded.model,
      variantHash: seeded.variantHash,
      accountCandidates: [seeded.accountEntryId],
    }).output).toEqual(seeded.output);
  });

  it("多条记录迁移：其中一条损坏时整体 ROLLBACK，健康的那几条不会提前落盘（reviewer major）", () => {
    // migrateSchema() 是 rows.map(row => resealRecordForMigration(...))——单条
    // 记录的测试结构上无法验证"多条记录中某一条 reseal 失败时，已经处理成功
    // 的其他行是否真的一并回滚，而不是部分落盘"。这条种 3 条记录（1 主 + 2
    // extra），只损坏中间那条，断言另外两条健康记录在失败的迁移尝试里
    // 一字节都没被动过——而不仅仅是"版本号/行数看起来没变"这种表面断言。
    const seeded = seedLegacy(3, undefined, 2);
    expect(seeded.records).toHaveLength(3);
    const [healthyA, corrupted, healthyB] = seeded.records;

    const db = new DatabaseSync(resolve(dir, "state.db"));
    const snapshotBefore = new Map<string, { nonce: Buffer; tag: Buffer; ciphertext: Buffer }>();
    for (const record of [healthyA!, healthyB!]) {
      const row = db.prepare(
        "SELECT nonce, tag, ciphertext FROM opaque_states WHERE lookup_digest = ?",
      ).get(record.lookupDigest) as { nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array };
      snapshotBefore.set(record.lookupDigest, {
        nonce: Buffer.from(row.nonce),
        tag: Buffer.from(row.tag),
        ciphertext: Buffer.from(row.ciphertext),
      });
    }
    // 只破坏中间那条（corrupted）的密文，两侧的记录保持完全健康。
    const original = Buffer.from(
      (db.prepare("SELECT ciphertext FROM opaque_states WHERE lookup_digest = ?")
        .get(corrupted!.lookupDigest) as { ciphertext: Uint8Array }).ciphertext,
    );
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0]! ^ 0xff;
    db.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(tampered, corrupted!.lookupDigest);
    db.close();

    const failed = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(failed);
    expect(failed.ready).toBe(false);
    expect(failed.reason).toBe("migration_failed");

    const schema = inspectSchema();
    // 表面断言：版本号/行数确实没变。
    expect(schema.version).toBe("3");
    expect(schema.stateCount).toBe(3);

    // 决定性断言：两条健康记录的 nonce/tag/ciphertext 逐字节与迁移尝试之前
    // 完全相同——不是"看起来还是 v3"，而是"物理上一字节都没被 reseal 写过"。
    // 如果 map() 在遇到损坏行之前已经把前面几条 reseal 成新格式、只是外层
    // catch 没有回滚已提交的部分（例如没有包在同一个事务里），这里就会失败：
    // 健康记录的密文会变成新 AAD 下的新密文，即使 schema_version 列因为某种
    // 原因没更新，也已经不是"整体 ROLLBACK"了。
    const dbAfter = new DatabaseSync(resolve(dir, "state.db"));
    for (const record of [healthyA!, healthyB!]) {
      const row = dbAfter.prepare(
        "SELECT nonce, tag, ciphertext FROM opaque_states WHERE lookup_digest = ?",
      ).get(record.lookupDigest) as { nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array };
      const before = snapshotBefore.get(record.lookupDigest)!;
      expect(Buffer.from(row.nonce).equals(before.nonce)).toBe(true);
      expect(Buffer.from(row.tag).equals(before.tag)).toBe(true);
      expect(Buffer.from(row.ciphertext).equals(before.ciphertext)).toBe(true);
    }
    dbAfter.close();
    failed.close();

    // 修好损坏的那一条，同一份库必须能整体迁移成功——且全部 3 条（包括此前
    // "健康但从未真正迁移过"的两条）都能正常 resolve，证明回滚是干净的、
    // 没有把任何一条记录留在中间状态。
    const repaired = new DatabaseSync(resolve(dir, "state.db"));
    repaired.prepare("UPDATE opaque_states SET ciphertext = ? WHERE lookup_digest = ?")
      .run(original, corrupted!.lookupDigest);
    repaired.close();

    const retried = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(retried);
    expect(retried.ready).toBe(true);
    expect(inspectSchema().version).toBe(String(OPAQUE_REPOSITORY_SCHEMA_VERSION));
    expect(inspectSchema().stateCount).toBe(3);
    for (const record of seeded.records) {
      expect(getOpaqueCompactStateStore().resolve({
        marker: record.marker,
        sessionId: record.sessionId,
        model: record.model,
        variantHash: record.variantHash,
        accountCandidates: [record.accountEntryId],
      }).output).toEqual(record.output);
    }
  });

  it("篡改过的 last_used_mac 不会被迁移洗白", () => {
    const seeded = seedLegacy(3);
    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_states SET last_used_at = ? WHERE lookup_digest = ?")
      .run(1, seeded.lookupDigest);
    db.close();

    // 迁移是唯一一次全库重写的机会：在这里放行未认证的行，等于用新密文
    // 给旧的篡改盖章，之后所有 recover 都会认为它合法。
    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("migration_failed");
    expect(inspectSchema().version).toBe("3");
  });

  it("太旧（v1）的 schema 仍然 schema_unsupported，不猜列布局", () => {
    seedLegacy(3);
    const db = new DatabaseSync(resolve(dir, "state.db"));
    db.prepare("UPDATE opaque_meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("schema_unsupported");
    expect(inspectSchema().version).toBe("1");
  });
});

// ── Task #45：持久 quarantine active marker ────────────────────

describe("quarantine active marker — 隔离必须跨重启稳定", () => {
  /** 制造一次真实隔离，返回第一次的 handle 结果。 */
  function quarantineOnce(): { reason: string | null } {
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
    return { reason: second.reason };
  }

  it("隔离后连续重启：reason 逐字稳定、快照恒为 1、正常库不重建", () => {
    const { reason } = quarantineOnce();
    expect(reason).toBe("state_corrupt");

    const markerPath = resolve(dir, "QUARANTINED.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as {
      version: number;
      storeId: string;
      reason: string;
      quarantinedAt: string;
      snapshot: string;
      files: string[];
    };
    expect(marker.reason).toBe("recover_unreadable");
    expect(marker.files).toContain("state.db");
    // storeId 必须与 sentinel 一致，后续启动才能判断"这枚标记属于我这份 store"。
    expect(marker.storeId).toBe(
      loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: false })!.storeId,
    );

    for (let restart = 0; restart < 3; restart += 1) {
      const handle = startOpaqueCompactRuntime(runtimeConfig());
      openHandles.push(handle);
      // 光"打日志 + not-ready"扛不住重启：没有 active marker 时下一次启动
      // 会照常建库，隔离等于白做。
      expect(handle.ready, `restart ${restart}`).toBe(false);
      expect(handle.reason, `restart ${restart}`).toBe("state_corrupt");
      // 正常路径上不得重新出现库，也不得再产生第二份快照。
      expect(existsSync(resolve(dir, "state.db")), `restart ${restart}`).toBe(false);
      expect(readdirSync(resolve(dir, "quarantine"))).toHaveLength(1);
      // 首次隔离时间不得被后续重启改写。
      expect(JSON.parse(readFileSync(markerPath, "utf-8")).quarantinedAt)
        .toBe(marker.quarantinedAt);
      handle.close();
    }
  });

  it("active marker 损坏时 fail-closed，绝不忽略后继续建库", () => {
    quarantineOnce();
    writeFileSync(resolve(dir, "QUARANTINED.json"), "{ not json");

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(false);
    expect(handle.reason).toBe("state_corrupt");
    expect(existsSync(resolve(dir, "state.db"))).toBe(false);
  });

  it("marker 在而 sentinel 缺失时 fail-closed，不得凭空铸一个新身份", () => {
    quarantineOnce();
    // 这是隔离机制最危险的一条后门：新建的 sentinel 会拿到随机 storeId，
    // 它与 marker 里的 storeId 永远不可能相等，于是身份比对必然放行，
    // "删掉 sentinel"就等于一键绕过隔离并重建空库。
    rmSync(resolve(dir, "store.sentinel"));

    for (let restart = 0; restart < 3; restart += 1) {
      const handle = startOpaqueCompactRuntime(runtimeConfig());
      openHandles.push(handle);
      expect(handle.ready, `restart ${restart}`).toBe(false);
      expect(handle.reason, `restart ${restart}`).toBe("state_corrupt");
      // 既不能建库，也不能顺手把 sentinel 补回来——身份必须由运维显式重建。
      expect(existsSync(resolve(dir, "state.db")), `restart ${restart}`).toBe(false);
      expect(existsSync(resolve(dir, "store.sentinel")), `restart ${restart}`).toBe(false);
      expect(readdirSync(resolve(dir, "quarantine"))).toHaveLength(1);
      handle.close();
    }
  });

  it("marker 的 storeId 不匹配时不连坐另一份重建好的 store", () => {
    quarantineOnce();
    // 运维显式重建 store 身份：sentinel 真实存在且换了 storeId。
    // 这与"sentinel 不见了"是两回事——上一份 store 的隔离标记不该连坐它。
    rmSync(resolve(dir, "store.sentinel"));
    const rebuilt = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), {
      allowCreate: true,
    })!;
    expect(rebuilt.created).toBe(true);

    const handle = startOpaqueCompactRuntime(runtimeConfig());
    openHandles.push(handle);
    expect(handle.ready).toBe(true);
    expect(existsSync(resolve(dir, "state.db"))).toBe(true);
    // 旧隔离证据与标记都必须原样保留，不因新 store 上线被清掉。
    expect(existsSync(resolve(dir, "QUARANTINED.json"))).toBe(true);
    expect(readdirSync(resolve(dir, "quarantine"))).toHaveLength(1);

    // 新 store 正常可用。
    const saved = saveCanaryState(getOpaqueCompactStateStore());
    expect(resolveCanary(getOpaqueCompactStateStore(), saved.marker).output).toEqual(OUTPUT);
  });
});
