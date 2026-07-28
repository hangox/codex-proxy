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

import { basename, dirname, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
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
  OpaqueCompactQuarantineError,
  quarantineOpaqueCompactStore,
  readActiveQuarantineMarker,
} from "./opaque-compact-quarantine.js";
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
  setOpaqueCompactRuntimeFaultHandler,
  validatePersistedPayloadForRecovery,
  validateSuccessorMarkerForRecovery,
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

/**
 * 判断密钥环是否落在 data 目录内（含目录本身）。
 *
 * 对已存在的路径优先用 realpath 比较，这样 symlink 指回 data 卷也会被识破；
 * 路径尚不存在时退回其父目录的 realpath，覆盖"密钥文件还没创建"的首次启动。
 */
function isInsideDataDir(keyringFile: string): boolean {
  const canonical = (target: string): string => {
    try {
      return realpathSync(target);
    } catch {
      // 尚不存在：用父目录的真实路径 + 文件名拼出规范形式。
      try {
        return resolve(realpathSync(dirname(target)), basename(target));
      } catch {
        return resolve(target);
      }
    }
  };
  const dataDir = canonical(getDataDir());
  const key = canonical(keyringFile);
  return key === dataDir || key.startsWith(dataDir + sep);
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
    // 版本不受支持 = 格式漂移，必须与"store 被重置"区分开，
    // 否则 route/health 会给出误导性原因。
    return error.reason === "sentinel_unsupported_version"
      ? "schema_unsupported"
      : "store_reset_detected";
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
      case "migration_failed":
        // 迁移失败自成一类：旧库已回滚为完整旧格式，运维该做的是排查后重试
        // 升级，而不是按 state_corrupt 去隔离/重建。
        return "migration_failed";
      default:
        return "store_unavailable";
    }
  }
  // active quarantine marker：无论是"已隔离"还是"marker 读不懂"，对外都必须
  // 是同一个逐字稳定的 reason —— 连续重启的运维断言依赖它一字不变。
  if (error instanceof OpaqueCompactQuarantineError) {
    return "state_corrupt";
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

// 让 state 层的动态故障最终由 runtime 执行资源释放。
setOpaqueCompactRuntimeFaultHandler((reason) => reportOpaqueCompactRuntimeFault(reason));

/** 关闭当前 runtime（幂等）。进程 shutdown 应当调用它，而不是任何历史 handle。 */
export function closeCurrentOpaqueCompactRuntime(): void {
  if (current === null) return;
  const slot = current;
  current = null;
  setOpaqueCompactStateStore(null);
  slot.repository?.close();
  slot.lock?.release();
}

/**
 * 运行期发现 store 级致命错误时的统一入口。
 *
 * 必须由 runtime 层接管，而不是让 state 层单改全局指针：只清 store 指针会
 * 留下"readiness=not-ready，但 DB 连接和独占锁仍被持有"的半下线状态——
 * 实测后果是任何后续 start 都拿不到锁（`store_locked`），且旧 handle 的
 * close() 也失效（current 已被失败的 start 覆盖），形成永久锁泄漏。
 *
 * 这里基于当前 slot 原子地 detach + close + release，然后把 reason 固定
 * 下来，使当前请求、后续请求、/health、Admin readiness 得到同一个机器码。
 */
export function reportOpaqueCompactRuntimeFault(
  reason: OpaqueCompactStateFailure,
): OpaqueCompactStateFailure {
  closeCurrentOpaqueCompactRuntime();
  setOpaqueCompactStateUnavailable(reason);
  console.warn(`[ClaudeOpaqueCompact] phase=store_fault reason=${reason}`);
  return reason;
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
  // 与密文同卷存放钥匙，等于备份/卷泄漏即全量泄漏。
  // 用 realpath 比较，避免 symlink 绕过；同时排除 keyring 就是 data 目录本身。
  if (isInsideDataDir(keyringFile)) {
    return fail(token, "key_unavailable", "keyring must live outside the data directory");
  }

  let lock: OpaqueCompactStoreLockHandle | null = null;
  let repository: OpaqueCompactRepository | null = null;
  try {
    // 1) 先抢锁：第二实例必须在创建任何文件之前就被挡住。
    lock = acquireOpaqueCompactStoreLock(lockPath);

    // 2) active quarantine marker 必须在**创建任何文件之前**读：一旦 store 被
    //    隔离过，正常路径上已经没有库，若不先看这枚标记就往下走，最好的结果是
    //    store_reset_detected，最坏的结果是当成全新部署重建一个空库——隔离白做。
    //    marker 读不懂一律 fail-closed（readActiveQuarantineMarker 抛错）。
    const activeQuarantine = readActiveQuarantineMarker(dir);

    // 3) sentinel 的 phase 决定这是不是首次初始化。
    //    只有 phase=ready 才代表"store 已存在"；phase=init 表示上次初始化
    //    中途崩溃，可以安全地继续把剩下的步骤补完（可重入）。
    //
    //    marker 在场时**禁止顺手新建 sentinel**：新 sentinel 会拿到一个随机
    //    storeId，它与 marker 里的 storeId 永远不可能相等，于是下面那道身份
    //    比对必然放行——"删掉 sentinel"就成了绕过隔离、重建空库的后门。
    //    因此这种组合直接 fail-closed，由运维显式重建身份后再启动。
    const sentinel = loadOpaqueCompactSentinel(sentinelFile, {
      allowCreate: activeQuarantine === null,
      ...(config.now ? { now: config.now } : {}),
    });
    if (sentinel === null) {
      throw new OpaqueCompactQuarantineError(
        "quarantine_active",
        "store is quarantined and its sentinel is gone; refusing to mint a new identity",
      );
    }
    const firstInit = !sentinel.ready;

    // marker 只对**它自己那份 store** 生效：storeId 不匹配说明运维已经显式重建
    // 了 store 身份（sentinel 真实存在且换了 storeId），不该被上一份的隔离连坐。
    // 匹配则直接 NOT_READY，既不建库也不再产生第二份快照——隔离状态因此在每次
    // 重启后逐字稳定。
    if (activeQuarantine !== null && activeQuarantine.storeId === sentinel.storeId) {
      throw new OpaqueCompactQuarantineError(
        "quarantine_active",
        "store is quarantined; refusing to open or recreate the database",
      );
    }

    // 4) keyring：首次初始化且显式允许时才可 bootstrap；
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

    // 5) 开库；storeId 交叉验证 DB 身份。旧 schema（v2/v3）在这一步原子迁移到当前版本。
    repository = new OpaqueCompactRepository({
      databasePath,
      keyring,
      storeId: sentinel.storeId,
      sentinelCreated: firstInit,
      capacity: config.capacity,
      maxBytes: config.maxBytes,
      ...(config.now ? { now: config.now } : {}),
    });
    // 冷启动不仅要过 AEAD，还要通过结构与绑定校验；否则版本/形状漂移
    // 要等到用户真正 restore 才暴露。
    const repositoryForValidation = repository;
    repository.setPayloadValidator((plaintext, meta) =>
      validatePersistedPayloadForRecovery(keyring, repositoryForValidation, plaintext, meta));

    // store 必须在 recover **之前**构造：successor 校验要用它做 marker
    // 语法与签名验证。若等到 recover 之后再安装 validator，冷启动就只过
    // AEAD——一条 AEAD-valid 但根本不是 marker 的映射会让 store 照常 ready，
    // 直到客户端重试时才把这段垃圾当 marker 交出去。
    const runtimeStore = new OpaqueCompactStateStore({
      capacity: config.capacity,
      maxBytes: config.maxBytes,
      ttlMs,
      keyring,
      repository,
      ...(config.now ? { now: config.now } : {}),
    });
    repository.setSuccessorMarkerValidator((marker, expected) =>
      validateSuccessorMarkerForRecovery(runtimeStore, repositoryForValidation, marker, expected));

    // 6) 全库 AEAD + 语义验证。发现任何不可读记录即整体 quarantine。
    const recovered = repository.recover();
    if (recovered.unreadable > 0) {
      repository.close();
      // 真实隔离：把损坏的 DB/WAL/SHM 原始字节整体移出正常路径，保留取证快照。
      // 只打日志 + not-ready 是不够的——原库仍在原地，下次启动会照常撞上它，
      // 而且没有任何持久证据可供运维分析。
      // storeId 一并写进 active marker：后续启动据此判断"这枚隔离标记是不是
      // 属于我这份 store"，避免连坐一份全新重建的 store。
      const quarantined = quarantineOpaqueCompactStore({
        databasePath,
        reason: "recover_unreadable",
        stamp: new Date(config.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-"),
        storeId: sentinel.storeId,
      });
      // 隔离必须在释放锁之前完成：否则第二实例可能在移动过程中抢进来。
      lock.release();
      console.warn(
        `[ClaudeOpaqueCompact] phase=quarantined unreadable=${recovered.unreadable}` +
          ` retained=${recovered.retained} isolated=${quarantined.ok}` +
          ` files=${quarantined.moved.length} marker=${quarantined.markerWritten}`,
      );
      setOpaqueCompactStateUnavailable("state_corrupt");
      current = { token, repository: null, lock: null };
      return makeHandle(token, false, "state_corrupt");
    }

    // 7) 一切就绪后才把 sentinel 标记为 ready —— 在此之前崩溃都可重入。
    if (firstInit) {
      commitOpaqueCompactSentinel(sentinelFile, sentinel.storeId, config.now ?? Date.now);
    }

    setOpaqueCompactStateStore(runtimeStore);

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

/** 与 config-schema 保持一致的默认值。 */
const RUNTIME_DEFAULTS = {
  ttlMinutes: 30,
  capacity: 128,
  maxBytes: 64 * 1024 * 1024,
} as const;

/**
 * 从应用配置构造 runtime 配置。启动与 Admin 热切换共用，避免两处漂移。
 *
 * 对缺失的 `opaque_compact_state` 段回退到 schema 默认值：升级后尚未写入该段的
 * 旧配置（以及测试里的部分 config double）不应触发运行时 TypeError。缺 keyring
 * 路径本身仍会在 start 时 fail-closed，安全性不受影响。
 */
export function buildOpaqueCompactRuntimeConfig(config: {
  model?: { claude_code_opaque_compact_experimental?: boolean };
  opaque_compact_state?: {
    ttl_minutes?: number;
    capacity?: number;
    max_bytes?: number;
    keyring_file?: string | null;
  };
}): OpaqueCompactRuntimeConfig {
  const section = config.opaque_compact_state ?? {};
  return {
    enabled: config.model?.claude_code_opaque_compact_experimental === true,
    ttlMinutes: section.ttl_minutes ?? RUNTIME_DEFAULTS.ttlMinutes,
    capacity: section.capacity ?? RUNTIME_DEFAULTS.capacity,
    maxBytes: section.max_bytes ?? RUNTIME_DEFAULTS.maxBytes,
    keyringFile: section.keyring_file ?? null,
  };
}
