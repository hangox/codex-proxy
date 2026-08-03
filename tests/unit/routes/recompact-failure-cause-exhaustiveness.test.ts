/**
 * ★ #83 收尾：`recompact_failed_original_account` 409 的 `cause` 字段直接
 * 透传 `OpaqueCompactStateError.reason`/`CompactServiceError.cause`（见
 * `messages.ts` 的 `deriveRecompactFailureCause` 文档），团队三次仲裁后的
 * 最终结论是"不建翻译层、不改名"——但代价是 `cause` 的值域隐式并入了
 * `OpaqueCompactStateFailure` 这个**别处定义**的联合类型，那个类型任何时候
 * 新增一个字面量，`cause` 的值域都跟着无声长大，而 `cause` 真正要紧的用途
 * （#80 未来的 409 冷却白名单）却完全没有一道复审关卡盯着这件事。
 *
 * 这个文件就是那道关卡：它不测试新行为，只穷尽枚举当前 22 个
 * `OpaqueCompactStateFailure` 字面量，把每一个分进恰好两类之一：
 *
 * - "known_cause"：真的会作为 `cause` 出现在
 *   `recompact_failed_original_account` 聚合点——即 `respondWithOpaqueCompactMarker`
 *   内部 CAS/save()/edge-replay 路径可能抛出、且不是 store 级致命故障（不会被
 *   `reportOpaqueCompactStoreFault`/`isFatalStoreFailure` 先拦下）的那 4 个值。
 * - "never_reaches"：这个聚合点永远看不到的值，原因是下面两条**互斥**的
 *   早退路径之一：
 *     1. `isFatalStoreFailure` 为真——`messages.ts` 在
 *        `respondWithOpaqueCompactMarker` 的 catch 块里先调用
 *        `reportOpaqueCompactStoreFault(error)`，命中就直接原子转 NOT_READY
 *        并 409 返回，代码永远走不到下面 `recompact_failed_original_account`
 *        那个分支（见 messages.ts 723 行附近的 `fault !== null` early return）。
 *     2. predecessor marker 解析失败——这些值只在
 *        `restoreOpaqueCompactRequest` 自己更早的 `resolve()` 调用里产生，
 *        那一步早在 `respondWithOpaqueCompactMarker` 被调用之前就已经短路
 *        返回（走 `recordOpaqueCompactDenial` 的另一个独立调用点），聚合点
 *        同样看不到。
 *
 * 关键机制：`classify()` 用一个 TypeScript 穷尽 `switch`（`default` 分支把
 * 剩余类型断言成 `never`）实现分类。这意味着——如果未来有人往
 * `OpaqueCompactStateFailure` 加一个新字面量却不来更新这个文件，**不是这个
 * 测试跑起来变红，是 `tsc`/`vitest` 类型检查直接编译失败**，比运行时测试
 * 失败更早、更硬地挡住"悄悄多了一个没人分类过的取值"。
 *
 * 新增一个字面量时的正确做法：读一遍上面两条早退路径的源码，确认这个新值
 * 到底会不会真的抵达 `recompact_failed_original_account` 聚合点，再把它填进
 * 下面 switch 对应的分支——不是照抄已有名字的风格猜一个分类。
 */
import { describe, expect, it } from "vitest";
import {
  deriveRecompactFailureCause,
} from "../../../src/routes/messages.js";
import {
  OpaqueCompactStateError,
  type OpaqueCompactStateFailure,
} from "../../../src/routes/shared/opaque-compact-state.js";

type Classification = "known_cause" | "never_reaches";

/**
 * 穷尽 `switch`——新增/删除 `OpaqueCompactStateFailure` 字面量而不同步改这里，
 * `default` 分支的 `never` 赋值会让 `tsc` 编译失败，不是运行时才发现。
 */
