/**
 * POST /v1/images/generations 的集成测试。
 *
 * 只替换外部传输边界；账号池、CodexApi、共享 proxy-handler 和 Images 转换
 * 均运行真实实现。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getLastTransportBody,
  getMockTransport,
  makeTransportResponse,
  makeErrorTransportResponse,
} from "@helpers/e2e-setup.js";
import { buildImageGenStreamChunks, buildTextStreamChunks, sseChunk } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { getConfig } from "@src/config.js";
import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createImagesRoutes } from "@src/routes/images.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
}

let ctx: TestContext;

function buildApp(opts?: { noAccount?: boolean }): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();

  if (!opts?.noAccount) {
    accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-images",
      email: "images@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.onError(errorHandler);
  app.route("/", createImagesRoutes(accountPool, cookieJar, proxyPool));
  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = null;
  (getConfig().model as { image_host_model: string }).image_host_model = "gpt-5.5";
  setTransportPost(async () =>
    makeTransportResponse(buildImageGenStreamChunks(
      "resp_images_default",
      "item_images_default",
      "ZmFrZS1pbWFnZQ==",
      "default prompt",
    )),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

function imagesRequest(body: unknown, app = ctx.app): Promise<Response> {
  return app.request("/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/images/generations", () => {
  it("maps an Images request to the configured Codex host and returns b64_json", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildImageGenStreamChunks(
        "resp_images_ok",
        "item_images_ok",
        "ZmFrZS1wbmc=",
        "a revised prompt",
      )),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      size: "1024x1024",
      quality: "hd",
      output_format: "jpeg",
      output_compression: 80,
      background: "opaque",
      moderation: "low",
      partial_images: 2,
      n: 1,
      response_format: "b64_json",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      created: number;
      data: Array<{ b64_json: string; revised_prompt?: string }>;
    };
    expect(body.created).toEqual(expect.any(Number));
    expect(body.data).toEqual([{
      b64_json: "ZmFrZS1wbmc=",
      revised_prompt: "a revised prompt",
    }]);

    const sent = JSON.parse(getLastTransportBody()!);
    expect(sent.model).toBe("gpt-5.5");
    expect(sent.model).not.toBe("gpt-image-2");
    expect(sent.input).toEqual([{
      role: "user",
      content: [{ type: "input_text", text: "a red circle" }],
    }]);
    expect(sent.tools).toEqual([{
      type: "image_generation",
      size: "1024x1024",
      output_format: "jpeg",
      output_compression: 80,
      background: "opaque",
      moderation: "low",
      partial_images: 2,
    }]);
    expect(sent.tools[0].quality).toBeUndefined();
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_output_tokens).toBe(1);
    expect(account?.usage.image_request_count).toBe(1);
    expect(account?.usage.image_request_failed_count ?? 0).toBe(0);
  });

  it("rejects n other than one and unsupported response formats before upstream", async () => {
    const invalidN = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      n: 2,
    });
    expect(invalidN.status).toBe(400);
    expect((await invalidN.json() as { error: { type: string } }).error.type)
      .toBe("invalid_request_error");
    expect(getMockTransport().post).not.toHaveBeenCalled();

    const invalidFormat = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      response_format: "url",
    });
    expect(invalidFormat.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("rejects a PNG compression override that the Codex image tool cannot use", async () => {
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      output_format: "png",
      output_compression: 80,
    });

    expect(res.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("applies PNG compression validation when output_format is omitted", async () => {
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
      output_compression: 80,
    });

    expect(res.status).toBe(400);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("fails and records an image failure when response.completed is missing", async () => {
    setTransportPost(async () => makeTransportResponse(
      sseChunk("response.created", { response: { id: "resp_images_truncated" } })
      + sseChunk("response.output_item.done", {
        outputIndex: 0,
        item: {
          type: "image_generation_call",
          id: "item_images_truncated",
          result: "ZmFrZS1pbWFnZQ==",
        },
      }),
    ));

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("image_generation_failed");
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_request_count ?? 0).toBe(0);
    expect(account?.usage.image_request_failed_count).toBe(1);
  });

  it("fails when response.completed explicitly contains no image result", async () => {
    setTransportPost(async () => makeTransportResponse(
      sseChunk("response.created", { response: { id: "resp_images_empty_output" } })
      + sseChunk("response.output_item.done", {
        outputIndex: 0,
        item: {
          type: "image_generation_call",
          id: "item_images_stale",
          result: "ZmFrZS1pbWFnZQ==",
        },
      })
      + sseChunk("response.completed", {
        response: {
          id: "resp_images_empty_output",
          output: [],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      }),
    ));

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("image_generation_failed");
    const account = ctx.accountPool.getAllEntries()[0];
    expect(account?.usage.image_request_count ?? 0).toBe(0);
    expect(account?.usage.image_request_failed_count).toBe(1);
  });

  it("fails explicitly when upstream returns text without an image result", async () => {
    setTransportPost(async () =>
      makeTransportResponse(buildTextStreamChunks("resp_images_empty", "<svg>not an image</svg>")),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("image_generation_failed");
    expect(body.error.message).toContain("no image_generation_call.result");
  });

  it("formats upstream 429 as a rate limit error", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  it("rejects an image host model that is not a routable Codex model", async () => {
    (getConfig().model as { image_host_model: string }).image_host_model = "gpt-image-2";
    const imageToolHost = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });
    expect(imageToolHost.status).toBe(500);
    expect((await imageToolHost.json() as { error: { code: string } }).error.code)
      .toBe("image_host_model_invalid");
    expect(getMockTransport().post).not.toHaveBeenCalled();

    (getConfig().model as { image_host_model: string }).image_host_model = "not-in-model-catalog";
    const unknownHost = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    });
    expect(unknownHost.status).toBe(500);
    expect((await unknownHost.json() as { error: { code: string } }).error.code)
      .toBe("image_host_model_invalid");
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("requires an authenticated account before attempting upstream", async () => {
    const noAccount = buildApp({ noAccount: true });
    const res = await imagesRequest({
      model: "gpt-image-2",
      prompt: "a red circle",
    }, noAccount.app);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
    expect(getMockTransport().post).not.toHaveBeenCalled();
    noAccount.cookieJar.destroy();
    noAccount.proxyPool.destroy();
    noAccount.accountPool.destroy();
  });

  it("enforces the configured proxy API key", async () => {
    (getConfig().server as { proxy_api_key: string | null }).proxy_api_key = "images-secret";

    const missing = await imagesRequest({ model: "gpt-image-2", prompt: "a red circle" });
    expect(missing.status).toBe(401);
    expect(getMockTransport().post).not.toHaveBeenCalled();

    vi.mocked(getMockTransport().post).mockClear();
    const valid = await ctx.app.request("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer images-secret",
      },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a red circle" }),
    });
    expect(valid.status).toBe(200);
    expect(getLastTransportBody()).toBeTruthy();
  });
});
