/**
 * Opaque compact state 持久化的启动/关闭/重配置生命周期。
 *
 * 设计意图：把"要不要碰磁盘"这个决定收敛到一处。功能默认关闭，关闭时这里
 * 一行 IO 都不做——不建 DB、不读密钥、不抢锁。开启时按固定顺序做几件事，
 * 任何一步失败都让功能进入 not-ready 并记录**结构化原因**，由路由转成精确的
 * 409，而不是退化成"当作没有 marker"继续跑。
 *
 * 顺序是有依据的：
 * 1. 先抢独占锁 —— 否则第二实例会在抢锁失败之前就把 keyring/sentinel 创建出来；
 * 2. 再读 sentinel 判定这是首次初始化还是既有 store；
 * 3. keyring 的 allowCreate 完全跟随 sentinel 判定，不看 DB 文件是否存在
 *    （DB 可能刚被清零，文件还在但内容没了）；
 * 4. 最后开库，由 storeId 交叉验证 DB 身份。
 */

import { resolve } from "node:path";
import { getDataDir } from "../../paths.js";
import {
  loadOpaqueCompactKeyring,
  OpaqueCompactKeyringError,
  KEY_RETENTION_SAFETY_MARGIN_MS,
} from "./opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
  OpaqueCompactRepositoryError,
} from "./opaque-compact-repository.js";
import {
  loadOpaqueCompactSentinel,
  OpaqueCompactSentinelError,
} from "./opaque-compact-sentinel.js";
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
const SENTINEL_FILE = "store.sentinel";

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

function resolveDirectory(config: OpaqueCompactRuntimeConfig): string {
  return config.directory ?? resolve(getDataDir(), DEFAULT_DIR_NAME);
}

function classify(error: unknown): OpaqueCompactStateFailure {
  if (error instanceof OpaqueCompactStoreLockError) {
    return error.reason === "store_locked" ? "store_locked" : "store_unavailable";
  }
  if (error instanceof OpaqueCompactKeyringError) {
    switch (error.reason) {
      case "key_unavailable":
        return "key_unavailable";
      case "key_policy_invalid":
        return "key_policy_invalid";
      default:
        return "key_mismatch";
    }
  }
  if (error instanceof OpaqueCompactSentinelError) {
    // sentinel 不可读/不可写等同于 store 身份无法证明 → 不得继续。
    return "store_reset_detected";
  }
  if (error instanceof OpaqueCompactRepositoryError) {
    switch (error.reason) {
      case "schema_unsupported":
        return "schema_unsupported";
      case "key_mismatch":
        return "key_mismatch";
      case "state_corrupt":
        return "state_corrupt";
      case "store_reset_detected":
        return "store_reset_detected";
      default:
        return "store_unavailable";
    }
  }
  return "store_unavailable";
}

/** 当前活跃的 runtime，用于配置热切换时先安全停掉旧实例。 */
let current: { handle: OpaqueCompactRuntimeHandle } | null = null;

/**
 * 启动 opaque state 持久化。
 * `enabled=false` 时直接返回 inert handle，不产生任何文件系统副作用。
 */
