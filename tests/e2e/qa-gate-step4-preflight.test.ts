/**
 * QA-P：门禁第 4 步（`POST /v1/chat/completions` 返回 200 且内容符合预期）的
 * **本地预验**。目的不是替代生产上那一发真实请求，而是提前排除「门禁当天卡在
 * 端点不存在 / 路由没挂 / 响应结构不是预期形状」这类低级问题。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost, resetTransportState, getMockTransport, makeTransportResponse,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";
import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

let ctx: { app: Hono; cookieJar: CookieJar };

beforeEach(() => {
  resetTransportState();
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({
    accountId: "acct-gate4", email: "gate4@test.com", planType: "plus",
  }));
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createChatRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));
  ctx = { app, cookieJar };
  setTransportPost(async () => makeTransportResponse(buildTextStreamChunks("resp_gate4", "pong")));
  vi.mocked(getMockTransport().post).mockClear();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  vi.restoreAllMocks();
});

describe("QA-P 门禁第 4 步本地预验", () => {
  it("QA-P1 POST /v1/chat/completions → 200，且 choices[0].message.content 有实际内容", async () => {
    const res = await ctx.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "reply with the single word: pong" }],
      }),
    });

    console.log(`[QA-P1] HTTP=${res.status}`);
    expect(res.status).toBe(200);

    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    console.log(`[QA-P1] choices[0].message.content = ${JSON.stringify(content)}`);

    // 门禁判据：不是空串、不是 error 对象
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain('"error"');
  });
});
