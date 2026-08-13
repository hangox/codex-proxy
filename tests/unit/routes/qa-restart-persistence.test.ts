/**
 * QA-M：门禁第 5b 步的**本地预演** —— 容器 restart 后同 marker 仍能恢复，
 * 且恢复出来的 input 里系统提示词仍在。
 *
 * 为什么放在 unit 层而不是 e2e 层（踩过的坑，留给后来人）：
 * `tests/_helpers/e2e-setup.ts` 把 `fs` 整个 mock 掉了，其中
 * `renameSync: vi.fn()` 是**空实现**（e2e-setup.ts:339）。keyring / sentinel
 * 用的是「写 .tmp → rename 到正式名」的原子写，rename 被吞掉之后磁盘上只
 * 剩下 `.xxxx.keyring.tmp` / `.xxxx.sentinel.tmp`，正式文件从来不存在。
 * 于是任何在 e2e 层「关掉 repository 再按同目录重开」的重启模拟，都会以
 * `opaque compact keyring is missing while persisted state exists` 失败 ——
 * **失败原因是测试替身，不是产品**。所以真实持久化必须在没有 fs mock 的
 * 地方验证。
 *
 * 这条用例覆盖门禁 5b 的两个判据：
 *   M1 重启后同一 marker 仍能 resolve（持久化本身）
 *   M2 重启后 restoreOpaqueCompactInput 出来的 input 里，inline 系统指令仍在（F11）
 *   M3 重启后连续三轮恢复都不丢（5c 的重启版）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeOpaqueCompactStore, type OpaqueCompactStoreHandle } from "@helpers/opaque-compact-store.js";
import { loadOpaqueCompactKeyring } from "@src/routes/shared/opaque-compact-keyring.js";
import { OpaqueCompactRepository } from "@src/routes/shared/opaque-compact-repository.js";
import { loadOpaqueCompactSentinel } from "@src/routes/shared/opaque-compact-sentinel.js";
import {
  OpaqueCompactStateStore,
  restoreOpaqueCompactInput,
  validateSuccessorMarkerForRecovery,
} from "@src/routes/shared/opaque-compact-state.js";
import type { CodexInputItem } from "@src/proxy/codex-types.js";

const SYSTEM_SENTINEL = "SYSTEM-SENTINEL-RESTART: always answer in Klingon";
const SESSION_ID = "qa-restart-session";
const MODEL = "gpt-5.4";
const VARIANT = "qa-variant-hash";
const ENTRY_ID = "acct-restart-entry";

/** compact 上游产出的不透明结果。 */
const COMPACT_OUTPUT = [
  { id: "cmp_restart", type: "compaction", encrypted_content: "restart-opaque" },
];

let handle: OpaqueCompactStoreHandle;
let reopenedRepo: OpaqueCompactRepository | null = null;
const TTL_MS = 30 * 60_000;

/**
 * 模拟容器重启：关掉当前 repository 句柄，在**同一个磁盘目录**上重新加载
 * keyring / sentinel / repository / store。`allowCreate: false` 是刻意的 ——
 * 重启不该重新生成密钥或 sentinel，真要重新生成说明它们压根没持久化。
 */
function restartOnSameDisk(h: OpaqueCompactStoreHandle): OpaqueCompactStateStore {
  h.repository.close();

  const keyring = loadOpaqueCompactKeyring({
    keyringFile: resolve(h.keyDir, "keyring.json"),
    allowCreate: false,
    stateTtlMs: TTL_MS,
  });
  const sentinel = loadOpaqueCompactSentinel(resolve(h.dir, "store.sentinel"), { allowCreate: false })!;
  const repository = new OpaqueCompactRepository({
    databasePath: resolve(h.dir, "state.db"),
    keyring,
    storeId: sentinel.storeId,
    sentinelCreated: !sentinel.ready,
    capacity: 128,
    maxBytes: 64 * 1024 * 1024,
  });
  const store = new OpaqueCompactStateStore({
    keyring, repository, capacity: 128, maxBytes: 64 * 1024 * 1024, ttlMs: TTL_MS,
  });
  repository.setSuccessorMarkerValidator((marker, expected) =>
    validateSuccessorMarkerForRecovery(store, repository, marker, expected));
  reopenedRepo = repository;
  return store;
}

