/**
 * ★ #81：`recompact_failed_original_account` 聚合桶按 `cause` 分文案的
 * 直接单元覆盖——不依赖 e2e 构造真实的并发/容量/账号场景（那些成本更高、
 * 且已经在 `tests/e2e/opaque-compact-state-capacity-growth.test.ts`（
 * state_too_large）、`tests/e2e/messages.test.ts`（preserved_tail_conflict、
 * 默认账号失败桶）里分别用真实机制覆盖过），这里只锁 `describeRecompactFailure`
 * 本身的三桶映射，防止以后有人把某个 cause 悄悄挪去了错误的桶、或者把
 * 判断条件简化掉。
 *
 * 之所以叫"三桶"而不是给 22 个 `OpaqueCompactStateFailure` +
 * 全部 `RecompactFailureCause` 各写一句：`describeRecompactFailure` 的文档
 * 已经写明这是刻意的——按"用户到底能做什么"划分，不是按 cause 值本身的
 * 技术含义划分，避免拆出一堆文案完全相同、纯粹为了"不同"而不同的分支。
 */
import { describe, expect, it } from "vitest";
import { describeRecompactFailure } from "../../../src/routes/messages.js";
import type { RecompactFailureCause } from "../../../src/routes/shared/codex-compact-service.js";

describe("describeRecompactFailure（#81 三桶分文案）", () => {
  it("state_too_large：容量耗尽桶，建议 /clear 减小上下文，不提账号", () => {
    const text = describeRecompactFailure("state_too_large");
    expect(text).toContain("too large to save");
    expect(text).toContain("/clear");
    expect(text).not.toContain("original account");
  });

  it.each(["stale_generation", "preserved_tail_conflict"] as const)(
    "%s：并发/协议冲突桶，说明会自愈，不建议 /clear、不提账号",
    (cause) => {
      const text = describeRecompactFailure(cause);
      expect(text).toContain("conflicted with another compact operation");
      expect(text).not.toContain("/clear");
      expect(text).not.toContain("original account");
    },
  );

  it.each([
    "account_mismatch",
    "no_account_available",
    "bound_account_unavailable",
    "prompt_too_long",
    "model_not_supported",
    "rate_limited",
    "quota_exhausted",
    "account_banned",
    "account_deactivated",
    "token_expired",
    "cf_path_block",
    "transport_failure",
    "generic_upstream_error",
    "unexpected_error",
  ] as const)("%s：默认账号失败桶，逐字等于改动前的固定文案", (cause) => {
    expect(describeRecompactFailure(cause)).toBe(
      "Opaque compact state could not be compacted on its original account. Run /clear and start a new session.",
    );
  });

  it("三个桶产出三种互不相同的文案（不是表面不同、实际字符串相同）", () => {
    const texts = new Set([
      describeRecompactFailure("state_too_large"),
      describeRecompactFailure("stale_generation"),
      describeRecompactFailure("account_mismatch"),
    ]);
    expect(texts.size).toBe(3);
  });
});

/**
 * ★ #96（reviewer 交叉审查 P3）：`#83` 的穷尽性守卫
 * （`tests/unit/routes/recompact-failure-cause-exhaustiveness.test.ts`）只
 * 锁了 `OpaqueCompactStateFailure` 的 22 个值，没有对称覆盖
 * `RecompactFailureCause` 的 13 个值——上面 `it.each` 已经用运行时断言
 * 挨个验证过它们全部落进默认桶，但那只是"现在测出来是这样"，不是"以后
 * 谁加一个新值、忘了同步判断，会在编译期就报错"。同一份代码里留一个没
 * 设防的对称面，是浪费掉已经建立的纪律。
 *
 * 机制跟 #83 完全一样：`classify()` 用一个 TypeScript 穷尽 `switch`（
 * `default` 分支把 `cause` 断言成 `never`）分类——新增/删除
 * `RecompactFailureCause` 字面量而不同步改这里，`tsc` 编译失败，不是
 * 运行时才发现。跟 #83 一样，这个穷尽性 switch 本身不足以兑现"漏改就
 * 编译失败"的承诺——根 `tsconfig.json` 不检查 `tests/`，必须真的接进
 * `tsconfig.test-guards.json`（见该文件），已经这么做了。
 *
 * 分类结果（当前）：**全部 13 个值都归入默认桶**——这是团队已经确认过
 * 的判断（这些都是"这次 recompact 在原账号上失败了，且没有换个方式重试
 * 就会不同的理由"），不是这个测试自己猜的。新增字面量时，正确做法是先
 * 判断它是不是也满足这个前提，不是照抄这里的分类直接通过编译。
 */
function classifyRecompactFailureCause(cause: RecompactFailureCause): "default_clear_bucket" {
  switch (cause) {
    case "no_account_available":
    case "bound_account_unavailable":
    case "prompt_too_long":
    case "model_not_supported":
    case "rate_limited":
    case "quota_exhausted":
    case "account_banned":
    case "account_deactivated":
    case "token_expired":
    case "cf_path_block":
    case "transport_failure":
    case "generic_upstream_error":
    case "unexpected_error":
      return "default_clear_bucket";
    default: {
      const exhaustive: never = cause;
      throw new Error(`未分类的 RecompactFailureCause 取值：${String(exhaustive)}`);
    }
  }
}

const ALL_RECOMPACT_FAILURE_CAUSES: readonly RecompactFailureCause[] = [
  "no_account_available",
  "bound_account_unavailable",
  "prompt_too_long",
  "model_not_supported",
  "rate_limited",
  "quota_exhausted",
  "account_banned",
  "account_deactivated",
  "token_expired",
  "cf_path_block",
  "transport_failure",
  "generic_upstream_error",
  "unexpected_error",
];

describe("RecompactFailureCause 的穷尽性守卫（#96，对称 #83）", () => {
  it("当前 13 个取值合计等于穷举列表长度，无重复", () => {
    expect(new Set(ALL_RECOMPACT_FAILURE_CAUSES).size).toBe(ALL_RECOMPACT_FAILURE_CAUSES.length);
    expect(ALL_RECOMPACT_FAILURE_CAUSES.length).toBe(13);
  });

  it.each(ALL_RECOMPACT_FAILURE_CAUSES)("%s：穷尽 switch 分类为默认桶", (cause) => {
    expect(classifyRecompactFailureCause(cause)).toBe("default_clear_bucket");
  });

  it.each(ALL_RECOMPACT_FAILURE_CAUSES)("%s：真实 describeRecompactFailure 逐字等于默认桶固定文案", (cause) => {
    expect(describeRecompactFailure(cause)).toBe(
      "Opaque compact state could not be compacted on its original account. Run /clear and start a new session.",
    );
  });
});
