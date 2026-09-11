/**
 * Tests for Codex → Anthropic Messages translation.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtractedEvent } from "@src/translation/codex-event-extractor.js";
import {
  simpleTextStream,
  toolCallStream,
  reasoningStream,
  errorStream,
  emptyStream,
  multiToolCallStream,
  usageStream,
} from "@fixtures/sse-streams.js";
import { createCompleted, createCreated, createError, createTextDelta } from "@helpers/events.js";

let mockEvents: ExtractedEvent[] = [];

vi.mock("@src/translation/codex-event-extractor.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    iterateCodexEvents: vi.fn(async function* () {
      for (const evt of mockEvents) {
        yield evt;
      }
    }),
  };
});

import { streamCodexToAnthropic, collectCodexToAnthropicResponse } from "@src/translation/codex-to-anthropic.js";
import type { CodexApi } from "@src/proxy/codex-api.js";

const fakeCodexApi = {} as CodexApi;
const fakeResponse = new Response(null);

async function collectStreamOutput(events: ExtractedEvent[], wantThinking = false): Promise<string[]> {
  mockEvents = events;
  const chunks: string[] = [];
  for await (const chunk of streamCodexToAnthropic(fakeCodexApi, fakeResponse, "gpt-5.4", undefined, undefined, wantThinking)) {
    chunks.push(chunk);
  }
  return chunks;
}

function parseSSEEvents(chunks: string[]): Array<{ event: string; data: Record<string, unknown> }> {
  return chunks.map((c) => {
    const lines = c.trim().split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    return {
      event: eventLine?.slice(7) ?? "",
      data: dataLine ? JSON.parse(dataLine.slice(6)) : {},
    };
  });
}

describe("streamCodexToAnthropic", () => {
  it("emits message_start as first event", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const events = parseSSEEvents(chunks);
    expect(events[0].event).toBe("message_start");
    expect(events[0].data.type).toBe("message_start");
  });

  it("emits text deltas with content_block_delta", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const events = parseSSEEvents(chunks);
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data.delta as Record<string, unknown>)?.type === "text_delta",
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("emits fallback text carried by output_item.done", async () => {
    const chunks = await collectStreamOutput([
      {
        raw: { event: "response.output_item.done", data: {} },
        typed: {
          type: "response.output_item.done",
          outputIndex: 0,
          item: { type: "message", content: [{ type: "output_text", text: "fallback text" }] },
        },
        textDelta: "fallback text",
      },
      {
        raw: { event: "response.completed", data: {} },
        typed: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);
    const events = parseSSEEvents(chunks);
    const textDelta = events.find(
      (e) => e.event === "content_block_delta" && (e.data.delta as Record<string, unknown>)?.type === "text_delta",
    );
    expect((textDelta?.data.delta as Record<string, unknown>)?.text).toBe("fallback text");
  });

  it("emits message_stop at the end", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const events = parseSSEEvents(chunks);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.event).toBe("message_stop");
  });

  it("emits thinking blocks when wantThinking is true", async () => {
    const chunks = await collectStreamOutput(reasoningStream(), true);
    const events = parseSSEEvents(chunks);
    const thinkingStart = events.find(
      (e) => e.event === "content_block_start" && (e.data.content_block as Record<string, unknown>)?.type === "thinking",
    );
    expect(thinkingStart).toBeDefined();
  });

  it("emits tool_use blocks for function calls", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const events = parseSSEEvents(chunks);
    const toolStart = events.find(
      (e) => e.event === "content_block_start" && (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStart).toBeDefined();
  });

  it("sets stop_reason to tool_use for tool calls", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const events = parseSSEEvents(chunks);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta?.data.delta as Record<string, unknown>)?.stop_reason).toBe("tool_use");
  });

  it("sets stop_reason to end_turn for text", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const events = parseSSEEvents(chunks);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta?.data.delta as Record<string, unknown>)?.stop_reason).toBe("end_turn");
  });

  it("throws CodexApiError on upstream error events", async () => {
    await expect(collectStreamOutput(errorStream()))
      .rejects.toMatchObject({ status: 429 });
  });

  it("normalizes context_length_exceeded so Claude Code can reactive-compact", async () => {
    await expect(collectStreamOutput([
      createError("context_length_exceeded", "Your input exceeds the context window"),
    ])).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Prompt is too long"),
    });
  });

  it("accounts incomplete usage without invoking completion callbacks", async () => {
    const usages: unknown[] = [];
    const completedIds: Array<string | undefined> = [];
    const incompleteUsage = { input_tokens: 50, output_tokens: 20, cached_tokens: 30 };
    const chunks: string[] = [];
    mockEvents = [
      createCreated("resp_incomplete"),
      createTextDelta("partial"),
      {
        raw: { event: "response.incomplete", data: {} },
        typed: { type: "response.incomplete", response: { id: "resp_incomplete", usage: incompleteUsage } },
        responseId: "resp_incomplete",
        usage: incompleteUsage,
      },
    ];
    for await (const chunk of streamCodexToAnthropic(
      fakeCodexApi,
      fakeResponse,
      "gpt-5.4",
      (usage) => usages.push(usage),
      undefined,
      false,
      undefined,
      undefined,
      (id) => completedIds.push(id),
    )) {
      chunks.push(chunk);
    }

    expect(usages).toEqual([incompleteUsage]);
    expect(completedIds).toEqual([]);
    const messageDelta = parseSSEEvents(chunks).find((event) => event.event === "message_delta");
    expect(messageDelta?.data.usage).toEqual({ input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 30 });
  });

  it("throws EmptyResponseError before emitting fallback text for empty stream", async () => {
    await expect(collectStreamOutput(emptyStream()))
      .rejects.toThrow("empty response");
  });
});

describe("collectCodexToAnthropicResponse", () => {
  it("collects text into non-streaming response", async () => {
    mockEvents = simpleTextStream();
    const { response, usage } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.type).toBe("message");
    expect(response.role).toBe("assistant");
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toBe("Hello, world!");
    expect(response.stop_reason).toBe("end_turn");
    expect(usage.input_tokens).toBe(10);
  });

  it("returns raw Codex usage separately from Anthropic client usage", async () => {
    mockEvents = usageStream();
    const { response, usage } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );

    expect(response.usage).toEqual({
      input_tokens: 20,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    });
    expect(usage).toEqual({
      input_tokens: 50,
      output_tokens: 20,
      cached_tokens: 30,
      reasoning_tokens: 10,
    });
  });

  it("uses the first completed usage when a duplicate terminal event arrives", async () => {
    mockEvents = [
      ...usageStream(),
      createCompleted("resp_7", { input_tokens: 90, output_tokens: 40, cached_tokens: 1 }),
    ];
    const { response, usage } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );

    expect(response.usage.cache_read_input_tokens).toBe(30);
    expect(response.usage.input_tokens).toBe(20);
    expect(usage).toMatchObject({ input_tokens: 50, output_tokens: 20, cached_tokens: 30 });
  });

  it("retains usage from an incomplete terminal without marking success", async () => {
    const incompleteUsage = { input_tokens: 50, output_tokens: 20, cached_tokens: 30 };
    mockEvents = [
      ...simpleTextStream().slice(0, -1),
      {
        raw: { event: "response.incomplete", data: {} },
        typed: { type: "response.incomplete", response: { id: "resp_incomplete", usage: incompleteUsage } },
        responseId: "resp_incomplete",
        usage: incompleteUsage,
      },
    ];
    const { response, usage, responseCompleted } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );

    expect(responseCompleted).toBe(false);
    expect(usage).toEqual(incompleteUsage);
    expect(response.usage).toEqual({ input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 30 });
  });

  it("keeps internal usage unknown when completed omits the whole usage object", async () => {
    mockEvents = [
      ...simpleTextStream().slice(0, -1),
      createCompleted("resp_without_usage"),
    ];
    const { response, usage, responseCompleted } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );

    expect(responseCompleted).toBe(true);
    expect(usage).toBeUndefined();
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("includes thinking block when requested", async () => {
    mockEvents = reasoningStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4", true,
    );
    const thinkingBlock = response.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toContain("think");
  });

  it("collects tool_use blocks", async () => {
    mockEvents = toolCallStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.stop_reason).toBe("tool_use");
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    expect(toolBlock).toBeDefined();
  });

  it("throws on error", async () => {
    mockEvents = errorStream();
    await expect(collectCodexToAnthropicResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("Codex API error");
  });

  it("preserves usage on a response.failed error", async () => {
    const failedUsage = { input_tokens: 50, output_tokens: 20, cached_tokens: 30 };
    mockEvents = [{
      raw: { event: "response.failed", data: {} },
      typed: {
        type: "response.failed",
        response: { id: "resp_failed", usage: failedUsage },
        error: { type: "error", code: "server_error", message: "failed after billing" },
      },
      responseId: "resp_failed",
      usage: failedUsage,
      error: { code: "server_error", message: "failed after billing" },
    }];

    await expect(collectCodexToAnthropicResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toMatchObject({ usage: failedUsage, responseId: "resp_failed" });
  });

  it("throws EmptyResponseError for empty stream", async () => {
    mockEvents = emptyStream();
    await expect(collectCodexToAnthropicResponse(fakeCodexApi, fakeResponse, "gpt-5.4"))
      .rejects.toThrow("empty response");
  });
});

// ── Usage details (streaming) ─────────────────────────────────────────

describe("streamCodexToAnthropic — usage details", () => {
  it("includes cache_read_input_tokens in message_delta when cached_tokens present", async () => {
    const chunks = await collectStreamOutput(usageStream());
    const events = parseSSEEvents(chunks);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta).toBeDefined();
    const usage = msgDelta!.data.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(20);
    expect(usage.cache_read_input_tokens).toBe(30);
    expect(usage).not.toHaveProperty("cache_creation_input_tokens");
  });

  it("omits cache_read_input_tokens when not present", async () => {
    const chunks = await collectStreamOutput(simpleTextStream());
    const events = parseSSEEvents(chunks);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data.usage as Record<string, unknown>)).not.toHaveProperty("cache_read_input_tokens");
  });

  it("passes raw cached_tokens=0 to internal accounting", async () => {
    const usages: unknown[] = [];
    mockEvents = [
      ...simpleTextStream().slice(0, -1),
      createCompleted("resp_zero", { input_tokens: 50, output_tokens: 20, cached_tokens: 0 }),
    ];
    for await (const _chunk of streamCodexToAnthropic(
      fakeCodexApi,
      fakeResponse,
      "gpt-5.4",
      (usage) => usages.push(usage),
    )) { /* 消费 */ }

    expect(usages).toEqual([{ input_tokens: 50, output_tokens: 20, cached_tokens: 0 }]);
  });

  it("does not estimate omitted cached_tokens from affinity", async () => {
    const usages: unknown[] = [];
    mockEvents = [
      ...simpleTextStream().slice(0, -1),
      createCompleted("resp_unknown", { input_tokens: 50, output_tokens: 20 }),
    ];
    const chunks: string[] = [];
    for await (const chunk of streamCodexToAnthropic(
      fakeCodexApi,
      fakeResponse,
      "gpt-5.4",
      (usage) => usages.push(usage),
      undefined,
      false,
      { reusedInputTokensUpperBound: 45 },
    )) {
      chunks.push(chunk);
    }

    const messageDelta = parseSSEEvents(chunks).find((event) => event.event === "message_delta");
    expect(messageDelta?.data.usage).toEqual({ input_tokens: 50, output_tokens: 20 });
    expect(usages).toEqual([{ input_tokens: 50, output_tokens: 20 }]);
  });

  it("invokes usage and completion callbacks once for duplicate response.completed", async () => {
    const usages: unknown[] = [];
    const completedIds: Array<string | undefined> = [];
    mockEvents = [
      ...usageStream(),
      createCompleted("resp_7", { input_tokens: 90, output_tokens: 40, cached_tokens: 1 }),
    ];
    for await (const _chunk of streamCodexToAnthropic(
      fakeCodexApi,
      fakeResponse,
      "gpt-5.4",
      (usage) => usages.push(usage),
      undefined,
      false,
      undefined,
      undefined,
      (id) => completedIds.push(id),
    )) { /* 消费 */ }

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ input_tokens: 50, output_tokens: 20, cached_tokens: 30 });
    expect(completedIds).toEqual(["resp_7"]);
  });
});

