import { describe, expect, it } from "vitest";
import {
  anthropicToolsToCodex,
  geminiToolsToCodex,
  openAIToolChoiceToCodex,
  openAIToolsToCodex,
} from "../tool-format.js";
import type { ChatCompletionRequest } from "../../types/openai.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";
import type { GeminiGenerateContentRequest } from "../../types/gemini.js";

describe("hosted web_search tool conversion", () => {
  it("converts OpenAI hosted web_search_preview to Codex hosted web_search", () => {
    const tools = [
      {
        type: "web_search_preview",
        search_context_size: "high",
        user_location: { type: "approximate", country: "US" },
      },
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object" },
        },
      },
    ] satisfies NonNullable<ChatCompletionRequest["tools"]>;

    expect(openAIToolsToCodex(tools)).toEqual([
      {
        type: "web_search",
        search_context_size: "high",
        user_location: { type: "approximate", country: "US" },
      },
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("converts OpenAI hosted web_search tool_choice", () => {
    expect(openAIToolChoiceToCodex({ type: "web_search_preview" })).toEqual({
      type: "web_search",
    });
  });

  it("converts Anthropic hosted web search to Codex hosted web_search", () => {
    const tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      },
      {
        name: "read_file",
        input_schema: { type: "object" },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("converts Claude Code WebSearch tool to Codex hosted web_search", () => {
    const tools = [
      {
        name: "WebSearch",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      { type: "web_search" },
    ]);
  });

  it("preserves a lowercase custom web_search tool as a function tool", () => {
    const tools = [
      {
        name: "web_search",
        description: "Project-local search implementation",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "web_search",
        description: "Project-local search implementation",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
  });

  it("preserves other Claude Code tools as function tools", () => {
    const tools = [
      {
        name: "Bash",
        description: "Run shell commands",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    ] satisfies NonNullable<AnthropicMessagesRequest["tools"]>;

    expect(anthropicToolsToCodex(tools)).toEqual([
      {
        type: "function",
        name: "Bash",
        description: "Run shell commands",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    ]);
  });

  it("converts Gemini googleSearch to Codex hosted web_search", () => {
    const tools = [
      {
        googleSearch: {},
        functionDeclarations: [
          {
            name: "lookup",
            parameters: { type: "object" },
          },
        ],
      },
    ] satisfies NonNullable<GeminiGenerateContentRequest["tools"]>;

    expect(geminiToolsToCodex(tools)).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});
