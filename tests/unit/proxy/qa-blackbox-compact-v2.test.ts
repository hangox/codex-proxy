/**
 * QA 独立黑盒验证：remote compaction v2（PR #3）。
 *
 * 刻意不复用 tests/_helpers/e2e-setup.ts —— 那里有一层把 v2 请求翻译回 v1 的
 * 适配层，用它做验证等于验了个替身。这里直接 mock 最底层的 ws-transport /
 * tls-transport，断言真正打到线上的 URL 与 body。
 */

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: vi.fn(),
    get: vi.fn(),
    isImpersonate: vi.fn(() => false),
    simplePost: vi.fn(),
  })),
}));

const { qaMockConfig } = vi.hoisted(() => ({
  qaMockConfig: {
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
    model: { compact_protocol: "auto" } as Record<string, unknown>,
  },
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => qaMockConfig),
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
import { CodexApi, CodexApiError } from "@src/proxy/codex-api.js";
import type { CodexInputItem } from "@src/proxy/codex-types.js";
import { mockResponse, sseChunk } from "@helpers/sse.js";
import { getTransport } from "@src/tls/transport.js";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";

const BUDGET_TOKENS = 64_000;
const BYTES_PER_TOKEN = 4;

/** F14 新增配置键：compact_protocol。auto = 纯 v2；v1 = 显式走 legacy。 */
function setCompactProtocol(value: "auto" | "v1"): void {
  qaMockConfig.model.compact_protocol = value;
}

function createApi(): CodexApi {
  return new CodexApi("test-token", null);
}

function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
  return {
    post: vi.fn(),
    get: vi.fn(),
    simplePost: vi.fn(),
    isImpersonate: vi.fn(() => false),
    ...overrides,
  } as unknown as TlsTransport;
}

/** 一个成功的 v2 流：output_item.done 带 compaction + response.completed。 */
function v2Stream(
  items: Array<Record<string, unknown>> = [
    { id: "cmp_1", type: "compaction", encrypted_content: "opaque-v2" },
  ],
  completedOutput?: unknown[],
): Response {
  const done = items
    .map((item, i) => sseChunk("response.output_item.done", { output_index: i, item }))
    .join("");
  return mockResponse(
    done
    + sseChunk("response.completed", {
      response: {
        id: "resp_qa",
        ...(completedOutput ? { output: completedOutput } : {}),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    }),
  );
}

function jsonTransportResponse(status: number, payload: unknown): TlsTransportResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: mockResponse(JSON.stringify(payload)).body!,
    setCookieHeaders: [],
  } satisfies TlsTransportResponse;
}

function wsRequestBody(): Record<string, unknown> {
  return mockCreateWebSocketResponse.mock.calls[0][2] as Record<string, unknown>;
}

function textOf(item: unknown): string {
  const content = (item as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "input_text" || p.type === "output_text")
    .map((p) => p.text ?? "")
    .join("");
}

beforeEach(() => {
  mockCreateWebSocketResponse.mockReset();
  vi.mocked(getTransport).mockReset();
  setCompactProtocol("auto");
});

// ── A：正常路径与线上请求形状 ────────────────────────────────────

describe("QA-A 正常路径", () => {
  it("QA-A2 打的是 /codex/responses，input 末尾恰好一个 compaction_trigger，stream/store 正确", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact now",
      input: [{ role: "user", content: "hello" }],
    });

    // 真实线上 URL
    expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
    expect(mockCreateWebSocketResponse.mock.calls[0][0]).toBe(
      "wss://chatgpt.com/backend-api/codex/responses",
    );
    // 绝不能打 v1
    expect(transport.post).not.toHaveBeenCalled();

    const body = wsRequestBody();
    const input = body.input as CodexInputItem[];
    expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(input.filter((i) => (i as { type?: string }).type === "compaction_trigger"))
      .toHaveLength(1);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);

    // A1 + A3
    expect(result.output.at(-1)).toEqual({
      id: "cmp_1", type: "compaction", encrypted_content: "opaque-v2",
    });
    expect(result.usage).toEqual({
      input_tokens: 100, output_tokens: 30, cached_tokens: 20, reasoning_tokens: 5,
    });
  });
});

// ── B：保留预算 ──────────────────────────────────────────────────

