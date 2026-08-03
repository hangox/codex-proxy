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
