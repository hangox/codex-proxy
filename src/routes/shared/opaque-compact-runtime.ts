/**
 * Opaque compact state 持久化的启动/关闭/重配置生命周期。
 *
 * 设计意图：把"要不要碰磁盘"这个决定收敛到一处。功能默认关闭，关闭时这里
 * 一行 IO 都不做——不建 DB、不读密钥、不抢锁。开启时按固定顺序初始化，任何
 * 一步失败都让功能进入 not-ready 并记录**结构化原因**，由路由转成精确的 409，
 * 而不是退化成"当作没有 marker"继续跑。
 *
 * 三条关键约束：
 *
 * 1. **密钥在 data 目录之外**。master key 与 state DB 同目录时，拿到 data 卷
 *    或备份就同时拿到密文和钥匙，记录级 AEAD 提供不了 at-rest 隔离。因此
 *    keyring 路径必须显式配置且不得位于 dataDir 内，缺失即 fail-closed，
 *    生产环境绝不自动生成。
 *
 * 2. **初始化可重入**。首次启动要写 sentinel、keyring、DB 三样东西，中间任何
 *    一点被 SIGKILL 都不能让下次启动卡死。sentinel 采用两阶段：先写 phase=init，
 *    全部就绪后才原子改写为 phase=ready。只有 ready 才代表"store 已存在"。
 *
 * 3. **发现损坏即整体 not-ready**。恢复阶段一旦有记录通不过 AEAD 验证，就进入
 *    quarantine：保留原库字节、停止写入，由运维处置。不静默删除、不继续服务。
 */

import { resolve, sep } from "node:path";
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
  commitOpaqueCompactSentinel,
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
const LOCK_FILE = "store.lock";
const SENTINEL_FILE = "store.sentinel";