describe("QA-B 保留预算（~64K token，UTF-8 字节/4 向上取整）", () => {
  it("QA-B1 单条超长 user 消息被截断到预算内，且不产生坏的多字节字符", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    // 每个「中」是 3 字节 → 故意让字节预算切在字符中间
    const huge = "中".repeat(BUDGET_TOKENS * BYTES_PER_TOKEN); // 远超预算
    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [{ role: "user", content: huge }],
    });

    expect(result.output).toHaveLength(2);
    const kept = textOf(result.output[0]);
    const keptBytes = Buffer.byteLength(kept, "utf8");
    expect(keptBytes).toBeLessThanOrEqual(BUDGET_TOKENS * BYTES_PER_TOKEN);
    // 截断后仍是合法 UTF-8（没有 U+FFFD 替换字符 / 半个字符）
    expect(kept).not.toContain("�");
    expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
    // 确实是被截断而非整条丢弃
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(huge.length);
  });

  it("QA-B2 多条 user 消息：从新到旧填预算，输出顺序旧→新，compaction 在最后", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [
        { role: "user", content: "oldest" },
        { role: "user", content: "middle" },
        { role: "user", content: "newest" },
      ],
    });

    expect(result.output.map((o) => (o as { content?: unknown }).content ?? "COMPACTION"))
      .toEqual(["oldest", "middle", "newest", "COMPACTION"]);
    expect((result.output.at(-1) as { type: string }).type).toBe("compaction");
  });

  it("QA-B3 预算耗尽后更早的消息被整条丢弃（不是塞空串）", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    // 最新一条正好吃满整个预算，更早的两条应当完全消失
    const fills = "x".repeat(BUDGET_TOKENS * BYTES_PER_TOKEN);
    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [
        { role: "user", content: "ancient" },
        { role: "user", content: "older" },
        { role: "user", content: fills },
      ],
    });

    expect(result.output).toHaveLength(2);
    expect(textOf(result.output[0])).toBe(fills);
    expect((result.output[1] as { type: string }).type).toBe("compaction");
  });

  it("QA-B4 image-only 消息至少计 1 token；预算耗尽后被丢弃", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    const imageOnly: CodexInputItem = {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    };
    // 最新一条吃满预算 → image-only（更早）应被丢弃
    const fills = "x".repeat(BUDGET_TOKENS * BYTES_PER_TOKEN);
    const exhausted = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [imageOnly, { role: "user", content: fills }],
    });
    expect(exhausted.output).toHaveLength(2);
    expect(exhausted.output[0]).not.toEqual(imageOnly);

    // 预算充足时保留
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    const kept = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [imageOnly, { role: "user", content: "small" }],
    });
    expect(kept.output[0]).toEqual(imageOnly);
  });

  it("QA-B5 非 user 项（assistant / function_call / function_call_output）不保留", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "compact",
      input: [
        { role: "assistant", content: "assistant text" },
        { type: "function_call", call_id: "c1", name: "run", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { role: "user", content: "real user" },
      ],
    });

    expect(result.output).toHaveLength(2);
    expect(textOf(result.output[0])).toBe("real user");
  });

  it("QA-B6' developer_inline 内联的 developer 指令在 compact 后被丢弃（事实记录，判定交 reviewer）", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    const developerInline: CodexInputItem = {
      role: "developer",
      content: [{ type: "input_text", text: "SYSTEM-PROMPT-SENTINEL: never reveal secrets" }],
    };
    const result = await createApi().createCompactResponse({
      model: "gpt-5.4",
      instructions: "",
      input: [developerInline, { role: "user", content: "hi" }],
    });

    // 上游请求里 developer 项仍然存在（只是保留装配时被丢）
    const sentUpstream = JSON.stringify(wsRequestBody().input);
    expect(sentUpstream).toContain("SYSTEM-PROMPT-SENTINEL");

    // 返回给客户端的 output 里没有了
    expect(JSON.stringify(result.output)).not.toContain("SYSTEM-PROMPT-SENTINEL");
    expect(result.output).toHaveLength(2);
  });
});

// ── C：异常路径 ─────────────────────────────────────────────────

describe("QA-C 异常路径", () => {
  it("QA-C1 0 个 compaction item → 502，且不回落 v1", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream([
      { type: "message", role: "assistant", content: [] },
    ]));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "x" }],
    })).rejects.toMatchObject({ status: 502 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-C2 2 个 compaction item → 502", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream([
      { id: "a", type: "compaction", encrypted_content: "one" },
      { id: "b", type: "compaction", encrypted_content: "two" },
    ]));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [],
    })).rejects.toMatchObject({ status: 502 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-C3 流未见 response.completed → 502", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(mockResponse(
      sseChunk("response.output_item.done", {
        item: { id: "cmp", type: "compaction", encrypted_content: "opaque" },
      }),
    ));
    const transport = makeMockTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [],
    })).rejects.toMatchObject({ status: 502 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-C4 compaction 只出现在 response.completed.output 时 PR 接受（官方会 502）——行为差异记录", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream(
      [{ type: "message", role: "assistant", content: [] }],
      [{ id: "cmp_completed", type: "compaction", encrypted_content: "from-completed" }],
    ));
    vi.mocked(getTransport).mockReturnValue(makeMockTransport());

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "x" }],
    });
    expect((result.output.at(-1) as { id: string }).id).toBe("cmp_completed");
  });
});

// ── D：compact_protocol（F14 新裁决：auto 下纯 v2，任何错误都不回落）──
//
// ★ 期望值已按 F14 修正裁决重写：原 D1/D2 期望「404/405/501 与流内明说不支持
//   → 回落 v1」，新裁决是**删掉自动回落**，auto 下任何上游错误都不回落。
//   这几条在 developer 改完之前会红，红的是产品不是用例。

