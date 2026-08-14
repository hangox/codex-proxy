import { describe, expect, it } from "vitest";
import type { CodexSSEEvent } from "@src/proxy/codex-api.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import { collectPassthrough } from "@src/routes/responses.js";
import { PASSTHROUGH_FORMAT } from "@src/routes/responses-passthrough.js";

function makeAdapter(events: CodexSSEEvent[]): UpstreamAdapter {
  return {
    tag: "test",
    async createResponse() {
      throw new Error("not used");
    },
    async *parseStream() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("collectPassthrough", () => {
  it("把 4xx 错误格式化为 Responses invalid_request_error，并归一 prompt-too-long", () => {
    expect(PASSTHROUGH_FORMAT.formatError(400, "bad request")).toEqual({
      type: "error",
      error: { type: "invalid_request_error", code: "codex_api_error", message: "bad request" },
    });
    expect(PASSTHROUGH_FORMAT.formatError(429, "rate limited")).toEqual({
      type: "error",
      error: { type: "invalid_request_error", code: "codex_api_error", message: "rate limited" },
    });
    expect(PASSTHROUGH_FORMAT.formatError(400, "Your input exceeds the context window")).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "Prompt is too long: Your input exceeds the context window",
      },
    });
  });

  it("会把 function_call 的 call_id 回传给 session affinity 元数据", async () => {
    const api = makeAdapter([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      {
        event: "response.output_item.done",
        data: {
          item: {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{\"q\":\"x\"}",
          },
        },
      },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_1",
            output: [{
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: "{\"q\":\"x\"}",
            }],
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        },
      },
    ]);

    const metadataCallIds: string[] = [];
    const result = await collectPassthrough(
      api,
      new Response(null),
      "codex",
      undefined,
      undefined,
      (metadata) => metadataCallIds.push(...(metadata.functionCallIds ?? [])),
    );

    expect(result.responseId).toBe("resp_1");
    expect(metadataCallIds).toEqual(["call_1"]);
  });
});
