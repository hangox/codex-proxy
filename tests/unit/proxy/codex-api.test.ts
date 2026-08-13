/**
 * Tests for CodexApi SSE parsing.
 * Migrated from src/proxy/__tests__/ with @src/ path aliases.
 */

// Mock transport for createResponse and getModels tests
vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: vi.fn(),
    get: vi.fn(),
    isImpersonate: vi.fn(() => false),
    simplePost: vi.fn(),
  })),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
    // compact 协议开关：auto = 纯 v2、无自动回落（产品默认值）。
    // 需要验 v1 分支的用例自己改这个 mock 的返回值。
    model: { compact_protocol: "auto" },
  })),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
  buildHeadersWithContentType: vi.fn(() => ({ "Content-Type": "application/json" })),
}));

const { mockCreateWebSocketResponse } = vi.hoisted(() => ({
  mockCreateWebSocketResponse: vi.fn(),
}));

vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: mockCreateWebSocketResponse,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexApi, CodexApiError, type CodexSSEEvent } from "@src/proxy/codex-api.js";
import { mockResponse, sseChunk } from "@helpers/sse.js";
import { getTransport } from "@src/tls/transport.js";
import { getConfig } from "@src/config.js";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";

/** Collect all events from parseStream into an array. */
async function collectEvents(api: CodexApi, response: Response): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const evt of api.parseStream(response)) {
    events.push(evt);
  }
  return events;
}

function createApi(): CodexApi {
  return new CodexApi("test-token", null);
}

function compactV2Stream(
  item: Record<string, unknown> = {
    id: "cmp_1",
    type: "compaction",
    encrypted_content: "opaque-v2",
  },
): Response {
  return mockResponse(
    sseChunk("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    }) +
    sseChunk("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_compact_1",
        usage: {
          input_tokens: 47,
          input_tokens_details: { cached_tokens: 11 },
          output_tokens: 39,
          output_tokens_details: { reasoning_tokens: 7 },
        },
      },
    }),
  );
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
    expect(typeof events[0].data).toBe("string");
  });

  it("skips empty blocks between events", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"a"}\n\n' +
      "\n\n" +
      'event: response.output_text.delta\ndata: {"delta":"b"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(2);
  });

  it("processes remaining buffer after stream ends", async () => {
    const api = createApi();
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
    expect(events[0].data).toEqual({ delta: "multi-line" });
  });

  it("returns null body error", async () => {
    const api = createApi();
    const response = new Response(null);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("Response body is null");
  });

  it("throws on buffer overflow (>64MB)", async () => {
    // Buffer cap was raised to 64 MB to accommodate 4K image_generation_call
    // events (base64-encoded 8 MP PNG can be 10-15 MB per single event).
    const api = createApi();
    const hugeData = "x".repeat(65 * 1024 * 1024);
    const response = mockResponse(hugeData);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("SSE buffer exceeded");
  });
});

// ── parseStream — non-SSE response detection ──────────────────────

describe("CodexApi.parseStream — non-SSE responses", () => {
  it("yields error event for non-SSE JSON response with detail field", async () => {
    const api = createApi();
    const response = mockResponse('{"detail":"Invalid model"}');

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.code).toBe("non_sse_response");
    expect(data.error.message).toBe("Invalid model");
  });

  it("yields error event for non-SSE JSON response with error.message field", async () => {
    const api = createApi();
    const response = mockResponse('{"error":{"message":"Something went wrong"}}');

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.message).toBe("Something went wrong");
  });

  it("yields error event for non-SSE plain text response", async () => {
    const api = createApi();
    const response = mockResponse("Upstream error: service unavailable");

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.code).toBe("non_sse_response");
    expect(data.error.message).toBe("Upstream error: service unavailable");
  });

  it("yields nothing for empty response body", async () => {
    const api = createApi();
    const response = mockResponse("");

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(0);
  });
});

// ── createResponse error handling ─────────────────────────────────