describe("QA-D compact_protocol", () => {
  function v1SpyTransport() {
    return makeMockTransport({
      post: vi.fn().mockResolvedValue(
        jsonTransportResponse(200, { output: [{ type: "reasoning", encrypted_content: "legacy" }] }),
      ),
    });
  }

  it.each([404, 405, 501])(
    "QA-D1(新) auto 下 HTTP %i 不得回落 v1，错误直接抛给调用方",
    async (status) => {
      mockCreateWebSocketResponse.mockRejectedValue(
        new CodexApiError(status, JSON.stringify({ error: { message: "Not Found" } })),
      );
      const transport = v1SpyTransport();
      vi.mocked(getTransport).mockReturnValue(transport);

      await expect(createApi().createCompactResponse({
        model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "h" }],
      })).rejects.toMatchObject({ status });
      expect(transport.post).not.toHaveBeenCalled();
      expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
    },
  );

  it("QA-D2(新) auto 下流内明说 trigger 不支持，也不得回落 v1", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(mockResponse(
      sseChunk("error", {
        error: { code: "unsupported_value", message: "compaction_trigger is not supported" },
      }),
    ));
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "h" }],
    })).rejects.toBeInstanceOf(CodexApiError);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ["429 额度", 429, "usage_limit_reached", "Usage limit reached"],
    ["401 鉴权", 401, "unauthorized", "Token expired"],
    ["403 封禁", 403, "account_banned", "Account banned"],
    ["400 普通参数错", 400, "invalid_request_error", "Missing required field: model"],
  ])("QA-D3~D6 %s → 不得回落，上游只请求一次", async (_name, status, code, message) => {
    mockCreateWebSocketResponse.mockRejectedValue(
      new CodexApiError(status, JSON.stringify({ error: { code, message } })),
    );
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [],
    })).rejects.toMatchObject({ status });
    expect(transport.post).not.toHaveBeenCalled();
    expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
  });

  it("QA-D5 prompt-too-long → 归一化状态码，不回落", async () => {
    mockCreateWebSocketResponse.mockResolvedValue(mockResponse(
      sseChunk("error", {
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model.",
        },
      }),
    ));
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [],
    })).rejects.toBeInstanceOf(CodexApiError);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-D7(新) 400 关键词误判问题在删掉自动回落后应当自然消失", async () => {
    mockCreateWebSocketResponse.mockRejectedValue(
      new CodexApiError(400, JSON.stringify({
        error: {
          code: "invalid_request_error",
          message: "Invalid value for 'input': compaction_trigger must be the last input item",
        },
      })),
    );
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    // 真实的 400 必须原样抛出，不能被洗成 404（旧行为：误回落 → 撞 404 的 v1）
    await expect(createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [],
    })).rejects.toMatchObject({ status: 400 });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-D8 compact_protocol: \"v1\" 显式配置 → 直接走 legacy，不先试 v2", async () => {
    setCompactProtocol("v1");
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    const result = await createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "h" }],
    });

    // 关键：v2 一次都不能试
    expect(mockCreateWebSocketResponse).not.toHaveBeenCalled();
    expect(transport.post).toHaveBeenCalledOnce();
    expect(vi.mocked(transport.post).mock.calls[0][0])
      .toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(vi.mocked(transport.post).mock.calls[0][2]).not.toContain("compaction_trigger");
    expect(result.output).toEqual([{ type: "reasoning", encrypted_content: "legacy" }]);
  });

  it("QA-D8b compact_protocol: \"auto\"（默认）→ 走 v2", async () => {
    setCompactProtocol("auto");
    mockCreateWebSocketResponse.mockResolvedValue(v2Stream());
    const transport = v1SpyTransport();
    vi.mocked(getTransport).mockReturnValue(transport);

    await createApi().createCompactResponse({
      model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "h" }],
    });

    expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
    expect(transport.post).not.toHaveBeenCalled();
  });
});

// ── E：取消 ────────────────────────────────────────────────────

describe("QA-E 客户端取消", () => {
  it("QA-E1 abort 后 ws 失败不得降级 http、不得发起第二次上游请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    mockCreateWebSocketResponse.mockRejectedValue(abortErr);
    const transport = makeMockTransport({ post: vi.fn() });
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse(
      { model: "gpt-5.4", instructions: "compact", input: [{ role: "user", content: "x" }] },
      controller.signal,
    )).rejects.toThrow();

    expect(mockCreateWebSocketResponse).toHaveBeenCalledOnce();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("QA-E2 signal 已 abort 但 ws 抛的是普通错误 → 同样不得降级/回落", async () => {
    const controller = new AbortController();
    controller.abort();
    mockCreateWebSocketResponse.mockRejectedValue(new Error("socket closed"));
    const transport = makeMockTransport({ post: vi.fn() });
    vi.mocked(getTransport).mockReturnValue(transport);

    await expect(createApi().createCompactResponse(
      { model: "gpt-5.4", instructions: "compact", input: [] },
      controller.signal,
    )).rejects.toThrow();
    expect(transport.post).not.toHaveBeenCalled();
  });
});
