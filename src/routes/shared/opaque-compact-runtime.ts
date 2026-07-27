/**
 * Opaque compact state 持久化的启动/关闭生命周期。
 *
 * 设计意图：把"要不要碰磁盘"这个决定收敛到一处。功能默认关闭，关闭时这里
 * 一行 IO 都不做——不建 DB、不读密钥、不抢锁。开启时按固定顺序做四件事，
 * 任何一步失败都让功能进入 not-ready 并记录**结构化原因**，由 messages 路由
 * 转成精确的 409，而不是退化成"当作没有 marker"继续跑。
 *
 * 顺序很重要：先抢独占锁，再决定能否创建密钥环。反过来的话，第二实例会在
 * 抢锁失败之前就把密钥环创建出来。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir } from "../../paths.js";
import {
  loadOpaqueCompactKeyring,
  OpaqueCompactKeyringError,
} from "./opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
  OpaqueCompactRepositoryError,
} from "./opaque-compact-repository.js";
import {
  acquireOpaqueCompactStoreLock,
  OpaqueCompactStoreLockError,
  type OpaqueCompactStoreLockHandle,
} from "./opaque-compact-store-lock.js";
import {
  OpaqueCompactStateStore,
  setOpaqueCompactStateStore,
  setOpaqueCompactStateUnavailable,
  type OpaqueCompactStateFailure,
} from "./opaque-compact-state.js";

const DEFAULT_DIR_NAME = "opaque-compact";
const DB_FILE = "state.db";
const KEYRING_FILE = "keyring.json";
const LOCK_FILE = "store.lock";

export interface OpaqueCompactRuntimeConfig {
  enabled: boolean;
  ttlMinutes: number;
  capacity: number;
  maxBytes: number;
  /** 覆盖数据目录，主要用于测试。 */
  directory?: string;
  now?: () => number;
}

export interface OpaqueCompactRuntimeHandle {
  ready: boolean;
  reason: OpaqueCompactStateFailure | null;
  close(): void;
}

const INERT: OpaqueCompactRuntimeHandle = {
  ready: false,
  reason: null,
  close: () => {},
};

function resolveDirectory(config: OpaqueCompactRuntimeConfig): string {
  return config.directory ?? resolve(getDataDir(), DEFAULT_DIR_NAME);
}

function classify(error: unknown): OpaqueCompactStateFailure {
  if (error instanceof OpaqueCompactStoreLockError) {
    return error.reason === "store_locked" ? "store_locked" : "store_unavailable";
  }
  if (error instanceof OpaqueCompactKeyringError) {
    return error.reason === "key_unavailable" ? "key_unavailable" : "key_mismatch";
  }
  if (error instanceof OpaqueCompactRepositoryError) {
    if (error.reason === "schema_unsupported") return "schema_unsupported";
    if (error.reason === "key_mismatch") return "key_mismatch";
    if (error.reason === "state_corrupt") return "state_corrupt";
    return "store_unavailable";
  }
  return "store_unavailable";
}

/**
 * 启动 opaque state 持久化。
 * `enabled=false` 时直接返回 inert handle，不产生任何文件系统副作用。
 */
export function startOpaqueCompactRuntime(
  config: OpaqueCompactRuntimeConfig,
): OpaqueCompactRuntimeHandle {
  if (!config.enabled) {
    setOpaqueCompactStateStore(null);
    return INERT;
  }

  const dir = resolveDirectory(config);
  const databasePath = resolve(dir, DB_FILE);
  const keyringFile = resolve(dir, KEYRING_FILE);
  const lockPath = resolve(dir, LOCK_FILE);

  let lock: OpaqueCompactStoreLockHandle | null = null;
  let repository: OpaqueCompactRepository | null = null;
  try {
    lock = acquireOpaqueCompactStoreLock(lockPath, { now: config.now });

    // 已有 DB 却没有密钥环 → 绝不生成新密钥（会把既有密文变成永久垃圾）。
    const databaseExists = existsSync(databasePath);
    const keyring = loadOpaqueCompactKeyring({
      keyringFile,
      allowCreate: !databaseExists,
      now: config.now,
      // previous key 至少覆盖最长 TTL，轮换当天签发的 marker 才不会被打回。
      previousKeyRetentionMs: Math.max(config.ttlMinutes, 1) * 60_000 * 2,
    });

    repository = new OpaqueCompactRepository({
      databasePath,
      keyring,
      capacity: config.capacity,
      maxBytes: config.maxBytes,
      ...(config.now ? { now: config.now } : {}),
    });
    const recovered = repository.recover();

    setOpaqueCompactStateStore(
      new OpaqueCompactStateStore({
        capacity: config.capacity,
        maxBytes: config.maxBytes,
        ttlMs: config.ttlMinutes * 60_000,
        keyring,
        repository,
        ...(config.now ? { now: config.now } : {}),
      }),
    );

    // 只记录结构量，不记录 stateId / session / marker / 任何密文。
    console.log(
      `[ClaudeOpaqueCompact] phase=store_ready key=${keyring.activeKeyId}` +
        ` retained=${recovered.retained} expired=${recovered.expired} unreadable=${recovered.unreadable}`,
    );

    const handleLock = lock;
    const handleRepository = repository;
    return {
      ready: true,
      reason: null,
      close: () => {
        setOpaqueCompactStateStore(null);
        handleRepository.close();
        handleLock.release();
      },
    };
  } catch (error) {
    const reason = classify(error);
    repository?.close();
    lock?.release();
    setOpaqueCompactStateUnavailable(reason);
    console.warn(
      `[ClaudeOpaqueCompact] phase=store_unavailable reason=${reason}` +
        ` detail=${error instanceof Error ? error.name : "UnknownError"}`,
    );
    return { ready: false, reason, close: () => setOpaqueCompactStateUnavailable(reason) };
  }
}