describe("CodexApi.createResponse", () => {
  function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
    return {
      post: vi.fn(),
      get: vi.fn(),
      simplePost: vi.fn(),
      isImpersonate: vi.fn(() => false),
      ...overrides,
    } as unknown as TlsTransport;
  }

  it("throws CodexApiError on non-2xx status", async () => {
    const errorBody = '{"detail":"Unauthorized"}';
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 401,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(errorBody));
              controller.close();
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse),
      ),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const request = {
      model: "gpt-5.4",
      instructions: "test",
      input: [{ role: "user" as const, content: "Hi" }],
      stream: true as const,
      store: false as const,
    };

    await expect(api.createResponse(request)).rejects.toThrow(CodexApiError);
    try {
      await api.createResponse(request);
    } catch (e) {
      const err = e as CodexApiError;
      expect(err.status).toBe(401);
      expect(err.body).toBe(errorBody);
    }
  });

  it("truncates error body exceeding 1MB", async () => {
    const largeBody = "x".repeat(2 * 1024 * 1024); // 2MB
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 500,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              // Send in chunks to simulate streaming
              const encoder = new TextEncoder();
              const chunkSize = 256 * 1024;
              for (let i = 0; i < largeBody.length; i += chunkSize) {
                controller.enqueue(encoder.encode(largeBody.slice(i, i + chunkSize)));
              }
              controller.close();
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse),
      ),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const request = {
      model: "gpt-5.4",
      instructions: "test",
      input: [{ role: "user" as const, content: "Hi" }],
      stream: true as const,
      store: false as const,
    };

    try {
      await api.createResponse(request);
    } catch (e) {
      const err = e as CodexApiError;
      expect(err.status).toBe(500);
      // Body should be capped at 1MB
      expect(err.body.length).toBeLessThanOrEqual(1024 * 1024);
    }
  });
});

// ── createCompactResponse v2 ─────────────────────────────────────