// ── Thinking block ordering (streaming) ───────────────────────────────

describe("streamCodexToAnthropic — thinking block ordering", () => {
  it("emits thinking block start before text block start when wantThinking is true", async () => {
    const chunks = await collectStreamOutput(reasoningStream(), true);
    const events = parseSSEEvents(chunks);
    const blockStarts = events.filter((e) => e.event === "content_block_start");
    // First block should be thinking, second should be text
    expect(blockStarts.length).toBeGreaterThanOrEqual(2);
    expect((blockStarts[0].data.content_block as Record<string, unknown>)?.type).toBe("thinking");
    expect((blockStarts[1].data.content_block as Record<string, unknown>)?.type).toBe("text");
  });
});

// ── Tool use block structure (streaming) ──────────────────────────────

describe("streamCodexToAnthropic — tool_use block structure", () => {
  it("emits content_block_start with tool_use type including id and name", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const events = parseSSEEvents(chunks);
    const toolStart = events.find(
      (e) => e.event === "content_block_start" && (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStart).toBeDefined();
    const block = toolStart!.data.content_block as Record<string, unknown>;
    expect(block.id).toBe("call_1");
    expect(block.name).toBe("get_weather");
    expect(block.input).toEqual({});
  });

  it("emits input_json_delta for function call argument deltas", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const events = parseSSEEvents(chunks);
    const jsonDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data.delta as Record<string, unknown>)?.type === "input_json_delta",
    );
    expect(jsonDeltas.length).toBeGreaterThan(0);
  });

  it("emits content_block_stop after tool_use block", async () => {
    const chunks = await collectStreamOutput(toolCallStream());
    const events = parseSSEEvents(chunks);
    const toolStartIdx = events.findIndex(
      (e) => e.event === "content_block_start" && (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    const stopIdx = events.findIndex(
      (e, i) => i > toolStartIdx && e.event === "content_block_stop",
    );
    expect(stopIdx).toBeGreaterThan(toolStartIdx);
  });
});

// ── Collect response details ──────────────────────────────────────────

describe("collectCodexToAnthropicResponse — additional details", () => {
  it("includes cache_read_input_tokens in usage", async () => {
    mockEvents = usageStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    expect(response.usage.input_tokens).toBe(20);
    expect(response.usage.cache_read_input_tokens).toBe(30);
    expect(response.usage).not.toHaveProperty("cache_creation_input_tokens");
  });

  it("collects multiple tool_use blocks", async () => {
    mockEvents = multiToolCallStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4",
    );
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");
    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks[0].name).toBe("search");
    expect(toolBlocks[1].name).toBe("fetch");
  });

  it("orders thinking block before text block", async () => {
    mockEvents = reasoningStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4", true,
    );
    expect(response.content[0].type).toBe("thinking");
    expect(response.content[1].type).toBe("text");
  });

  it("includes full reasoning text in thinking block", async () => {
    mockEvents = reasoningStream();
    const { response } = await collectCodexToAnthropicResponse(
      fakeCodexApi, fakeResponse, "gpt-5.4", true,
    );
    const thinkingBlock = response.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toBe("Let me think... I need to consider");
  });
});