export function startOpaqueCompactRuntime(
  config: OpaqueCompactRuntimeConfig,
): OpaqueCompactRuntimeHandle {
  if (!config.enabled) {
    setOpaqueCompactStateStore(null);
    const inert: OpaqueCompactRuntimeHandle = { ready: false, reason: null, close: () => {} };
    current = { handle: inert };
    return inert;
  }

  const dir = resolveDirectory(config);
  const databasePath = resolve(dir, DB_FILE);
  const keyringFile = resolve(dir, KEYRING_FILE);
  const lockPath = resolve(dir, LOCK_FILE);
  const sentinelFile = resolve(dir, SENTINEL_FILE);
  const ttlMs = config.ttlMinutes * 60_000;

  let lock: OpaqueCompactStoreLockHandle | null = null;
  let repository: OpaqueCompactRepository | null = null;
  try {
    // 1) 先抢锁：第二实例必须在创建任何文件之前就被挡住。
    lock = acquireOpaqueCompactStoreLock(lockPath);

    // 2) sentinel 决定这是不是首次初始化。它独立于 DB 内容存在，
    //    因此"库被清零"无法伪装成 fresh init。
    const sentinel = loadOpaqueCompactSentinel(sentinelFile, {
      allowCreate: true,
      ...(config.now ? { now: config.now } : {}),
    })!;

    // 3) keyring 的创建许可完全跟随 sentinel：sentinel 是新建的才允许造密钥。
    const keyring = loadOpaqueCompactKeyring({
      keyringFile,
      allowCreate: sentinel.created,
      stateTtlMs: ttlMs,
      previousKeyRetentionMs: ttlMs + KEY_RETENTION_SAFETY_MARGIN_MS,
      ...(config.now ? { now: config.now } : {}),
    });

    // 4) 开库；storeId 交叉验证 DB 身份。
    repository = new OpaqueCompactRepository({
      databasePath,
      keyring,
      storeId: sentinel.storeId,
      sentinelCreated: sentinel.created,
      capacity: config.capacity,
      maxBytes: config.maxBytes,
      ...(config.now ? { now: config.now } : {}),
    });
    const recovered = repository.recover();

    setOpaqueCompactStateStore(
      new OpaqueCompactStateStore({
        capacity: config.capacity,
        maxBytes: config.maxBytes,
        ttlMs,
        keyring,
        repository,
        ...(config.now ? { now: config.now } : {}),
      }),
    );

    // 只记录结构量，不记录 stateId / session / account / marker / 任何密文。
    console.log(
      `[ClaudeOpaqueCompact] phase=store_ready key=${keyring.activeKeyId}` +
        ` retained=${recovered.retained} expired=${recovered.expired} unreadable=${recovered.unreadable}`,
    );

    const handleLock = lock;
    const handleRepository = repository;
    const handle: OpaqueCompactRuntimeHandle = {
      ready: true,
      reason: null,
      close: () => {
        setOpaqueCompactStateStore(null);
        handleRepository.close();
        handleLock.release();
      },
    };
    current = { handle };
    return handle;
  } catch (error) {
    const reason = classify(error);
    repository?.close();
    lock?.release();
    setOpaqueCompactStateUnavailable(reason);
    console.warn(
      `[ClaudeOpaqueCompact] phase=store_unavailable reason=${reason}` +
        ` detail=${error instanceof Error ? error.name : "UnknownError"}`,
    );
    const handle: OpaqueCompactRuntimeHandle = {
      ready: false,
      reason,
      close: () => setOpaqueCompactStateUnavailable(reason),
    };
    current = { handle };
    return handle;
  }
}

/**
 * 配置热切换。
 *
 * Admin 可以把 flag 在 false/true 之间改。若不管生命周期，会出现两种破窗：
 * false→true 后路由认为已开启但 store 从未初始化（全部 409）；true→false 后
 * runtime 仍持有 DB/key/锁并继续触盘，既违反 disabled zero-touch，又白白挡住
 * 第二实例。这里做串行化重配置：先安全停掉旧的，再按新配置启动。
 *
 * 失败时保持 not-ready 并带结构化 reason，绝不留下"配置 true 但 store 未初始化"
 * 却无法解释的中间态。
 */
export function reconfigureOpaqueCompactRuntime(
  config: OpaqueCompactRuntimeConfig,
): OpaqueCompactRuntimeHandle {
  // 先停止接收新的 opaque 流量：store 置空后路由立即 fail-closed。
  setOpaqueCompactStateStore(null);
  try {
    current?.handle.close();
  } catch {
    /* 旧实例关闭失败不应阻塞新配置生效；锁会随进程/连接释放 */
  }
  current = null;
  return startOpaqueCompactRuntime(config);
}

/** 测试用：丢弃对当前 runtime 的引用，不触发 close。 */
export function forgetOpaqueCompactRuntimeForTesting(): void {
  current = null;
}
