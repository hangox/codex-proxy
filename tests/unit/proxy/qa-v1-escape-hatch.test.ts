/**
 * QA-N：v1 逃生舱的**错误保真度**。
 *
 * 背景：`compact_protocol: "v1"`（F14 落地后）是上游哪天回滚时的逃生舱。
 * 但 v1 端点**当下在生产就是 404**，所以这个逃生舱现在等于「配了也用不了」。
 * 那么最低要求是：配成 v1 之后**行为可预期、错误原形抛出** —— 不能把 404
 * 吞成别的形状、不能悄悄退回去走 v2、不能报一个让人查错方向的错。
 * 一个行为不可预期的逃生舱比没有逃生舱更危险，因为出事时人会信它。
 *
 * ✅ F14 已落地（commit 09924fa：删掉基于错误文案的自动回落，改为显式配置）。
 * 这里已按当初的计划改成**直接配 `model.compact_protocol = "v1"`** 来驱动 v1，
 * 断言部分一字未动 —— 断言的始终是「v1 失败时客户端看到什么」，与怎么进 v1 无关。
 */

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: vi.fn(), get: vi.fn(), isImpersonate: vi.fn(() => false), simplePost: vi.fn(),
  })),
}));

const { qaMockConfig } = vi.hoisted(() => ({
  qaMockConfig: {
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
    model: { compact_protocol: "v1" } as Record<string, unknown>,
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
import { mockResponse } from "@helpers/sse.js";
import { getTransport } from "@src/tls/transport.js";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";

function createApi(): CodexApi {
  return new CodexApi("test-token", null);
}

function transportReturning(status: number, body: string): TlsTransport {
  return {
    post: vi.fn().mockResolvedValue({
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: mockResponse(body).body!,
      setCookieHeaders: [],
    } satisfies TlsTransportResponse),
    get: vi.fn(), simplePost: vi.fn(), isImpersonate: vi.fn(() => false),
  } as unknown as TlsTransport;
}

/**
 * 显式把协议配成 v1（F14 之后唯一的进 v1 方式）。
 * 同时给 v2 装一个「一旦被调用就炸」的替身 —— 配了 v1 还去碰 v2 本身就是缺陷。
 */
function selectV1Protocol(): void {
  qaMockConfig.model.compact_protocol = "v1";
  mockCreateWebSocketResponse.mockImplementation(() => {
    throw new Error("配了 compact_protocol=v1，不该再走 v2");
  });
}

const REQUEST = {
  model: "gpt-5.4",
  instructions: "compact",
  input: [{ role: "user" as const, content: "history" }],
};

beforeEach(() => {
  mockCreateWebSocketResponse.mockReset();
  vi.mocked(getTransport).mockReset();
  qaMockConfig.model.compact_protocol = "auto";
});

describe("QA-N v1 逃生舱的错误保真度", () => {
  it("QA-N1 v1 返回带 body 的 404（端点已下线）→ 客户端必须看到 404 原形，不能被改写", async () => {
    selectV1Protocol();
    const upstreamBody = JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } });
    const transport = transportReturning(404, upstreamBody);
    vi.mocked(getTransport).mockReturnValue(transport);

    const err = await createApi().createCompactResponse(REQUEST).catch((e: CodexApiError) => e);

    console.log(`[QA-N1] 客户端看到 status=${(err as CodexApiError).status}`);
    console.log(`[QA-N1] body 前 120 字 = ${String((err as CodexApiError).body ?? "").slice(0, 120)}`);

    expect(err).toBeInstanceOf(CodexApiError);
    // 状态码必须原样透出 —— 这是「逃生舱失败时能不能看懂」的核心
    expect((err as CodexApiError).status).toBe(404);
    // 上游原文要保留，便于判断"是端点没了"而不是别的
    expect(String((err as CodexApiError).body ?? "")).toContain("Not Found");
  });

  it("QA-N2 配了 v1：v2 一次都不试；v1 失败后也不回头弹回 v2", async () => {
    selectV1Protocol();
    const transport = transportReturning(404, JSON.stringify({ error: { message: "Not Found" } }));
    vi.mocked(getTransport).mockReturnValue(transport);

    await createApi().createCompactResponse(REQUEST).catch(() => undefined);

    console.log(`[QA-N2] v2 调用次数=${mockCreateWebSocketResponse.mock.calls.length} v1 调用次数=${vi.mocked(transport.post).mock.calls.length}`);
    // 配了 v1：v2 零调用，v1 恰好一次
    expect(mockCreateWebSocketResponse).not.toHaveBeenCalled();
    expect(transport.post).toHaveBeenCalledOnce();
  });

  it("QA-N3 v1 返回**空 body** 404（CF path-block 的形状）→ 状态码同样是 404，交给上层分类", async () => {
    selectV1Protocol();
    const transport = transportReturning(404, "");
    vi.mocked(getTransport).mockReturnValue(transport);

    const err = await createApi().createCompactResponse(REQUEST).catch((e: CodexApiError) => e);

    console.log(`[QA-N3] status=${(err as CodexApiError).status} body 长度=${String((err as CodexApiError).body ?? "").length}`);
    expect((err as CodexApiError).status).toBe(404);
    // 空 body 必须保持空 —— 上层 isCfPathBlockError 正是靠「404 且 body 空」区分
    // CF 拦截和真实 404。这里若擅自填一段文案，会把 CF 自愈判据破坏掉。
    expect(String((err as CodexApiError).body ?? "").trim()).toBe("");
  });

  it("QA-N4 v1 返回 5xx → 原形抛出，不被改写成 404/502 之外的东西", async () => {
    selectV1Protocol();
    const transport = transportReturning(503, JSON.stringify({ error: { message: "upstream down" } }));
    vi.mocked(getTransport).mockReturnValue(transport);

    const err = await createApi().createCompactResponse(REQUEST).catch((e: CodexApiError) => e);

    console.log(`[QA-N4] status=${(err as CodexApiError).status}`);
    expect((err as CodexApiError).status).toBe(503);
  });

  it("QA-N5 v1 返回 200 但 body 不是合法 JSON → 必须报错，不能把垃圾当成压缩结果用", async () => {
    selectV1Protocol();
    const transport = transportReturning(200, "<html>502 Bad Gateway</html>");
    vi.mocked(getTransport).mockReturnValue(transport);

    const result = await createApi().createCompactResponse(REQUEST)
      .then((r) => ({ ok: true as const, r }))
      .catch((e: CodexApiError) => ({ ok: false as const, e }));

    console.log(`[QA-N5] 是否抛错 = ${!result.ok}` + (result.ok ? ` （危险：把非 JSON 当成了结果 ${JSON.stringify(result.r).slice(0, 80)}）` : ` status=${(result.e as CodexApiError).status}`));
    expect(result.ok).toBe(false);
  });

  it("QA-N6 v1 路径盖章 compaction_protocol=\"v1\"，且不信上游 body 里的同名字段", async () => {
    selectV1Protocol();
    // 上游谎称自己是 v2 —— proxy 必须以自己实际走的协议为准
    const transport = transportReturning(200, JSON.stringify({
      output: [{ type: "reasoning", encrypted_content: "legacy" }],
      compaction_protocol: "v2",
    }));
    vi.mocked(getTransport).mockReturnValue(transport);

    const result = await createApi().createCompactResponse(REQUEST) as
      { compaction_protocol?: string };

    console.log(`[QA-N6] 上游声称 v2，proxy 盖章 = ${JSON.stringify(result.compaction_protocol)}`);
    expect(result.compaction_protocol).toBe("v1");
  });
});
