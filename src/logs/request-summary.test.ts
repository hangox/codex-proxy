import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { summarizeRequestForLog } from "./request-summary.js";
import { ConfigSchema } from "../config-schema.js";
import { resetConfigForTesting, setConfigForTesting } from "../config.js";

describe("summarizeRequestForLog", () => {
  beforeEach(() => {
    resetConfigForTesting();
    setConfigForTesting(ConfigSchema.parse({}));
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
    setConfigForTesting(ConfigSchema.parse({ logs: { capture_body: true } }));

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
    setConfigForTesting(ConfigSchema.parse({ logs: { capture_body: false } }));

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