describe("CodexApi.createCompactResponse", () => {
  function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
    return {
      post: vi.fn(),
      get: vi.fn(),
      simplePost: vi.fn(),
      isImpersonate: vi.fn(() => false),
      ...overrides,
    } as unknown as TlsTransport;
  }

  beforeEach(() => {
    mockCreateWebSocketResponse.mockReset();
  });

  it("prefers /responses v2, appends the trigger, retains user messages, and normalizes usage", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(compactV2Stream());
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);
    const api = createApi();

    const result = await api.createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [
        { role: "system", content: "system" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "assistant" },
        { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { role: "user", content: "latest user" },
      ],
      service_tier: "fast",
      prompt_cache_key: "compact-thread",
    });

    expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
    const wsUrl = mockCreateWebSocketResponse.mock.calls[0][0] as string;
    const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
      input: unknown[];
      service_tier?: string;
    };
    expect(wsUrl).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(wsRequest.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(wsRequest.service_tier).toBe("priority");
    expect(transport.post).not.toHaveBeenCalled();
    expect(result).toEqual({
      output: [
        { role: "user", content: "first user" },
        { role: "user", content: "latest user" },
        { id: "cmp_1", type: "compaction", encrypted_content: "opaque-v2" },
      ],
      // 对外自描述字段：v1/v2 的 output 语义不同而端点和字段名都没变，
      // 外部调用方只能靠它判别形状（旧客户端会把 {type:"compaction"} 当成
      // Other 丢掉，整段历史静默消失）。
      compaction_protocol: "v2",
      usage: {
        input_tokens: 47,
        output_tokens: 39,
        cached_tokens: 11,
        reasoning_tokens: 7,
      },
    });
  });

  it("compact_protocol: \"v1\" 直接走 legacy 端点，压根不先试 v2", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      api: { base_url: "https://chatgpt.com/backend-api" },
      client: { app_version: "1.0.0" },
      model: { compact_protocol: "v1" },
    } as unknown as ReturnType<typeof getConfig>);
    const transport = makeMockTransport({
      post: vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: mockResponse(JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "legacy" }],
        })).body!,
        setCookieHeaders: [],
      } satisfies TlsTransportResponse),
    });
    vi.mocked(getTransport).mockReturnValue(transport);

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [{ role: "user", content: "history" }],
    });

    // 关键：没有「先试 v2 再回落」，v2 一次都没发起过。
    expect(mockCreateWebSocketResponse).not.toHaveBeenCalled();
    expect(transport.post).toHaveBeenCalledOnce();
    expect(vi.mocked(transport.post).mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/responses/compact",
    );
    expect(result.output).toEqual([{ type: "reasoning", encrypted_content: "legacy" }]);
  });

  // ★ 这条替换了原来的「只在 trigger 明确不被支持时才回落 v1」。
  //
  // 原测试有两个问题，都不是断言写错、是**前提**就不成立：
  // 1. 它用 mockRejectedValue(CodexApiError(400, code=invalid_value)) 制造上游
  //    错误，但 ws-transport.ts 的 ROTATABLE_ERROR_CODES 里没有 invalid_value
  //    ——真实传输下这类错误是**流内 SSE error 帧**，不是 reject。验的不是
  //    生产路径。
  // 2. 它验的「自动回落」行为本身已经被删掉了：回落判据只能来自上游错误文案，
  //    而「从错误文案反推上游支不支持某能力」被实测证明会把「请求构造错了」
  //    误判成「端点被下掉了」（`compaction_trigger must be the last input item`
  //    同时命中 invalid 和 compaction_trigger）。
  //
  // 现在按真实传输形态重写：错误以流内 error 帧出现，且**不得**触发第二次请求。
  it("auto 下流内 error 帧（哪怕文案里同时出现 invalid 和 compaction_trigger）也不回落 v1", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(mockResponse(
      sseChunk("error", {
        error: {
          code: "invalid_value",
          message: "Invalid value for 'input': compaction_trigger must be the last input item",
        },
      }),
    ));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [{ role: "user", content: "history" }],
    })).rejects.toMatchObject({ status: 400 });

    // 决定性断言：没有第二次上游请求。此前这条会被判成「v2 不可用」→ 打一次
    // 注定 404 的 v1 → 客户端看到 404，而真实原因是 400 参数位置放错。
    expect(transport.post).not.toHaveBeenCalled();
  });

  // ★ F9：v2 的 compact 走的是和普通请求同一条 WS 通道，上游会在流里发
  // `codex.rate_limits` 帧。此前 createCompactResponse 压根没有 onRateLimits
  // 这个参数，这些帧被直接丢弃——账号池的额度视图漏掉所有 compact 消耗的
  // 配额，用得越多偏得越远。
  it("把上游的 rate limit 回调透传下去（compact 消耗的配额不能从账号池视图里消失）", async () => {
    mockCreateWebSocketResponse.mockImplementation(
      (_url: unknown, _headers: unknown, _req: unknown, _signal: unknown, _proxy: unknown,
       onRateLimits?: (rl: unknown) => void) => {
        onRateLimits?.({ primary: { usedPercent: 42 } });
        return Promise.resolve(compactV2Stream());
      },
    );
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    const seen: unknown[] = [];
    await createApi().createCompactResponse(
      { model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "hi" }] },
      undefined,
      (rl) => seen.push(rl),
    );

    expect(seen).toEqual([{ primary: { usedPercent: 42 } }]);
  });

  it("does not fall back after quota errors", async () => {
    mockCreateWebSocketResponse.mockRejectedValue(
      new CodexApiError(429, JSON.stringify({
        error: { code: "usage_limit_reached", message: "Limit reached" },
      })),
    );
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [],
    })).rejects.toMatchObject({ status: 429 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  // ★ F5：本地装配永远不许抛 TypeError。
  //
  // `responses.ts` 的 `input: Array.isArray(body.input) ? ... : []` 只保证 input
  // 是数组，元素形状完全没校验——TS 类型在这条链路上是一厢情愿的。下面三种形状
  // 都是能真的打进来的，改之前实测分别抛：
  //   {"role":"user"}                     → Cannot read properties of undefined
  //   {"role":"user","content":123}       → item.content.reduce is not a function
  //   [{"type":"input_audio"}, 超预算文本] → Buffer.byteLength 的 "string" 参数断言
  //
  // 时机是最差的：这些都发生在 buildCompactV2Output 里，也就是**上游 compaction
  // 已成功返回、token 已经花掉之后**；抛的又是 TypeError 不是 CodexApiError，
  // 于是被 responses.ts 直接 rethrow 成未处理 500——compact 结果丢失、无分类、
  // 无 outcome 记录。v1 时代这个 body 只是原样转发给上游判 400。
  describe("非法 input 形状不得让本地装配崩掉（F5）", () => {
    const MALFORMED_INPUTS: ReadonlyArray<readonly [string, unknown[]]> = [
      ["user item 完全没有 content", [{ role: "user" }]],
      ["content 是数字不是 string/数组", [{ role: "user", content: 123 }]],
      ["未知 part 没有 text 字段，且同条消息超出保留预算", [{
        role: "user",
        content: [{ type: "input_audio" }, { type: "input_text", text: "x".repeat(300_000) }],
      }]],
    ];

    for (const [name, input] of MALFORMED_INPUTS) {
      it(name, async () => {
        mockCreateWebSocketResponse.mockResolvedValue(compactV2Stream());
        const transport = makeMockTransport();
        vi.mocked(getTransport).mockReturnValue(transport);

        const result = await createApi().createCompactResponse({
          model: "gpt-5.4",
          instructions: "compact",
          input: input as never,
        });

        // 不崩、且 compaction item 仍然是压缩产物段的最后一项。
        expect(result.output.at(-1)).toMatchObject({ type: "compaction" });
      });
    }
  });

  it("auto 下 HTTP 404 原样上抛，不吞成「v2 不可用」——CF path-block 的自愈依赖它", async () => {
    // /codex/responses 是所有普通请求都在打的端点，它返回空 body 404 的真实
    // 含义是 Cloudflare path-block，不可能是「v2 不被支持」。吞掉会让
    // proxy-error-handler 那套清 cookie / 计数 / 禁用账号的恢复逻辑失效。
    mockCreateWebSocketResponse.mockRejectedValue(new CodexApiError(404, ""));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [{ role: "user", content: "history" }],
    })).rejects.toMatchObject({ status: 404 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("rejects a completed v2 response without a compaction item instead of spending again on v1", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(mockResponse(
      sseChunk("response.output_item.done", {
        item: { type: "message", role: "assistant", content: [] },
      }) + sseChunk("response.completed", {
        response: { id: "resp_bad", usage: { input_tokens: 4, output_tokens: 2 } },
      }),
    ));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [],
    })).rejects.toMatchObject({ status: 502 });
    expect(transport.post).not.toHaveBeenCalled();
  });
});

