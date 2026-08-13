import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";
import type { CodexCompactRequest, CodexResponsesRequest } from "@src/proxy/codex-types.js";

// Mock fingerprint — return minimal headers
vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: () => ({ Authorization: "Bearer test-token" }),
  buildHeadersWithContentType: () => ({
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
  }),
}));

// Mock config
vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    api: { base_url: "https://test.example" },
    // compact 走哪个协议由 model.compact_protocol 决定（auto = 纯 v2）。
    // 真实 config 经 Zod 解析后这个字段一定有值（schema 有 default），
    // 这里补上是因为这份 mock 只捡了当时用得到的字段。
    model: { compact_protocol: "auto" },
  }),
}));

// Mock installation_id (deterministic value)
vi.mock("@src/proxy/installation-id.js", () => ({
  getInstallationId: () => "11111111-2222-3333-4444-555555555555",
}));

// Capture createWebSocketResponse calls
const mockCreateWebSocketResponse = vi.fn<
  (...args: unknown[]) => Promise<Response>
>();
vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: (...args: unknown[]) =>
    mockCreateWebSocketResponse(...args),
}));

function makeTransport(): TlsTransport & {
  lastHeaders: Record<string, string> | null;
  lastBody: string | null;
} {
  const t = {
    lastHeaders: null as Record<string, string> | null,
    lastBody: null as string | null,
    post: vi.fn(
      async (
        _url: string,
        headers: Record<string, string>,
        body: string,
      ): Promise<TlsTransportResponse> => {
        t.lastHeaders = headers;
        t.lastBody = body;
        const encoder = new TextEncoder();
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode('{"output":[]}'));
              c.close();
            },
          }),
          setCookieHeaders: [],
        };
      },
    ),
    get: vi.fn(),
    isImpersonate: () => false,
  };
  return t;
}

function makeRequest(overrides?: Partial<CodexResponsesRequest>): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    instructions: "test",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...overrides,
  };
}

