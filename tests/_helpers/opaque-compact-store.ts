/**
 * 共享的持久化 opaque compact store 构造器。
 *
 * 从 `tests/unit/routes/opaque-compact-persistence.test.ts` 里的本地
 * `makeStore` 抽出来，供需要"真实 SQLite repository + 可控 now"的测试复用——
 * 尤其是 e2e 层：此前所有 `tests/e2e/*.test.ts` 都用
 * `installInMemoryOpaqueCompactStateStore()`，导致「reason 分类函数对、路由
 * 编排对」和「真实持久化路径」这两件事从未被同一条用例同时验证过（reviewer
 * Finding #3 / qa 设计文档指出的覆盖盲区）。这个 helper 就是补那个组合。
 *
 * 刻意不重写 `opaque-compact-persistence.test.ts` 自己的本地版本——那个文件
 * 已经有 70+ 条高频跑的单测围绕它的本地 `dir`/`keyDir` 模块变量写，强行切换
 * 成这里的自包含版本收益小、风险大（大范围改一个已经跑绿、覆盖详尽的文件），
 * 因此两份实现暂时并存：本地版留给该文件自己的既有用例，这份共享版给新的
 * e2e 用例用。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  loadOpaqueCompactKeyring,
  type OpaqueCompactKeyring,
} from "@src/routes/shared/opaque-compact-keyring.js";
import {
  OpaqueCompactRepository,
} from "@src/routes/shared/opaque-compact-repository.js";
import { loadOpaqueCompactSentinel } from "@src/routes/shared/opaque-compact-sentinel.js";
import {
  OpaqueCompactStateStore,
  validateSuccessorMarkerForRecovery,
} from "@src/routes/shared/opaque-compact-state.js";

export interface MakeOpaqueCompactStoreOptions {
  capacity?: number;
  maxBytes?: number;
  /** 默认 30 分钟，与生产历史默认值一致；传入以注入可控时钟做时间旅行测试。 */
  ttlMs?: number;
  now?: () => number;
}

export interface OpaqueCompactStoreHandle {
  keyring: OpaqueCompactKeyring;
  repository: OpaqueCompactRepository;
  store: OpaqueCompactStateStore;
  /** state.db 所在目录（密钥环刻意放在别处，见下方 keyDir）。 */
  dir: string;
  /** 密钥环目录——生产要求密钥与密文不同卷，测试同样分开，避免掩盖路径耦合 bug。 */
  keyDir: string;
  /** 关闭 repository 句柄并删除两个临时目录。测试的 afterEach 必须调用，否则每次跑都在 /tmp 下堆临时目录。 */
  close(): void;
}

/**
 * 构造一个自包含的持久化 store（真实 SQLite + 真实密钥环，临时目录）。
 * 调用方负责在 `afterEach` 里调用返回值的 `close()`。
 */
export function makeOpaqueCompactStore(
  options: MakeOpaqueCompactStoreOptions = {},
): OpaqueCompactStoreHandle {
  const dir = mkdtempSync(resolve(tmpdir(), "opaque-e2e-persist-"));
  const keyDir = mkdtempSync(resolve(tmpdir(), "opaque-e2e-keys-"));
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const capacity = options.capacity ?? 128;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;

  const keyring = loadOpaqueCompactKeyring({
    keyringFile: resolve(keyDir, "keyring.json"),
    allowCreate: true,
    stateTtlMs: ttlMs,
  });
  const sentinel = loadOpaqueCompactSentinel(resolve(dir, "store.sentinel"), { allowCreate: true })!;
  const repository = new OpaqueCompactRepository({
    databasePath: resolve(dir, "state.db"),
    keyring,
    storeId: sentinel.storeId,
    sentinelCreated: !sentinel.ready,
    capacity,
    maxBytes,
    ...(options.now ? { now: options.now } : {}),
  });
  const store = new OpaqueCompactStateStore({
    keyring,
    repository,
    capacity,
    maxBytes,
    ttlMs,
    ...(options.now ? { now: options.now } : {}),
  });
  // 与生产一致地接线 successor marker 语义校验（见
  // opaque-compact-runtime.ts 里生产启动时的同款接线）。
  repository.setSuccessorMarkerValidator((marker, expected) =>
    validateSuccessorMarkerForRecovery(store, repository, marker, expected));

  return {
    keyring,
    repository,
    store,
    dir,
    keyDir,
    close(): void {
      try {
        repository.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    },
  };
}
