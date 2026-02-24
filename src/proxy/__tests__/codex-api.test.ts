/**
 * Tests for CodexApi SSE parsing.
 *
 * parseStream() is the most fragile code path — it processes real-time
 * byte streams from curl where chunks can split at any boundary.
 */

import { describe, it, expect } from "vitest";
import { CodexApi, type CodexSSEEvent } from "../codex-api.js";

/** Create a Response whose body emits the given string chunks sequentially. */
function mockResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  let idx = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx]));
        idx++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream);
}

/** Collect all events from parseStream into an array. */
async function collectEvents(api: CodexApi, response: Response): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const evt of api.parseStream(response)) {
    events.push(evt);
  }
  return events;
}

// CodexApi constructor requires a token — value is irrelevant for parsing tests
function createApi(): CodexApi {
  return new CodexApi("test-token", null);
}

describe("CodexApi.parseStream", () => {
  it("parses a complete SSE event in a single chunk", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("response.output_text.delta");
    expect(events[0].data).toEqual({ delta: "Hello" });
  });

  it("handles multiple events in a single chunk", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.created\ndata: {"response":{"id":"resp_1"}}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n' +
      'event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("response.created");
    expect(events[1].event).toBe("response.output_text.delta");
    expect(events[2].event).toBe("response.completed");
  });

  it("reassembles events split across chunk boundaries", async () => {
    const api = createApi();
    // Split in the middle of the JSON data
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"del',
      'ta":"world"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "world" });
  });

  it("handles chunk split at \\n\\n boundary", async () => {
    const api = createApi();
    // First chunk ends with first \n, second starts with second \n
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"a"}\n',
      '\nevent: response.output_text.delta\ndata: {"delta":"b"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ delta: "a" });
    expect(events[1].data).toEqual({ delta: "b" });
  });

  it("handles many small single-character chunks", async () => {
    const api = createApi();
    const full = 'event: response.output_text.delta\ndata: {"delta":"x"}\n\n';
    // Split into individual characters
    const chunks = full.split("");
    const response = mockResponse(...chunks);

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "x" });
  });

  it("skips [DONE] marker without crashing", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
      "data: [DONE]\n\n",
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "hi" });
  });

  it("returns raw string when data is not valid JSON", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: not-json-at-all\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("not-json-at-all");
  });

  it("handles malformed JSON (unclosed brace) gracefully", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"unclosed\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    // Should not throw — falls through to raw string
    expect(typeof events[0].data).toBe("string");
  });

  it("skips empty blocks between events", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"a"}\n\n' +
      "\n\n" + // empty block
      'event: response.output_text.delta\ndata: {"delta":"b"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(2);
  });

  it("processes remaining buffer after stream ends", async () => {
    const api = createApi();
    // No trailing \n\n — the event is only in the residual buffer
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"last"}',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "last" });
  });

  it("handles multi-line data fields", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":\n' +
      'data: "multi-line"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    // data lines are joined with \n: '{"delta":\n"multi-line"}'
    expect(events[0].data).toEqual({ delta: "multi-line" });
  });

  it("returns null body error", async () => {
    const api = createApi();
    // Create a response with null body
    const response = new Response(null);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("Response body is null");
  });

  it("throws on buffer overflow (>10MB)", async () => {
    const api = createApi();
    // Create a chunk that exceeds the 10MB SSE buffer limit
    const hugeData = "x".repeat(11 * 1024 * 1024);
    const response = mockResponse(hugeData);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("SSE buffer exceeded");
  });
});
