import { describe, it, expect } from "vitest";
import {
  deriveAnthropicCacheControlKey,
  extractAnthropicClientConversationId,
} from "@src/routes/shared/anthropic-session-id.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

function makeRequest(): AnthropicMessagesRequest {
  return {
    model: "gpt-5.4-mini",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  };
}

describe("extractAnthropicClientConversationId", () => {
  it("优先使用 x-claude-code-session-id 头", () => {
    const req = {
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({ session_id: "body-session" }),
      },
    };
    expect(extractAnthropicClientConversationId(req, "header-session")).toBe("header-session");
  });

  it("头不存在时回退到 metadata.user_id.session_id", () => {
    const req = {
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({
          session_id: "body-session",
          device_id: "device-1",
        }),
      },
    };
    expect(extractAnthropicClientConversationId(req, undefined)).toBe("body-session");
  });

  it("无可用 session_id 时返回 null", () => {
    expect(extractAnthropicClientConversationId(makeRequest(), undefined)).toBeNull();
    expect(extractAnthropicClientConversationId({
      ...makeRequest(),
      metadata: { user_id: "not-json" },
    }, undefined)).toBeNull();
  });

  it("metadata 缺少 Claude 设备字段时不启用回退解析", () => {
    expect(extractAnthropicClientConversationId({
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({ session_id: "generic-session" }),
      },
    }, undefined)).toBeNull();
  });
});

describe("deriveAnthropicCacheControlKey", () => {
  function requestWithCachePrefix(prefix: string, tail: string): AnthropicMessagesRequest {
    return {
      model: "gpt-5.6-terra",
      max_tokens: 16,
      system: [{ type: "text", text: "fixed system instruction" }],
      tools: [{ name: "fixed_tool", description: "fixed tool", input_schema: { type: "object" } }],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
          { type: "text", text: tail },
        ],
      }],
      stream: false,
    };
  }

  it("keeps the key stable when only the suffix after cache_control changes", () => {
    const first = deriveAnthropicCacheControlKey(requestWithCachePrefix("stable prefix", "tail one"));
    const second = deriveAnthropicCacheControlKey(requestWithCachePrefix("stable prefix", "tail two"));

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("changes the key when one character inside the cached prefix changes", () => {
    const first = deriveAnthropicCacheControlKey(requestWithCachePrefix("stable prefix", "same tail"));
    const second = deriveAnthropicCacheControlKey(requestWithCachePrefix("stable prefiX", "same tail"));

    expect(second).not.toBe(first);
  });

  it("uses the last cache_control breakpoint rather than the first one", () => {
    const requestWithTwoBreakpoints = (middle: string): AnthropicMessagesRequest => ({
      ...requestWithCachePrefix("first prefix", "tail"),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "first prefix", cache_control: { type: "ephemeral" } },
          { type: "text", text: middle },
          { type: "text", text: "second stable prefix", cache_control: { type: "ephemeral" } },
          { type: "text", text: "tail" },
        ],
      }],
    });

    expect(deriveAnthropicCacheControlKey(requestWithTwoBreakpoints("middle one"))).not.toBe(
      deriveAnthropicCacheControlKey(requestWithTwoBreakpoints("middle two")),
    );
  });

  it("ignores rotating Claude Code billing headers before a cached system block", () => {
    const requestWithBillingHeader = (billingHeader: string): AnthropicMessagesRequest => ({
      ...requestWithCachePrefix("stable prefix", "tail"),
      system: [
        { type: "text", text: billingHeader },
        { type: "text", text: "fixed system instruction", cache_control: { type: "ephemeral" } },
      ],
    });

    expect(deriveAnthropicCacheControlKey(
      requestWithBillingHeader("x-anthropic-billing-header: cc_version=2.1.84.a; cch=one;"),
    )).toBe(deriveAnthropicCacheControlKey(
      requestWithBillingHeader("x-anthropic-billing-header: cc_version=2.1.84.b; cch=two;"),
    ));
  });

  it("excludes system blocks after an ephemeral cache_control breakpoint", () => {
    const requestWithVolatileSystemSuffix = (cachedPrefix: string, volatileSuffix: string): AnthropicMessagesRequest => ({
      model: "gpt-5.6-terra",
      max_tokens: 16,
      tools: [{ name: "fixed_tool", description: "fixed tool", input_schema: { type: "object" } }],
      system: [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: volatileSuffix },
      ],
      messages: [{ role: "user", content: "tail" }],
      stream: false,
    });

    const first = deriveAnthropicCacheControlKey(
      requestWithVolatileSystemSuffix("stable system prefix", "volatile A"),
    );
    const second = deriveAnthropicCacheControlKey(
      requestWithVolatileSystemSuffix("stable system prefix", "volatile B"),
    );
    const changedPrefix = deriveAnthropicCacheControlKey(
      requestWithVolatileSystemSuffix("stable system prefiX", "volatile A"),
    );

    expect(second).toBe(first);
    expect(changedPrefix).not.toBe(first);
  });

  it("returns null without an explicit cache_control breakpoint", () => {
    expect(deriveAnthropicCacheControlKey(makeRequest())).toBeNull();
  });
});