function makeCompactV2Response(): Response {
  const item = { id: "cmp_headers", type: "compaction", encrypted_content: "opaque" };
  const body =
    `event: response.output_item.done\ndata: ${JSON.stringify({ item })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      response: { id: "resp_headers", usage: { input_tokens: 10, output_tokens: 2 } },
    })}\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("codex-api headers", () => {
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = makeTransport();
  });

  // Lazy import to let mocks register first
  async function createApi() {
    const { CodexApi } = await import("@src/proxy/codex-api.js");
    return new CodexApi("test-token", "acct-1", null, "e1", null, "https://test.example", transport);
  }

  describe("HTTP SSE path", () => {
    it("sends x-openai-internal-codex-residency: us", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-openai-internal-codex-residency"]).toBe("us");
    });

    it("sends x-client-request-id in UUID format", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("sends x-codex-turn-state when turnState is present", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ turnState: "abc123" }));
      expect(transport.lastHeaders!["x-codex-turn-state"]).toBe("abc123");
    });

    it("omits x-codex-turn-state when turnState is absent", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-codex-turn-state"]).toBeUndefined();
    });

    it("excludes turnState from JSON body and maps fast service_tier to priority", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ turnState: "abc", service_tier: "fast" }),
      );
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.turnState).toBeUndefined();
      expect(body.service_tier).toBe("priority");
    });

    it("preserves non-fast service_tier in JSON body", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ service_tier: "flex" }));
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.service_tier).toBe("flex");
    });

    it("sends x-codex-installation-id header and inside body.client_metadata", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest());
      expect(transport.lastHeaders!["x-codex-installation-id"]).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("preserves caller-provided client_metadata fields and only injects installation id", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ client_metadata: { "x-custom": "v1" } }),
      );
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-custom": "v1",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("sends x-openai-subagent header for review requests", async () => {
      const api = await createApi();
      await api.createResponse(
        makeRequest({ client_metadata: { "x-openai-subagent": "review" } }),
      );

      expect(transport.lastHeaders!["x-openai-subagent"]).toBe("review");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata["x-openai-subagent"]).toBe("review");
    });

    it("uses prompt_cache_key as Codex conversation identity", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({ prompt_cache_key: "thread-123" }));

      expect(transport.lastHeaders!["x-client-request-id"]).toBe("thread-123");
      expect(transport.lastHeaders!["session_id"]).toBe("thread-123");
      expect(transport.lastHeaders!["x-codex-window-id"]).toBe("thread-123:0");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata["x-codex-window-id"]).toBe("thread-123:0");
    });

    it("forwards Codex review context headers and metadata", async () => {
      const api = await createApi();
      await api.createResponse(makeRequest({
        turnMetadata: "{\"thread_source\":\"subagent\"}",
        betaFeatures: "feature-a",
        includeTimingMetrics: "true",
        version: "26.318.11754",
        codexWindowId: "thread-123:1",
        parentThreadId: "parent-123",
      }));

      expect(transport.lastHeaders!["x-codex-turn-metadata"]).toBe("{\"thread_source\":\"subagent\"}");
      expect(transport.lastHeaders!["x-codex-beta-features"]).toBe("feature-a");
      expect(transport.lastHeaders!["x-responsesapi-include-timing-metrics"]).toBe("true");
      expect(transport.lastHeaders!["Version"]).toBe("26.318.11754");
      expect(transport.lastHeaders!["x-codex-window-id"]).toBe("thread-123:1");
      expect(transport.lastHeaders!["x-codex-parent-thread-id"]).toBe("parent-123");
      const body = JSON.parse(transport.lastBody!) as { client_metadata: Record<string, string> };
      expect(body.client_metadata).toMatchObject({
        "x-codex-turn-metadata": "{\"thread_source\":\"subagent\"}",
        "x-codex-window-id": "thread-123:1",
        "x-codex-parent-thread-id": "parent-123",
      });
    });
  });

  describe("Compact path", () => {
    it("forwards identity, context headers, metadata, and strips internal fields", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(makeCompactV2Response());
      const api = await createApi();
      const request: CodexCompactRequest = {
        model: "gpt-5.4",
        instructions: "compact",
        input: [{ role: "user", content: "history" }],
        prompt_cache_key: "compact-thread",
        service_tier: "fast",
        client_metadata: { "x-custom": "compact" },
        turnState: "compact-turn-state",
        turnMetadata: "{\"source\":\"compact\"}",
        betaFeatures: "compact-beta",
        version: "26.7.25",
        includeTimingMetrics: "true",
        codexWindowId: "compact-window",
        parentThreadId: "compact-parent",
      };

      await api.createCompactResponse(request);

      expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
      const wsUrl = mockCreateWebSocketResponse.mock.calls[0][0] as string;
      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      const body = mockCreateWebSocketResponse.mock.calls[0][2] as Record<string, unknown>;
      expect(wsUrl).toBe("wss://test.example/codex/responses");
      expect(headers).toMatchObject({
        "x-client-request-id": "compact-thread",
        session_id: "compact-thread",
        "x-codex-window-id": "compact-window",
        "x-codex-turn-state": "compact-turn-state",
        "x-codex-turn-metadata": "{\"source\":\"compact\"}",
        // v2 的 compact 请求必须**主动声明** remote_compaction_v2（官方客户端
        // 每次都带），同时保留入站已有的 feature、按逗号拼接且不重复。
        "x-codex-beta-features": "compact-beta,remote_compaction_v2",
        "x-responsesapi-include-timing-metrics": "true",
        Version: "26.7.25",
        "x-codex-parent-thread-id": "compact-parent",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
      expect(body.service_tier).toBe("priority");
      expect(body.prompt_cache_key).toBe("compact-thread");
      expect(body.input).toEqual([
        { role: "user", content: "history" },
        { type: "compaction_trigger" },
      ]);
      expect(body.client_metadata).toMatchObject({
        "x-custom": "compact",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
        "x-codex-turn-metadata": "{\"source\":\"compact\"}",
        "x-codex-window-id": "compact-window",
        "x-codex-parent-thread-id": "compact-parent",
      });
      for (const internal of [
        "turnState", "turnMetadata", "betaFeatures", "version",
        "includeTimingMetrics", "codexWindowId", "parentThreadId",
      ]) {
        expect(body[internal]).toBeUndefined();
      }
      expect(transport.post).not.toHaveBeenCalled();
    });

    it("derives the default compact window identity from prompt_cache_key", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(makeCompactV2Response());
      const api = await createApi();
      await api.createCompactResponse({
        model: "gpt-5.4",
        instructions: "compact",
        input: [],
        prompt_cache_key: "compact-default-window",
      });

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      const body = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(headers["x-codex-window-id"]).toBe("compact-default-window:0");
      expect(body.client_metadata?.["x-codex-window-id"]).toBe("compact-default-window:0");
      expect(transport.post).not.toHaveBeenCalled();
    });
  });

  describe("WebSocket path", () => {
    it("sends residency, request-id, and turn-state headers", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          previous_response_id: "resp_prev",
          useWebSocket: true,
          turnState: "ws_turn_abc",
        }),
      );

      expect(mockCreateWebSocketResponse).toHaveBeenCalledTimes(1);
      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-openai-internal-codex-residency"]).toBe("us");
      expect(headers["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(headers["x-codex-turn-state"]).toBe("ws_turn_abc");
      expect(headers["x-codex-installation-id"]).toBe(
        "11111111-2222-3333-4444-555555555555",
      );
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata).toMatchObject({
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("preserves review subagent metadata on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          client_metadata: { "x-openai-subagent": "review" },
        }),
      );

      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-openai-subagent"]).toBe("review");
      expect(wsRequest.client_metadata).toMatchObject({
        "x-openai-subagent": "review",
        "x-codex-installation-id": "11111111-2222-3333-4444-555555555555",
      });
    });

    it("maps fast service_tier to priority on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          service_tier: "fast",
        }),
      );

      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        service_tier?: string;
      };
      expect(wsRequest.service_tier).toBe("priority");
    });

    it("uses prompt_cache_key as WebSocket conversation identity", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          prompt_cache_key: "thread-456",
        }),
      );

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-client-request-id"]).toBe("thread-456");
      expect(headers["session_id"]).toBe("thread-456");
      expect(headers["x-codex-window-id"]).toBe("thread-456:0");
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata?.["x-codex-window-id"]).toBe("thread-456:0");
    });

    it("forwards Codex review context on WebSocket requests", async () => {
      mockCreateWebSocketResponse.mockResolvedValue(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const api = await createApi();
      await api.createResponse(
        makeRequest({
          useWebSocket: true,
          turnMetadata: "{\"thread_source\":\"subagent\"}",
          betaFeatures: "feature-a",
          includeTimingMetrics: "true",
          version: "26.318.11754",
          codexWindowId: "thread-456:1",
          parentThreadId: "parent-456",
        }),
      );

      const headers = mockCreateWebSocketResponse.mock.calls[0][1] as Record<string, string>;
      expect(headers["x-codex-turn-metadata"]).toBe("{\"thread_source\":\"subagent\"}");
      expect(headers["x-codex-beta-features"]).toBe("feature-a");
      expect(headers["x-responsesapi-include-timing-metrics"]).toBe("true");
      expect(headers["Version"]).toBe("26.318.11754");
      expect(headers["x-codex-window-id"]).toBe("thread-456:1");
      expect(headers["x-codex-parent-thread-id"]).toBe("parent-456");
      const wsRequest = mockCreateWebSocketResponse.mock.calls[0][2] as {
        client_metadata?: Record<string, string>;
      };
      expect(wsRequest.client_metadata).toMatchObject({
        "x-codex-turn-metadata": "{\"thread_source\":\"subagent\"}",
        "x-codex-window-id": "thread-456:1",
        "x-codex-parent-thread-id": "parent-456",
      });
    });

    it("previous_response_id 场景下 WebSocket 失败不会降级成 HTTP delta-only", async () => {
      const { PreviousResponseWebSocketError } = await import("@src/proxy/codex-api.js");
      mockCreateWebSocketResponse.mockRejectedValue(new Error("ws down"));

      const api = await createApi();
      await expect(api.createResponse(
        makeRequest({
          previous_response_id: "resp_prev",
          useWebSocket: true,
          input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
        }),
      )).rejects.toBeInstanceOf(PreviousResponseWebSocketError);

      expect(transport.post).not.toHaveBeenCalled();
    });

    it("没有 previous_response_id 时 WebSocket 失败仍可安全降级到 HTTP", async () => {
      mockCreateWebSocketResponse.mockRejectedValue(new Error("ws down"));

      const api = await createApi();
      await api.createResponse(makeRequest({ useWebSocket: true }));

      expect(transport.post).toHaveBeenCalledOnce();
      const body = JSON.parse(transport.lastBody!) as Record<string, unknown>;
      expect(body.previous_response_id).toBeUndefined();
      expect(body.useWebSocket).toBeUndefined();
    });

    it("WS 上游返回的 CodexApiError 不能降级到 HTTP（必须抛给 proxy-handler 轮转）", async () => {
      // Without re-throwing, the same account would just retry over HTTP and
      // hit the same usage_limit_reached, never rotating.
      const { CodexApiError } = await import("@src/proxy/codex-api.js");
      mockCreateWebSocketResponse.mockRejectedValue(
        new CodexApiError(429, JSON.stringify({
          type: "error",
          error: { code: "usage_limit_reached", message: "Limit reached" },
        })),
      );

      const api = await createApi();
      await expect(
        api.createResponse(makeRequest({ useWebSocket: true })),
      ).rejects.toBeInstanceOf(CodexApiError);

      expect(transport.post).not.toHaveBeenCalled();
    });
  });
});
