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
import { getDataDir, getDefaultOpaqueCompactKeyringFile } from "../../paths.js";
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
import { recordOpaqueCompactRuntimeFault } from "./opaque-compact-runtime-fault-log.js";
import { sanitizeFreeTextForLog } from "../../logs/redact.js";

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
   * 外部密钥环文件的绝对路径，不得位于 data 目录内。这个字段本身缺省
   * （`undefined`/`null`/空串）时 `startOpaqueCompactRuntime()` 一律
   * fail-closed——这条约束没有变。
   *
   * `buildOpaqueCompactRuntimeConfig()`（生产唯一入口）在用户完全没配
   * `opaque_compact_state.keyring_file` 时，会用 `getDefaultOpaqueCompactKeyringFile()`
   * 计算出一个合理默认值传进来，不再是裸的 `null`——具体是否真的据此
   * 创建新 keyring，仍然完全由下面的 `firstInit` 判定，不受这里传的是
   * 默认值还是用户显式配置值影响。直接调用本函数（测试）想要"未配置"
   * 这条 fail-closed 分支，仍然传 `null`/省略即可。
   */
  keyringFile?: string | null;
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
 * sentinel 文件的实际路径，供一次性运维工具（`scripts/build/opaque-keyring-bootstrap.ts`）
 * 只读探测"这个 store 是否已经初始化过"，不需要启动完整 runtime（不抢锁、
 * 不开库）。复用与 `startOpaqueCompactRuntime()` 完全相同的目录解析，避免
 * 引导脚本和真实 runtime 各自算出不同路径而互相看不见对方。
 */
export function resolveOpaqueCompactSentinelPath(directory?: string): string {
  return resolve(directory ?? resolve(getDataDir(), DEFAULT_DIR_NAME), SENTINEL_FILE);
}

/**
 * 判断密钥环是否落在 data 目录内（含目录本身）。
 *
 * 对已存在的路径优先用 realpath 比较，这样 symlink 指回 data 卷也会被识破；
 * 路径尚不存在时退回其父目录的 realpath，覆盖"密钥文件还没创建"的首次启动。
 *
 * 导出给一次性运维工具（`scripts/build/opaque-keyring-bootstrap.ts`）复用——
 * 引导脚本必须用同一份判断，不能自己重写一遍可能漂移的版本。
 */