function classify(reason: OpaqueCompactStateFailure): Classification {
  switch (reason) {
    // ── known_cause：respondWithOpaqueCompactMarker 内部 CAS/save()/edge-
    // replay 路径可能抛出，且不属于 isFatalStoreFailure 那一族，会真的
    // 原样透传到 recompact_failed_original_account 的 cause 字段。──────────
    case "account_mismatch":
    case "preserved_tail_conflict":
    case "state_too_large":
    case "stale_generation":
      return "known_cause";

    // ── never_reaches · isFatalStoreFailure 一族：reportOpaqueCompactStoreFault
    // 在 messages.ts 的 catch 块里先于 recompact_failed_original_account 分支
    // 拦下，原子转 NOT_READY 后直接 409 返回，永远走不到 cause 派生这一步。──
    case "store_unavailable":
    case "store_locked":
    case "schema_unsupported":
    case "key_unavailable":
    case "key_mismatch":
    case "state_corrupt":
    case "store_reset_detected":
    case "migration_failed":
    case "key_policy_invalid":
      return "never_reaches";

    // ── never_reaches · predecessor marker 解析失败一族：只在
    // restoreOpaqueCompactRequest 自己更早的 resolve() 调用里产生，那一步
    // 比 respondWithOpaqueCompactMarker 更早短路返回，聚合点同样看不到。────
    case "invalid_marker":
    case "tampered":
    case "missing":
    case "not_found":
    case "expired":
    case "session_mismatch":
    case "model_mismatch":
    case "variant_mismatch":
    case "comp_hash_mismatch":
      return "never_reaches";

    default: {
      // 穷尽性守卫：新增字面量却没补上面任何一个 case 时，`reason` 在这里
      // 的类型不会收窄成 never，`tsc --noEmit` 直接编译失败。
      const exhaustive: never = reason;
      throw new Error(`未分类的 OpaqueCompactStateFailure 取值：${String(exhaustive)}`);
    }
  }
}

const KNOWN_CAUSE_VALUES: readonly OpaqueCompactStateFailure[] = [
  "account_mismatch",
  "preserved_tail_conflict",
  "state_too_large",
  "stale_generation",
];

const NEVER_REACHES_VALUES: readonly OpaqueCompactStateFailure[] = [
  // isFatalStoreFailure 一族
  "store_unavailable",
  "store_locked",
  "schema_unsupported",
  "key_unavailable",
  "key_mismatch",
  "state_corrupt",
  "store_reset_detected",
  "migration_failed",
  "key_policy_invalid",
  // predecessor marker 解析失败一族
  "invalid_marker",
  "tampered",
  "missing",
  "not_found",
  "expired",
  "session_mismatch",
  "model_mismatch",
  "variant_mismatch",
  "comp_hash_mismatch",
];

describe("recompact_failed_original_account 的 cause 值域穷尽性守卫（#83）", () => {
  it("known_cause 4 个 + never_reaches 18 个，合计等于当前 OpaqueCompactStateFailure 的全部 22 个取值", () => {
    expect(KNOWN_CAUSE_VALUES.length).toBe(4);
    expect(NEVER_REACHES_VALUES.length).toBe(18);
    const all = [...KNOWN_CAUSE_VALUES, ...NEVER_REACHES_VALUES];
    expect(new Set(all).size).toBe(all.length); // 无重复
    expect(all.length).toBe(22);
  });

  it.each(KNOWN_CAUSE_VALUES)("known_cause：%s", (reason) => {
    expect(classify(reason)).toBe("known_cause");
  });

  it.each(NEVER_REACHES_VALUES)("never_reaches：%s", (reason) => {
    expect(classify(reason)).toBe("never_reaches");
  });

  describe("对 known_cause 的 4 个值，deriveRecompactFailureCause 原样透传（不折叠、不改名）", () => {
    it.each(KNOWN_CAUSE_VALUES)("%s", (reason) => {
      const error = new OpaqueCompactStateError(reason);
      expect(deriveRecompactFailureCause(error)).toBe(reason);
    });
  });
});