// ── getModels ─────────────────────────────────────────────────────

describe("CodexApi.getModels", () => {
  function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
    return {
      post: vi.fn(),
      get: vi.fn(),
      simplePost: vi.fn(),
      isImpersonate: vi.fn(() => false),
      ...overrides,
    } as unknown as TlsTransport;
  }

  it("returns null when all endpoints fail", async () => {
    const mockTransport = makeMockTransport({
      get: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const result = await api.getModels();

    expect(result).toBeNull();
    // Should have probed all 3 endpoints
    expect(mockTransport.get).toHaveBeenCalledTimes(3);
  });

  it("flattens nested categories structure", async () => {
    const mockTransport = makeMockTransport({
      get: vi.fn().mockResolvedValue({
        body: JSON.stringify({
          categories: [
            {
              models: [
                { slug: "gpt-5.4", display_name: "GPT-5.4" },
                { slug: "gpt-5.3-codex", display_name: "Codex" },
              ],
            },
            {
              models: [
                { slug: "gpt-5.2", display_name: "GPT-5.2" },
              ],
            },
          ],
        }),
      }),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const result = await api.getModels();

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toMatchObject({ slug: "gpt-5.4" });
    expect(result![1]).toMatchObject({ slug: "gpt-5.3-codex" });
    expect(result![2]).toMatchObject({ slug: "gpt-5.2" });
  });
});