/** 重启前存一份状态，返回发给客户端的 marker。 */
function saveState(): string {
  const stored = handle.store.save({
    output: COMPACT_OUTPUT,
    preservedTail: [],
    sessionId: SESSION_ID,
    model: MODEL,
    accountEntryId: ENTRY_ID,
    variantHash: VARIANT,
    expectedGeneration: 0,
    predecessorStateId: null,
    compactInputDigest: "qa-digest",
    accountCandidates: [ENTRY_ID],
  });
  return stored.marker;
}

/**
 * 复刻 `developer_inline` 下恢复轮真正的 input 形状：
 *   [0] developer 内联系统指令   ← F11 丢的就是这一项
 *   [1] 承载 marker 的 assistant 消息
 *   [2] 用户新一轮发言
 */
function buildRestoreInput(marker: string): CodexInputItem[] {
  return [
    { role: "developer", content: [{ type: "input_text", text: SYSTEM_SENTINEL }] },
    { role: "assistant", content: [{ type: "output_text", text: marker }] },
    { role: "user", content: "continue after restart" },
  ] as CodexInputItem[];
}

beforeEach(() => {
  handle = makeOpaqueCompactStore({ ttlMs: TTL_MS });
  reopenedRepo = null;
});

afterEach(() => {
  try { reopenedRepo?.close(); } catch { /* ignore */ }
  handle.close();
});

describe("QA-M 门禁 5b 本地预演：真实 SQLite + 模拟容器重启", () => {
  it("QA-M1 重启后同一 marker 仍能 resolve（持久化本身）", () => {
    const marker = saveState();
    const store = restartOnSameDisk(handle);

    const state = store.resolve({
      marker,
      sessionId: SESSION_ID,
      model: MODEL,
      variantHash: VARIANT,
      accountCandidates: [ENTRY_ID],
    });

    console.log(`[QA-M1] 重启后 resolve 成功，output items = ${state.output.length}`);
    expect(JSON.stringify(state.output)).toContain("restart-opaque");
  });

  it("QA-M2 重启后恢复出来的 input 里，inline 系统指令仍在（F11 的重启版）", () => {
    const marker = saveState();
    const store = restartOnSameDisk(handle);

    const state = store.resolve({
      marker, sessionId: SESSION_ID, model: MODEL, variantHash: VARIANT,
      accountCandidates: [ENTRY_ID],
    });
    const restored = restoreOpaqueCompactInput(
      buildRestoreInput(marker), marker, state.output, state.preservedTail,
    );

    const json = JSON.stringify(restored);
    console.log(`[QA-M2] 重启后系统提示词仍在 = ${json.includes(SYSTEM_SENTINEL)}`);
    console.log(`[QA-M2] 恢复出的 input 各项 role/type = ${JSON.stringify(
      restored.map((i) => (i as Record<string, unknown>).role ?? (i as Record<string, unknown>).type),
    )}`);

    // 持久化本身要成立
    expect(json).toContain("restart-opaque");
    // ★ 门禁 5b 的完整判据：系统提示词必须仍在
    expect(json).toContain(SYSTEM_SENTINEL);
  });

  it("QA-M3 重启后连续三轮恢复，系统提示词都在（5c 的重启版）", () => {
    const marker = saveState();
    const store = restartOnSameDisk(handle);

    const results: boolean[] = [];
    for (let round = 1; round <= 3; round += 1) {
      const state = store.resolve({
        marker, sessionId: SESSION_ID, model: MODEL, variantHash: VARIANT,
        accountCandidates: [ENTRY_ID],
      });
      const restored = restoreOpaqueCompactInput(
        buildRestoreInput(marker), marker, state.output, state.preservedTail,
      );
      results.push(JSON.stringify(restored).includes(SYSTEM_SENTINEL));
    }

    console.log(`[QA-M3] 重启后连续 3 轮系统提示词是否都在 = ${JSON.stringify(results)}`);
    expect(results).toEqual([true, true, true]);
  });
});