export function isOpaqueCompactKeyringFileInsideDataDir(keyringFile: string): boolean {
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
setOpaqueCompactRuntimeFaultHandler((reason, detail) => reportOpaqueCompactRuntimeFault(reason, detail));

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
  detail?: string,
): OpaqueCompactStateFailure {
  closeCurrentOpaqueCompactRuntime();
  setOpaqueCompactStateUnavailable(reason, detail);
  const sanitizedDetail = detail != null ? sanitizeFreeTextForLog(detail) : undefined;
  console.warn(
    `[ClaudeOpaqueCompact] phase=store_fault reason=${reason}` +
      (sanitizedDetail !== undefined ? ` detail=${sanitizedDetail}` : ""),
  );
  recordOpaqueCompactRuntimeFault({ reason, detail, phase: "runtime" });
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
  setOpaqueCompactStateUnavailable(reason, detail);
  const sanitizedDetail = sanitizeFreeTextForLog(detail);
  console.warn(`[ClaudeOpaqueCompact] phase=store_unavailable reason=${reason} detail=${sanitizedDetail}`);
  recordOpaqueCompactRuntimeFault({ reason, detail, phase: "startup" });
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
  if (isOpaqueCompactKeyringFileInsideDataDir(keyringFile)) {
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

    // 4) keyring：★ 产品决定（用户拍板"开启开关时直接帮忙初始化，不用
    //    那么复杂"）——firstInit 本身就是完整、独立的安全闸门，不再需要
    //    第二个人工开关。这不是削弱 9b2763a 的加固：那次真正要挡的是
    //    "有任何已存在 state 时悄悄用新 key 顶替"，而这正是 firstInit
    //    单独就能保证的事——sentinel 严格按 lock→sentinel→keyring→DB
    //    两阶段提交，firstInit=true 时 DB 这一步在时间线上根本还没发生
    //    过，不可能有依赖这把 key 的密文已经落盘；`firstInit=false`
    //    （真有既有 state）时，无论如何都不自动创建，继续 fail-closed，
    //    这条硬约束逐字未变。
    //
    //    之前的 allowKeyringBootstrap 二级开关已删除——生产代码路径
    //    (buildOpaqueCompactRuntimeConfig()) 从来没有设置过它，留着一个
    //    不再被读取的字段只会制造"这个能力已经存在"的错觉。桌面版
    //    (dmg 不打包 scripts/、没有终端)靠的正是这次的自动初始化，不是
    //    那个只在 Docker/源码环境才够得到的脚本。
    //
    //    此时 !existsSync(keyringFile) 且 firstInit=false 仍然是唯一
    //    会走到 loadOpaqueCompactKeyring() 那句默认报错（"keyring is
    //    missing while persisted state exists"）的组合——这句话对这个
    //    组合来说依然准确（真的有既有 state，密钥真的丢了），不需要
    //    像上一轮那样再传自定义 missingFileMessage 覆盖它：firstInit=true
    //    时 allowCreate 恒为 true，根本不会走到那条报错分支。
    const keyring = loadOpaqueCompactKeyring({
      keyringFile,
      allowCreate: firstInit,
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
      // reviewer 复审发现的第三个 sink：这个分支此前只调用了
      // setOpaqueCompactStateUnavailable("state_corrupt")（不带 detail），
      // 也没有调用 recordOpaqueCompactRuntimeFault——新加的
      // OpaqueCompactRuntimeFault 结构化事件因此只覆盖了两条路径（启动
      // fail() + 运行时 reportOpaqueCompactRuntimeFault），第三条真实存在
      // 的掉线路径完全不出现在里面。一个只覆盖 2/3 场景的"新信号"比没有
      // 信号更危险：以后有人盯着这个事件名找"store 什么时候掉线"，会被
      // 这一类漏掉，且不会意识到自己漏看了。
      //
      // detail 内容只取上面这行 console.warn 已经打印过的字段（计数/布尔值
      // + quarantined.error），不是把整行原样塞进去：
      //   - unreadable/retained：聚合计数，安全。
      //   - quarantined.ok/markerWritten：布尔值，安全。
      //   - quarantined.moved.length：只取数组长度（隔离移动了几个文件），
      //     不取 quarantined.moved 本身（虽然那也只是固定的 DB 文件名列表，
      //     不是路径，但没有必要放进去，计数已经足够诊断）。
      //   - quarantined.directory：绝对路径，不放进去——即便这是本地 data
      //     卷内部路径、不含用户数据，跟其余字段"零路径"的一致性优先。
      //   - quarantined.error：★ `ccbb824` 之后这个字段可能带本地文件路径
      //     （`${error.name}: ${error.message}`，mkdirSync/renameSync 失败
      //     时的真实描述，见 opaque-compact-quarantine.ts 的
      //     QuarantineResult.error 文档）——这里不依赖"上游保证不含敏感
      //     内容"这类前提（那类保证已经被同一次改动推翻过一次），一律先过
      //     下面的 sanitizeFreeTextForLog 才放行；脱敏是这里唯一站得住的
      //     安全依据，不是"反正本来就干净、脱敏只是锦上添花的双保险"。
      const quarantineDetail = sanitizeFreeTextForLog(
        `recover_unreadable: unreadable=${recovered.unreadable} retained=${recovered.retained}` +
          ` quarantine_ok=${quarantined.ok} quarantine_files=${quarantined.moved.length}` +
          ` marker_written=${quarantined.markerWritten}` +
          (quarantined.error ? ` quarantine_error=${quarantined.error}` : ""),
      );
      setOpaqueCompactStateUnavailable("state_corrupt", quarantineDetail);
      recordOpaqueCompactRuntimeFault({ reason: "state_corrupt", detail: quarantineDetail, phase: "startup" });
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
    // ★ 排查生产事故发现：这里此前传的是 error.name——这些自定义 Error
    // 子类（OpaqueCompactRepositoryError 等）的 .name 在构造函数里恒为
    // 固定的类名字符串（比如 "OpaqueCompactRepositoryError"），跟 reason
    // 分类是同一件事的两种说法，不含任何具体诊断信息；真正描述"具体出了
    // 什么错"的是 .message（各个子系统的 throw site 各自传的自定义文本，
    // 比如"keyring file is not valid JSON"）。两者都留：.name 说明异常
    // 属于哪个子系统，.message 说明具体原因。
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return fail(token, reason, detail);
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

/**
 * 与 config-schema 保持一致的默认值。
 *
 * ★ 8.20：`ttlMinutes` 从 720（12h）改成 10080（7 天）——见
 * `config-schema.ts` 里 `ttl_minutes` 字段的完整事故复盘注释，两处必须
 * 同步改，否则 schema 声明的默认值和 runtime 实际生效的默认值不一致。
 */
const RUNTIME_DEFAULTS = {
  ttlMinutes: 10080,
  capacity: 1024,
  maxBytes: 64 * 1024 * 1024,
} as const;

/**
 * 从应用配置构造 runtime 配置。启动与 Admin 热切换共用，避免两处漂移。
 *
 * 对缺失的 `opaque_compact_state` 段回退到 schema 默认值：升级后尚未写入该段的
 * 旧配置（以及测试里的部分 config double）不应触发运行时 TypeError。
 *
 * `keyring_file` 显式配置了就用配置值；完全没配时落到
 * `getDefaultOpaqueCompactKeyringFile()`（`paths.ts`）算出的默认路径，
 * 不再是裸的 `null`——这是"开启开关就地初始化"这个产品决定成立的前提：
 * 桌面版用户不可能去手填一个 `keyring_file` 路径，必须有默认值。真正
 * 决定"要不要据此创建新 keyring"的仍然是 `startOpaqueCompactRuntime()`
 * 里的 `firstInit` 判定，这个函数只负责给出一个路径，不代表安全性判断
 * 挪到了这里。
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
    keyringFile: section.keyring_file ?? getDefaultOpaqueCompactKeyringFile(),
  };
}
