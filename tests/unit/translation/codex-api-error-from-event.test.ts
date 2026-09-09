import { describe, expect, it } from "vitest";
import { codexApiErrorFromEvent } from "@src/translation/codex-api-error-from-event.js";

describe("codexApiErrorFromEvent", () => {
  it("maps server_is_overloaded to HTTP 503", () => {
    const err = codexApiErrorFromEvent({
      code: "server_is_overloaded",
      message: "The server is overloaded",
    });

    expect(err.status).toBe(503);
    expect(err.body).toContain("server_is_overloaded");
  });

  it("reclassifies a real invalid_function_parameters event (Artifact schema rejected) to 400 + non-retryable", () => {
    // QA 黑盒复现的真实交互式会话场景：上游走 WebSocket/SSE 事件路径报错，
    // code 是 `invalid_function_parameters`（不在 statusForCode 任何一条分支
    // 里，兜底落到 502），message 里带着确定性的 schema 校验错误文案。这条
    // 路径此前没有接上 classifyRawUpstreamError，502 又落在 withRetry 的可
    // 重试区间，于是 Claude Code 客户端自己的退避重试把交互式会话拖到
    // attempt 10/10 才放弃（QA 用真实账号连续复现 2 次）。
    const err = codexApiErrorFromEvent({
      code: "invalid_function_parameters",
      message: "Invalid schema for function 'Artifact': "
        + "'^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$' is not a 'regex'.",
    });

    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it("leaves an unrelated unknown code at the default 502 (no schema-error text) — no over-reclassification", () => {
    const err = codexApiErrorFromEvent({
      code: "some_unmapped_transient_code",
      message: "Something went wrong upstream, please retry.",
    });

    expect(err.status).toBe(502);
    expect(err.retryable).toBeUndefined();
  });
});
