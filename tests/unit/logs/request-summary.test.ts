/**
 * ★ 排查压缩明细面板"跳转日志页"链接时（team-lead 要求"必须实测，不要
 * 假设"）顺带发现：这份 `summarizeRequestForLog` 测试原来放在
 * `src/logs/request-summary.test.ts`，那个位置不在 `vitest.config.ts` 的
 * `include` 范围内，从来没在任何 `npm test`/CI 里跑过（`npx vitest run
 * src/logs/request-summary.test.ts` 直接报 "No test files found"）——不是
 * 部分覆盖不足，是这个函数的测试**完全没有执行过**，包括其中最要紧的部分：
 * Authorization/API key 在落盘前有没有真的被脱敏。移到这个仓库实际执行
 * 测试的位置（`tests/unit/**`），import 路径换成这个目录下的既有约定
 * （`@src/` 别名），逻辑不变。原文件已删除。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { summarizeRequestForLog } from "@src/logs/request-summary.js";
import { ConfigSchema } from "@src/config-schema.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";

describe("summarizeRequestForLog", () => {
  beforeEach(() => {
    resetConfigForTesting();
    setConfigForTesting(ConfigSchema.parse({ api: {}, client: {}, model: {}, auth: {}, server: {}, session: {} }));
  });

  afterEach(() => {
    resetConfigForTesting();
  });

  it("summarizes chat requests without copying large payloads", () => {
    const summary = summarizeRequestForLog("chat", {
      model: "gpt-5.2-codex",
      stream: true,
      max_tokens: 1024,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "x".repeat(10_000) }],
      tools: [{ type: "function" }],
      previous_response_id: "resp_123",
      response_format: { type: "json_schema", schema: { type: "object" } },
    }, {
      ip: "127.0.0.1",
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "topsecret",
      },
    });

    expect(summary).toMatchObject({
      body_type: "chat.completions",
      model: "gpt-5.2-codex",
      stream: true,
      max_tokens: 1024,
      reasoning_effort: "high",
      messages: 1,
      tools: 1,
      previous_response_id: "resp_123",
      response_format: "json_schema",
      ip: "127.0.0.1",
    });
    expect(JSON.stringify(summary)).not.toContain("x".repeat(100));
    expect(JSON.stringify(summary)).not.toContain("Bearer secret");
    expect(JSON.stringify(summary)).not.toContain("topsecret");
  });

  it("summarizes responses requests", () => {
    const summary = summarizeRequestForLog("responses", {
      model: "codex",
      stream: false,
      input: [{ role: "user", content: "hello" }],
      instructions: "be helpful",
      tools: [{ type: "function" }],
      previous_response_id: "resp_456",
      text: { format: { type: "json_schema" } },
    });

    expect(summary).toMatchObject({
      body_type: "responses",
      model: "codex",
      stream: false,
      input_items: 1,
      instructions_bytes: 10,
      tools: 1,
      previous_response_id: "resp_456",
      text_format: "json_schema",
    });
  });

  it("captures redacted request bodies when capture_body is enabled", () => {
    setConfigForTesting(ConfigSchema.parse({ api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, logs: { capture_body: true } }));

    const summary = summarizeRequestForLog("messages", {
      model: "claude-sonnet",
      stream: true,
      messages: [{ role: "user", content: "secret prompt" }],
      api_key: "topsecret",
    }, {
      headers: {
        authorization: "Bearer secret",
      },
    });

    expect(summary).toMatchObject({
      body_type: "anthropic.messages",
      model: "claude-sonnet",
      stream: true,
      messages: 1,
      body: {
        model: "claude-sonnet",
        stream: true,
        messages: [{ role: "user", content: "secret prompt" }],
        api_key: "top***et",
      },
      headers: {
        authorization: "Bea***et",
      },
    });
  });

  it("does not include body when capture_body is disabled", () => {
    setConfigForTesting(ConfigSchema.parse({ api: {}, client: {}, model: {}, auth: {}, server: {}, session: {}, logs: { capture_body: false } }));

    const summary = summarizeRequestForLog("messages", {
      model: "claude-sonnet",
      messages: [{ role: "user", content: "secret prompt" }],
    });

    expect(summary).not.toHaveProperty("body");
    expect(summary).toMatchObject({
      body_type: "anthropic.messages",
      model: "claude-sonnet",
      messages: 1,
    });
  });
});
