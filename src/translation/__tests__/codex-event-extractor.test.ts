/**
 * Tests for parseCodexEvent — the shared event type parser.
 *
 * Tests the discriminated union mapping from raw SSE events to typed events.
 * This is the IR hub of the hub-and-spoke translation architecture.
 */

import { describe, it, expect } from "vitest";
import { parseCodexEvent } from "../../types/codex-events.js";
import type { CodexSSEEvent } from "../../proxy/codex-api.js";

describe("parseCodexEvent", () => {
  it("parses response.created with id", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.created");
    if (typed.type === "response.created") {
      expect(typed.response.id).toBe("resp_abc123");
    }
  });

  it("parses response.in_progress", () => {
    const raw: CodexSSEEvent = {
      event: "response.in_progress",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.in_progress");
    if (typed.type === "response.in_progress") {
      expect(typed.response.id).toBe("resp_abc123");
    }
  });

  it("parses response.output_text.delta", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: "Hello, world!" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.delta");
    if (typed.type === "response.output_text.delta") {
      expect(typed.delta).toBe("Hello, world!");
    }
  });

  it("parses response.output_text.done", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.done",
      data: { text: "Complete response text" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.done");
    if (typed.type === "response.output_text.done") {
      expect(typed.text).toBe("Complete response text");
    }
  });

  it("parses response.completed with usage", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_abc123",
          usage: { input_tokens: 150, output_tokens: 42 },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.id).toBe("resp_abc123");
      expect(typed.response.usage).toEqual({
        input_tokens: 150,
        output_tokens: 42,
      });
    }
  });

  it("parses response.completed without usage", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: { response: { id: "resp_abc123" } },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.usage).toBeUndefined();
    }
  });

  it("returns unknown for unrecognized event types", () => {
    const raw: CodexSSEEvent = {
      event: "response.some_future_event",
      data: { foo: "bar" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
    if (typed.type === "unknown") {
      expect(typed.raw).toEqual({ foo: "bar" });
    }
  });

  it("returns unknown when response.created has no response object", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: "not an object",
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("returns unknown when response.created data has no response field", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: { something_else: true },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("returns unknown when delta is not a string", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: 123 },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("handles empty delta string", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: { delta: "" },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.output_text.delta");
    if (typed.type === "response.output_text.delta") {
      expect(typed.delta).toBe("");
    }
  });

  it("defaults usage token counts to 0 for non-numeric values", () => {
    const raw: CodexSSEEvent = {
      event: "response.completed",
      data: {
        response: {
          id: "resp_1",
          usage: { input_tokens: "not a number", output_tokens: null },
        },
      },
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("response.completed");
    if (typed.type === "response.completed") {
      expect(typed.response.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
    }
  });

  it("handles null data", () => {
    const raw: CodexSSEEvent = {
      event: "response.created",
      data: null,
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });

  it("handles array data", () => {
    const raw: CodexSSEEvent = {
      event: "response.output_text.delta",
      data: [1, 2, 3],
    };
    const typed = parseCodexEvent(raw);
    expect(typed.type).toBe("unknown");
  });
});