export interface OpaqueCompactRuntimeConfig {
  enabled: boolean;
  ttlMinutes: number;
  capacity: number;
  maxBytes: number;
  /**
   * 外部密钥环文件的绝对路径。生产必填且不得位于 data 目录内。
   * 未配置时 opaque 功能 fail-closed，绝不自动生成。
   */
  keyringFile?: string | null;
  /** 允许在密钥文件缺失时创建——仅供测试 fixture 使用。 */
  allowKeyringBootstrap?: boolean;
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

/**
 * 当前活跃 runtime。用 token 区分实例：Admin 热切换会产生新 runtime，
 * 而进程 shutdown 可能仍持有旧 handle —— 旧 handle 的 close() 绝不能
 * 清空新 runtime 的 store 或漏关新 repository。
 */
interface RuntimeSlot {
  token: symbol;
  repository: OpaqueCompactRepository | null;
  lock: OpaqueCompactStoreLockHandle | null;
}

let current: RuntimeSlot | null = null;

/** 关闭当前 runtime（幂等）。进程 shutdown 应当调用它，而不是任何历史 handle。 */
export function closeCurrentOpaqueCompactRuntime(): void {
  if (current === null) return;
  const slot = current;
  current = null;
  setOpaqueCompactStateStore(null);
  slot.repository?.close();
  slot.lock?.release();
}

/** 只有仍是当前实例时才真正关闭，避免陈旧 handle 误伤新 runtime。 */
function makeHandle(
  token: symbol,
  ready: boolean,
  reason: OpaqueCompactStateFailure | null,
): OpaqueCompactRuntimeHandle {
  return {
    ready,
    reason,
    close: () => {
      if (current?.token !== token) return;
      closeCurrentOpaqueCompactRuntime();
    },
  };
}

function fail(token: symbol, reason: OpaqueCompactStateFailure, detail: string): OpaqueCompactRuntimeHandle {
  setOpaqueCompactStateUnavailable(reason);
  console.warn(`[ClaudeOpaqueCompact] phase=store_unavailable reason=${reason} detail=${detail}`);
  current = { token, repository: null, lock: null };
  return makeHandle(token, false, reason);
}

/**
 * 启动 opaque state 持久化。
 * `enabled=false` 时直接返回 inert handle，不产生任何文件系统副作用。
 */
export function startOpaqueCompactRuntime(
  config: OpaqueCompactRuntimeConfig,
): OpaqueCompactRuntimeHandle {
  const token = Symbol("opaque-compact-runtime");

  if (!config.enabled) {
    setOpaqueCompactStateStore(null);
    current = { token, repository: null, lock: null };
    return makeHandle(token, false, null);
  }

  const dir = resolveDirectory(config);
  const databasePath = resolve(dir, DB_FILE);
  const lockPath = resolve(dir, LOCK_FILE);
  const sentinelFile = resolve(dir, SENTINEL_FILE);
  const ttlMs = config.ttlMinutes * 60_000;

  // 密钥必须来自 data 目录之外的显式配置。
  const keyringFile = config.keyringFile?.trim();
  if (!keyringFile) {
    return fail(
      token,
      "key_unavailable",
      "opaque_compact_state.keyring_file is not configured",
    );
  }
  const dataDir = resolve(getDataDir());
  if (resolve(keyringFile).startsWith(dataDir + sep)) {
    // 与密文同卷存放钥匙，等于备份/卷泄漏即全量泄漏。
    return fail(token, "key_unavailable", "keyring must live outside the data directory");
  }

  let lock: OpaqueCompactStoreLockHandle | null = null;
  let repository: OpaqueCompactRepository | null = null;
  try {
    // 1) 先抢锁：第二实例必须在创建任何文件之前就被挡住。
    lock = acquireOpaqueCompactStoreLock(lockPath);

    // 2) sentinel 的 phase 决定这是不是首次初始化。
    //    只有 phase=ready 才代表"store 已存在"；phase=init 表示上次初始化
    //    中途崩溃，可以安全地继续把剩下的步骤补完（可重入）。
    const sentinel = loadOpaqueCompactSentinel(sentinelFile, {
      allowCreate: true,
      ...(config.now ? { now: config.now } : {}),
    })!;
    const firstInit = !sentinel.ready;

    // 3) keyring：首次初始化且显式允许时才可 bootstrap；
    //    store 已 ready 而密钥不见了，一律 fail-closed。
    const keyring = loadOpaqueCompactKeyring({
      keyringFile,
      allowCreate: firstInit && config.allowKeyringBootstrap === true,
      stateTtlMs: ttlMs,
      previousKeyRetentionMs: ttlMs + KEY_RETENTION_SAFETY_MARGIN_MS,
      // 保留窗口还要覆盖磁盘上真实存活记录：管理员调小 TTL 后重启，
      // 不能把仍未过期 state 依赖的密钥裁掉。
      liveStateExpiresAtMax: OpaqueCompactRepository.peekMaxExpiresAt(databasePath),
      ...(config.now ? { now: config.now } : {}),
    });

    // 4) 开库；storeId 交叉验证 DB 身份。
    repository = new OpaqueCompactRepository({
      databasePath,
      keyring,
      storeId: sentinel.storeId,
      sentinelCreated: firstInit,
      capacity: config.capacity,
      maxBytes: config.maxBytes,
      ...(config.now ? { now: config.now } : {}),
    });

    // 5) 全库 AEAD 验证。发现任何不可读记录即整体 quarantine。
    const recovered = repository.recover();
    if (recovered.unreadable > 0) {
      repository.close();
      lock.release();
      console.warn(
        `[ClaudeOpaqueCompact] phase=quarantined unreadable=${recovered.unreadable}` +
          ` retained=${recovered.retained}`,
      );
      setOpaqueCompactStateUnavailable("state_corrupt");
      current = { token, repository: null, lock: null };
      return makeHandle(token, false, "state_corrupt");
    }

    // 6) 一切就绪后才把 sentinel 标记为 ready —— 在此之前崩溃都可重入。
    if (firstInit) {
      commitOpaqueCompactSentinel(sentinelFile, sentinel.storeId, config.now ?? Date.now);
    }

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

    // 只记录结构量：不含 keyId（durable 且跨进程稳定，可用于长期关联）、
    // 不含 stateId / session / account / marker / 任何密文。
    console.log(
      `[ClaudeOpaqueCompact] phase=store_ready retained=${recovered.retained}` +
        ` expired=${recovered.expired}`,
    );

    current = { token, repository, lock };
    return makeHandle(token, true, null);
  } catch (error) {
    const reason = classify(error);
    repository?.close();
    lock?.release();
    return fail(token, reason, error instanceof Error ? error.name : "UnknownError");
  }
}

/**
 * 配置热切换。
 *
 * Admin 可以把 flag 在 false/true 之间改。若不管生命周期，会出现两种破窗：
 * false→true 后路由认为已开启但 store 从未初始化（全部 409）；true→false 后
 * runtime 仍持有 DB/key/锁并继续触盘，既违反 disabled zero-touch，又白白挡住
 * 第二实例。这里做串行化重配置：先安全停掉旧的，再按新配置启动。
 */
export function reconfigureOpaqueCompactRuntime(
  config: OpaqueCompactRuntimeConfig,
): OpaqueCompactRuntimeHandle {
  // 先断流量再释放资源：store 置空后路由立即 fail-closed。
  closeCurrentOpaqueCompactRuntime();
  return startOpaqueCompactRuntime(config);
}

/** 测试用：丢弃对当前 runtime 的引用，不触发 close。 */
export function forgetOpaqueCompactRuntimeForTesting(): void {
  current = null;
}

/** 从应用配置构造 runtime 配置。启动与 Admin 热切换共用，避免两处漂移。 */
export function buildOpaqueCompactRuntimeConfig(config: {
  model: { claude_code_opaque_compact_experimental: boolean };
  opaque_compact_state: {
    ttl_minutes: number;
    capacity: number;
    max_bytes: number;
    keyring_file: string | null;
  };
}): OpaqueCompactRuntimeConfig {
  return {
    enabled: config.model.claude_code_opaque_compact_experimental,
    ttlMinutes: config.opaque_compact_state.ttl_minutes,
    capacity: config.opaque_compact_state.capacity,
    maxBytes: config.opaque_compact_state.max_bytes,
    keyringFile: config.opaque_compact_state.keyring_file,
  };
}
