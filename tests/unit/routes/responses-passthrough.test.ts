import { describe, expect, it } from "vitest";
import type { CodexSSEEvent } from "@src/proxy/codex-api.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import { collectPassthrough } from "@src/routes/responses.js";

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
