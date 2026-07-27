/**
 * E2E tests for POST /v1/messages (Anthropic Messages API format).
 *
 * Translation details (tool calls, thinking blocks, cache tokens) are covered
 * by unit tests in src/translation/; this file focuses on:
 *   - Anthropic SSE event structure (message_start, content_block_*, message_delta)
 *   - Anthropic JSON response structure
 *   - Anthropic-specific error format
 *   - Auth flow
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
  getLastTransportBody,
  makeTransportResponse,
  makeErrorTransportResponse,
  setClaudeCodeCompactBridge,
  setClaudeCodeOpaqueCompactExperimental,
} from "@helpers/e2e-setup.js";
import {
  buildEmptyStreamChunks,
  buildErrorStreamChunks,
  buildTextStreamChunks,
  sseChunk,
} from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { opaqueCompactStateStore } from "@src/routes/shared/opaque-compact-state.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
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
      accountId: "acct-e2e-msg",
      email: "msg@test.com",
      planType: "plus",
    }));
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));

  return { app, accountPool, cookieJar, proxyPool };
}

beforeEach(() => {
  resetTransportState();
  opaqueCompactStateStore.clear();
  setTransportPost(async () =>
    makeTransportResponse(buildTextStreamChunks("resp_msg_1", "Hello!")),
  );
  vi.mocked(getMockTransport().post).mockClear();
  ctx = buildApp();
});

afterEach(() => {
  ctx.cookieJar.destroy();
  ctx.proxyPool.destroy();
  ctx.accountPool.destroy();
});

function messagesRequest(body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function countTokensRequest(body: unknown) {
  return ctx.app.request("/v1/messages/count_tokens?beta=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

const compactPrompt = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
  "This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",
  "Before providing your final summary, wrap your analysis in <analysis> tags and double-check for technical accuracy and completeness.",
  "Your summary should include the following sections:",
  "1. Primary Request and Intent:",
  "2. Key Technical Concepts:",
  "3. Files and Code Sections:",
  "4. Errors and fixes:",
  "5. Problem Solving:",
  "6. All user messages:",
  "7. Pending Tasks:",
  "Additional Instructions: preserve exact technical details.",
  "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
].join("\n");

function parseAnthropicSSE(text: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  const lines = text.split("\n");
  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) currentEvent = line.slice(7);
    else if (line.startsWith("data: ")) {
      try { results.push({ event: currentEvent, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
      currentEvent = "";
    }
  }
  return results;
}

function extractMarkerFromResponse(responseText: string): string {
  return parseAnthropicSSE(responseText)
    .filter((event) => event.event === "content_block_delta")
    .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
    .join("");
}

function wrapOpaqueMarker(marker: string, transcriptPath = "/tmp/claude-wrapper-e2e/session.jsonl"): string {
  const token = marker.match(/<summary>([^<]+)<\/summary>/)?.[1];
  if (!token) throw new Error("opaque marker token is missing");
  return (
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
    token +
    "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, " +
    "or content you generated), read the full transcript at: " + transcriptPath + "\n" +
    "Continue the conversation from where it left off without asking the user any further questions. " +
    "Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with " +
    "\"I'll continue\" or similar. Pick up the last task as if the break never happened."
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: POST /v1/messages", () => {
  it("count_tokens: returns local Anthropic-compatible token estimate without upstream call", async () => {
    const res = await countTokensRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello from Claude Code" }],
      tools: [{
        name: "Read",
        description: "Read a file from the local workspace",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      }],
      betas: ["token-efficient-tools-2025-02-19"],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { input_tokens?: unknown };
    expect(typeof body.input_tokens).toBe("number");
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(body.input_tokens).toBeLessThan(500);
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("count_tokens: works without an authenticated Codex account", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "count only" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { input_tokens?: unknown };
      expect(typeof body.input_tokens).toBe("number");
      expect(body.input_tokens).toBeGreaterThan(0);
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  it("count_tokens: invalid requests return Anthropic error shape", async () => {
    const res = await countTokensRequest({
      model: "gpt-5.5",
      messages: [],
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // ── Claude Code compact bridge ─────────────────────────────────

  it("compact bridge: uses compact then render on the same account and keeps opaque output", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      urls.push(url);
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [
            { type: "reasoning", encrypted_content: "opaque-encrypted", summary: [] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] },
          ],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_compact_render", "<analysis>x</analysis><summary>y</summary>"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "original history" },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "cipher" }, { type: "text", text: "answer" }] },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-compact-test" });

    expect(res.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/codex/responses/compact");
    expect(urls[1]).toContain("/codex/responses");
    const compactInput = bodies[0].input as unknown[];
    expect(JSON.stringify(compactInput)).toContain("cipher");
    expect(JSON.stringify(compactInput)).not.toContain("CRITICAL: Respond with TEXT ONLY");
    const renderInput = bodies[1].input as unknown[];
    expect(renderInput[0]).toMatchObject({ encrypted_content: "opaque-encrypted" });
    expect(JSON.stringify(renderInput.at(-1))).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(bodies[0].prompt_cache_key).toBe("session-compact-test");
    expect(bodies[1].prompt_cache_key).toBe("session-compact-test");
    expect(bodies[0].client_metadata).toBeUndefined();
    const events = parseAnthropicSSE(await res.text());
    const textDeltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
      .join("");
    expect(textDeltas).toContain("<summary>y</summary>");
  });

  it("opaque compact bridge: recognizes a prompt followed by a preserved tool result", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      urls.push(url);
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      return url.endsWith("/codex/responses/compact")
        ? makeErrorTransportResponse(200, JSON.stringify({
            output: [{ type: "reasoning", encrypted_content: "opaque-mixed-block", summary: [] }],
          }))
        : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "history" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-mixed", name: "Read", input: { file_path: "/tmp/canary" } }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: compactPrompt },
            { type: "tool_result", tool_use_id: "tool-mixed", content: "preserved tool result" },
          ],
        },
      ],
    }), { "x-claude-code-session-id": "session-mixed-block-compact" });

    expect(res.status).toBe(200);
    expect(urls).toEqual([expect.stringContaining("/codex/responses/compact")]);
    expect(extractMarkerFromResponse(await res.text())).toContain("codex-opaque-state:v1");
    const compactInput = bodies[0]?.input as unknown[];
    expect(JSON.stringify(compactInput)).toContain("preserved tool result");
    expect(JSON.stringify(compactInput)).toContain("function_call_output");
    expect(JSON.stringify(compactInput)).not.toContain("CRITICAL: Respond with TEXT ONLY");
  });

  it.each([
    [
      "mixed image content followed by ordinary text",
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        { type: "text", text: compactPrompt },
        { type: "text", text: "ordinary trailing text" },
      ],
    ],
    [
      "a duplicate strict compact prompt",
      [
        { type: "text", text: compactPrompt },
        { type: "tool_result", tool_use_id: "tool-ambiguous", content: "preserved result" },
        { type: "text", text: compactPrompt },
      ],
    ],
    [
      "a strict compact prompt followed by ordinary text",
      [
        { type: "text", text: compactPrompt },
        { type: "text", text: "ordinary trailing text" },
        { type: "tool_result", tool_use_id: "tool-trailing", content: "preserved result" },
      ],
    ],
  ])("opaque compact bridge: does not match %s", async (_case, content) => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("resp_not_compact", "ordinary response"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content }],
    }), { "x-claude-code-session-id": "session-mixed-negative" });

    expect(res.status).toBe(200);
    const responseText = await res.text();
    expect(responseText).toContain("ordinary response");
    expect(responseText).not.toContain("codex-opaque-state:v1");
    expect(urls).toEqual([expect.not.stringContaining("/compact")]);
    expect(opaqueCompactStateStore.size()).toBe(0);
  });

  it.each([
        ["tampered", (marker: string) => marker.replace(
          /:([A-Za-z0-9_-])([A-Za-z0-9_-]{42})<\/summary>$/,
          (_match, first: string, rest: string) => ":" + (first === "A" ? "B" : "A") + rest + "</summary>",
        ), "tampered"],
        ["missing", (marker: string) => {
          opaqueCompactStateStore.clear();
          return marker;
        }, "missing"],
      ])("opaque compact bridge: rejects %s marker state", async (_case, mutateMarker, reason) => {
        setClaudeCodeOpaqueCompactExperimental(true);
        setTransportPost(async (url) => url.endsWith("/codex/responses/compact")
          ? makeErrorTransportResponse(200, JSON.stringify({ output: [{ type: "message", role: "assistant", content: [] }] }))
          : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-marker-state" });
        const marker = extractMarkerFromResponse(await compactRes.text());

        const replay = await messagesRequest(defaultBody({
          stream: true,
          messages: [
            { role: "assistant", content: mutateMarker(marker) },
            { role: "user", content: "continue" },
          ],
        }), { "x-claude-code-session-id": "session-marker-state" });
        expect(replay.status).toBe(409);
        expect(await replay.text()).toContain(reason);
        expect(getMockTransport().post).toHaveBeenCalledTimes(1);
      });

  it("opaque compact bridge: restores a real Claude Code compact summary wrapper", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const transcriptPath = "/tmp/claude-wrapper-e2e/session.jsonl";
    setTransportPost(async (url, _headers, body) => {
      urls.push(url);
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [
            { type: "reasoning", encrypted_content: "opaque-wrapper-secret", summary: [] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "retained context" }] },
          ],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_wrapper_resume", "wrapper restored"));
    });

    const compactRes = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-wrapper-resume" });
    const marker = extractMarkerFromResponse(await compactRes.text());
    const wrapper = wrapOpaqueMarker(marker, transcriptPath);

    const replay = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "old history that must not be replayed" },
        { role: "user", content: wrapper + "\n\nsame-message continuation" },
        { role: "user", content: "What was retained?" },
      ],
    }), { "x-claude-code-session-id": "session-wrapper-resume" });

    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("wrapper restored");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/codex/responses/compact");
    expect(urls[1]).not.toContain("/compact");
    const replayInput = bodies[1].input as unknown[];
    expect(replayInput[0]).toMatchObject({ encrypted_content: "opaque-wrapper-secret" });
    expect(JSON.stringify(replayInput)).toContain("retained context");
    expect(JSON.stringify(replayInput)).toContain("same-message continuation");
    expect(JSON.stringify(replayInput)).not.toContain("old history that must not be replayed");
    expect(JSON.stringify(replayInput)).not.toContain("codex-opaque-state:v1");
    expect(JSON.stringify(replayInput)).not.toContain(transcriptPath);
    expect(JSON.stringify(replayInput.at(-1))).toContain("What was retained?");
  });

  it("opaque compact bridge: accepts metadata-only session identity and strips duplicate markers", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const bodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-metadata-session", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_metadata_resume", "metadata restored"));
    });
    const metadata = { user_id: JSON.stringify({ session_id: "session-metadata-only", device_id: "device-test" }) };

    const compactRes = await messagesRequest(defaultBody({
      stream: true,
      metadata,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }));
    const marker = extractMarkerFromResponse(await compactRes.text());
    const replay = await messagesRequest(defaultBody({
      stream: true,
      metadata,
      messages: [
        { role: "assistant", content: marker },
        { role: "assistant", content: marker },
        { role: "user", content: "continue" },
      ],
    }));

    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("metadata restored");
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain("opaque-metadata-session");
    expect(JSON.stringify(bodies[1])).not.toContain("codex-opaque-state:v1");
  });

  it("opaque compact bridge: uses the last duplicate marker as the restore boundary", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const bodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-last-boundary", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_last_boundary", "last boundary restored"));
    });

    const compactRes = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-last-boundary" });
    const marker = extractMarkerFromResponse(await compactRes.text());
    const replay = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "OLD" },
        { role: "assistant", content: marker },
        { role: "user", content: "MID" },
        { role: "assistant", content: marker },
        { role: "user", content: "NEW" },
      ],
    }), { "x-claude-code-session-id": "session-last-boundary" });

    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("last boundary restored");
    expect(JSON.stringify(bodies[1])).toContain("opaque-last-boundary");
    expect(JSON.stringify(bodies[1])).toContain("NEW");
    expect(JSON.stringify(bodies[1])).not.toContain("OLD");
    expect(JSON.stringify(bodies[1])).not.toContain("MID");
    expect(JSON.stringify(bodies[1])).not.toContain("codex-opaque-state:v1");
  });

  it("opaque compact bridge: restores a raw marker with same-string continuation", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const bodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-raw-continuation", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_raw_continuation", "raw restored"));
    });

    const compactRes = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-raw-continuation" });
    const marker = extractMarkerFromResponse(await compactRes.text());
    const replay = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "assistant", content: marker + "\n\nraw continuation" }],
    }), { "x-claude-code-session-id": "session-raw-continuation" });

    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("raw restored");
    expect(JSON.stringify(bodies[1])).toContain("opaque-raw-continuation");
    expect(JSON.stringify(bodies[1])).toContain("raw continuation");
    expect(JSON.stringify(bodies[1])).not.toContain("codex-opaque-state:v1");
  });

  it("opaque compact bridge: rejects malformed markers before logging or upstream forwarding", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const malformed =
      "<analysis>Opaque compact state retained locally.</analysis>\n" +
      "<summary>codex-opaque-state:v1:not-a-valid-token</summary>";

    const replay = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "assistant", content: malformed }, { role: "user", content: "continue" }],
    }), { "x-claude-code-session-id": "session-malformed-marker" });

    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("invalid_marker");
    expect(getMockTransport().post).not.toHaveBeenCalled();
  });

  it("opaque compact bridge: rejects a marker replayed with another model", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        setTransportPost(async (url) => url.endsWith("/codex/responses/compact")
          ? makeErrorTransportResponse(200, JSON.stringify({ output: [{ type: "message", role: "assistant", content: [] }] }))
          : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-model-owner" });
        const marker = extractMarkerFromResponse(await compactRes.text());

        const replay = await messagesRequest(defaultBody({
          model: "gpt-5.3-codex",
          stream: true,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }), { "x-claude-code-session-id": "session-model-owner" });
        expect(replay.status).toBe(409);
        expect(await replay.text()).toContain("model_mismatch");
        expect(getMockTransport().post).toHaveBeenCalledTimes(1);
      });

      it("opaque compact bridge: rejects a marker after the experimental switch is disabled", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        setTransportPost(async (url) => url.endsWith("/codex/responses/compact")
          ? makeErrorTransportResponse(200, JSON.stringify({ output: [{ type: "message", role: "assistant", content: [] }] }))
          : makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected")));

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-disabled-state" });
        const marker = extractMarkerFromResponse(await compactRes.text());
        setClaudeCodeOpaqueCompactExperimental(false);

        const replay = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }), { "x-claude-code-session-id": "session-disabled-state" });
        expect(replay.status).toBe(409);
        expect(await replay.text()).toContain("disabled or was lost after restart");
        expect(getMockTransport().post).toHaveBeenCalledTimes(1);
      });

      it("opaque compact bridge: ordinary marker-like text is not treated as state", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const urls: string[] = [];
        setTransportPost(async (url) => {
          urls.push(url);
          return makeTransportResponse(buildTextStreamChunks("ordinary_marker_text", "ordinary"));
        });

        const res = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "I saw codex-opaque-state:v1 quoted in documentation." }],
        }), { "x-claude-code-session-id": "session-ordinary-marker" });
        expect(res.status).toBe(200);
        expect(urls).toHaveLength(1);
        expect(urls[0]).not.toContain("/compact");
      });

      it("opaque compact bridge: repeated compact restores prior opaque output and stays on the original account", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const urls: string[] = [];
        const bodies: Array<Record<string, unknown>> = [];
        let compactCalls = 0;
        setTransportPost(async (url, _headers, body) => {
          urls.push(url);
          bodies.push(JSON.parse(body) as Record<string, unknown>);
          if (url.endsWith("/codex/responses/compact")) {
            compactCalls++;
            return makeErrorTransportResponse(200, JSON.stringify({
              output: compactCalls === 1
                ? [{ type: "reasoning", encrypted_content: "opaque-generation-one", summary: [] }]
                : [{ type: "reasoning", encrypted_content: "opaque-generation-two", summary: [] }],
            }));
          }
          return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
        });

        const first = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history one" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-repeat-compact" });
        const markerOne = extractMarkerFromResponse(await first.text());

        const second = await messagesRequest(defaultBody({
          stream: true,
          messages: [
            { role: "assistant", content: markerOne },
            { role: "user", content: "history two" },
            { role: "user", content: compactPrompt },
          ],
        }), { "x-claude-code-session-id": "session-repeat-compact" });
        const markerTwo = extractMarkerFromResponse(await second.text());

        expect(markerTwo).toContain("codex-opaque-state:v1:");
        expect(markerTwo).not.toBe(markerOne);
        expect(compactCalls).toBe(2);
        expect(urls.every((url) => url.endsWith("/codex/responses/compact"))).toBe(true);
        expect(JSON.stringify(bodies[1])).toContain("opaque-generation-one");
        expect(JSON.stringify(bodies[1])).not.toContain("codex-opaque-state:v1");
      });

      it("opaque compact bridge: first compact failure safely falls back to the original messages path", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const urls: string[] = [];
        setTransportPost(async (url) => {
          urls.push(url);
          if (url.endsWith("/codex/responses/compact")) {
            return makeErrorTransportResponse(400, JSON.stringify({ error: { message: "injected opaque compact failure" } }));
          }
          return makeTransportResponse(buildTextStreamChunks("resp_opaque_fallback", "opaque fallback worked"));
        });

        const res = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "original history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-opaque-fallback" });

        expect(res.status).toBe(200);
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain("/compact");
        expect(urls[1]).not.toContain("/compact");
        expect(JSON.stringify(parseAnthropicSSE(await res.text()))).toContain("opaque fallback worked");
      });

      it("opaque compact bridge: client abort cancels compact without saving state or falling back", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        let upstreamSignal: AbortSignal | undefined;
        let signalReady: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => { signalReady = resolve; });
        setTransportPost(async (_url, _headers, _body, signal) => {
          upstreamSignal = signal;
          signalReady?.();
          return await new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        });

        const controller = new AbortController();
        const request = new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-claude-code-session-id": "session-opaque-abort",
          },
          body: JSON.stringify(defaultBody({
            stream: true,
            messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
          })),
          signal: controller.signal,
        });
        const responsePromise = ctx.app.fetch(request);
        await ready;
        controller.abort();
        await responsePromise;

        expect(upstreamSignal?.aborted).toBe(true);
        expect(getMockTransport().post).toHaveBeenCalledTimes(1);
        expect(opaqueCompactStateStore.size()).toBe(0);
      });

      it("opaque compact bridge: hard-bound HTTP 429 does not retry another account", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const urls: string[] = [];
        setTransportPost(async (url) => {
          urls.push(url);
          if (url.endsWith("/codex/responses/compact")) {
            return makeErrorTransportResponse(200, JSON.stringify({
              output: [{ type: "reasoning", encrypted_content: "opaque-hard-bound", summary: [] }],
            }));
          }
          return makeErrorTransportResponse(429, JSON.stringify({ error: { message: "rate limited" } }));
        });

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-hard-bound-http" });
        const marker = extractMarkerFromResponse(await compactRes.text());
        const secondId = ctx.accountPool.addAccount(createValidJwt({
          accountId: "acct-e2e-opaque-second",
          email: "opaque-second@test.com",
          planType: "plus",
        }));

        const replay = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }), { "x-claude-code-session-id": "session-hard-bound-http" });
        expect(replay.status).toBe(200);
        expect(await replay.text()).toContain("cross-account retry is disabled");
        expect(urls).toHaveLength(2);
        expect(ctx.accountPool.getEntry(secondId)?.status).toBe("active");
      });

      it("opaque compact bridge: hard-bound empty stream emits an error without retrying another account", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const urls: string[] = [];
        setTransportPost(async (url) => {
          urls.push(url);
          if (url.endsWith("/codex/responses/compact")) {
            return makeErrorTransportResponse(200, JSON.stringify({
              output: [{ type: "reasoning", encrypted_content: "opaque-empty-bound", summary: [] }],
            }));
          }
          return makeTransportResponse(buildEmptyStreamChunks("resp_opaque_empty"));
        });

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-hard-bound-empty" });
        const marker = extractMarkerFromResponse(await compactRes.text());
        ctx.accountPool.addAccount(createValidJwt({
          accountId: "acct-e2e-opaque-empty-second",
          email: "opaque-empty-second@test.com",
          planType: "plus",
        }));

        const replay = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }), { "x-claude-code-session-id": "session-hard-bound-empty" });
        expect(replay.status).toBe(200);
        expect(await replay.text()).toContain("cross-account retry is disabled");
        expect(urls).toHaveLength(2);
      });

      it("opaque compact bridge: unavailable original account returns 409 instead of using another account", async () => {
        setClaudeCodeOpaqueCompactExperimental(true);
        const originalId = ctx.accountPool.getAllEntries()[0]!.id;
        const urls: string[] = [];
        setTransportPost(async (url) => {
          urls.push(url);
          if (url.endsWith("/codex/responses/compact")) {
            return makeErrorTransportResponse(200, JSON.stringify({
              output: [{ type: "reasoning", encrypted_content: "opaque-account-bound", summary: [] }],
            }));
          }
          return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
        });

        const compactRes = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
        }), { "x-claude-code-session-id": "session-account-unavailable" });
        const marker = extractMarkerFromResponse(await compactRes.text());
        ctx.accountPool.markStatus(originalId, "disabled");
        ctx.accountPool.addAccount(createValidJwt({
          accountId: "acct-e2e-opaque-available",
          email: "opaque-available@test.com",
          planType: "plus",
        }));

        const replay = await messagesRequest(defaultBody({
          stream: true,
          messages: [{ role: "assistant", content: marker }, { role: "user", content: "continue" }],
        }), { "x-claude-code-session-id": "session-account-unavailable" });
        expect(replay.status).toBe(200);
        expect(await replay.text()).toContain("compact state account is unavailable");
        expect(urls).toHaveLength(1);
      });

  it("opaque compact bridge: repeated compact never sends bound opaque state to a fallback account", async () => {
    setClaudeCodeOpaqueCompactExperimental(true);
    const originalId = ctx.accountPool.getAllEntries()[0]!.id;
    const compactBodies: Array<Record<string, unknown>> = [];
    setTransportPost(async (url, _headers, body) => {
      if (url.endsWith("/codex/responses/compact")) {
        compactBodies.push(JSON.parse(body) as Record<string, unknown>);
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-account-bound-recompact", summary: [] }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("unexpected", "unexpected"));
    });

    const compactRes = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-account-unavailable-recompact" });
    const marker = extractMarkerFromResponse(await compactRes.text());
    ctx.accountPool.markStatus(originalId, "disabled");
    ctx.accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-opaque-recompact-available",
      email: "opaque-recompact-available@test.com",
      planType: "plus",
    }));

    const repeatedCompact = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: wrapOpaqueMarker(marker) },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-account-unavailable-recompact" });

    expect(repeatedCompact.status).toBe(409);
    expect(await repeatedCompact.text()).toContain("could not be compacted on its original account");
    expect(compactBodies).toHaveLength(1);
    expect(JSON.stringify(compactBodies)).not.toContain("opaque-account-bound-recompact");
  });

      it("compact bridge: compact failure safely falls back to the original messages path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(400, JSON.stringify({ error: { message: "injected compact failure" } }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_fallback", "fallback worked"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "original history" },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-compact-test" });

    expect(res.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/codex/responses/compact");
    expect(urls[1]).toContain("/codex/responses");
    const events = parseAnthropicSSE(await res.text());
    const textDeltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
      .join("");
    expect(textDeltas).toContain("fallback worked");
  });

  it("compact bridge: render failure before first content safely falls back to legacy path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    let responsesCalls = 0;
    setTransportPost(async (url) => {
      urls.push(url);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] }],
        }));
      }
      responsesCalls++;
      if (responsesCalls === 1) {
        return makeTransportResponse(buildErrorStreamChunks("resp_render_failure", "server_error", "injected render failure"));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_render_fallback", "render fallback worked"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "original history" },
        { role: "user", content: compactPrompt },
      ],
    }), { "x-claude-code-session-id": "session-render-failure" });

    expect(res.status).toBe(200);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("/compact");
    expect(urls[1]).not.toContain("/compact");
    expect(urls[2]).not.toContain("/compact");
    const events = parseAnthropicSSE(await res.text());
    const textDeltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data as { delta?: { text?: string } }).delta?.text ?? "")
      .join("");
    expect(textDeltas).toContain("render fallback worked");
  });

  it("compact bridge: empty render before first content falls back to legacy path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    let responsesCalls = 0;
    setTransportPost(async (url) => {
      urls.push(url);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({ output: [] }));
      }
      responsesCalls++;
      return responsesCalls === 1
        ? makeTransportResponse(buildEmptyStreamChunks("resp_empty_render"))
        : makeTransportResponse(buildTextStreamChunks("resp_empty_fallback", "empty fallback worked"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-empty-render" });

    expect(urls).toHaveLength(3);
    const events = parseAnthropicSSE(await res.text());
    expect(JSON.stringify(events)).toContain("empty fallback worked");
  });

  it("compact bridge: premature render close before first content falls back to legacy path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    let responsesCalls = 0;
    setTransportPost(async (url) => {
      urls.push(url);
      if (url.endsWith("/codex/responses/compact")) {
        return makeErrorTransportResponse(200, JSON.stringify({ output: [] }));
      }
      responsesCalls++;
      return responsesCalls === 1
        ? makeTransportResponse(
            sseChunk("response.created", { response: { id: "resp_premature" } }) +
            sseChunk("response.in_progress", { response: { id: "resp_premature" } }),
          )
        : makeTransportResponse(buildTextStreamChunks("resp_premature_fallback", "premature fallback worked"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-premature-render" });

    expect(urls).toHaveLength(3);
    const events = parseAnthropicSSE(await res.text());
    expect(JSON.stringify(events)).toContain("premature fallback worked");
  });

  it("compact bridge: cross-account retry releases A and restarts the full group on B", async () => {
    setClaudeCodeCompactBridge(true);
    const secondId = ctx.accountPool.addAccount(createValidJwt({
      accountId: "acct-e2e-msg-second",
      email: "msg-second@test.com",
      planType: "plus",
    }));
    const firstId = ctx.accountPool.getAllEntries().find((entry) => entry.id !== secondId)!.id;
    const releaseSpy = vi.spyOn(ctx.accountPool, "release");
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    setTransportPost(async (_url, _headers, body) => {
      call++;
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      if (call === 1) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-from-A" }],
        }));
      }
      if (call === 2) {
        return makeTransportResponse(buildErrorStreamChunks("resp_a_429", "rate_limit_exceeded", "retry account"));
      }
      if (call === 3) {
        return makeErrorTransportResponse(200, JSON.stringify({
          output: [{ type: "reasoning", encrypted_content: "opaque-from-B" }],
        }));
      }
      return makeTransportResponse(buildTextStreamChunks("resp_b_success", "account B worked"));
    });

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: "history" }, { role: "user", content: compactPrompt }],
    }), { "x-claude-code-session-id": "session-account-retry" });
    const events = parseAnthropicSSE(await res.text());

    expect(call).toBe(4);
    expect(JSON.stringify(bodies[3])).toContain("opaque-from-B");
    expect(JSON.stringify(bodies[3])).not.toContain("opaque-from-A");
    expect(JSON.stringify(events)).toContain("account B worked");
    expect(releaseSpy.mock.calls.map(([entryId]) => entryId)).toContain(firstId);
    expect(releaseSpy.mock.calls.map(([entryId]) => entryId)).toContain(secondId);
  });

  it("compact bridge: identical prompt without Claude Code session identity stays on legacy path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("resp_no_identity", "legacy"));
    });
    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: compactPrompt }],
    }));
    expect(res.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("/compact");
  });

  it("compact bridge: non-streaming identical prompt stays on legacy path", async () => {
    setClaudeCodeCompactBridge(true);
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("resp_non_stream", "legacy"));
    });
    const res = await messagesRequest(
      defaultBody({ stream: false, messages: [{ role: "user", content: compactPrompt }] }),
      { "x-claude-code-session-id": "session-non-stream" },
    );
    expect(res.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("/compact");
  });

  it("compact bridge: disabled setting preserves the single-call legacy path", async () => {
    setClaudeCodeCompactBridge(false);
    const urls: string[] = [];
    setTransportPost(async (url) => {
      urls.push(url);
      return makeTransportResponse(buildTextStreamChunks("resp_legacy", "legacy"));
    });
    const res = await messagesRequest(defaultBody({ messages: [{ role: "user", content: compactPrompt }] }));
    expect(res.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/codex/responses");
    expect(urls[0]).not.toContain("/compact");
  });

  // ── Anthropic SSE format ───────────────────────────────────────

  it("streaming: full Anthropic SSE event sequence", async () => {
    const res = await messagesRequest(defaultBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const events = parseAnthropicSSE(await res.text());
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    // message_start has correct structure
    const msgStart = events.find((e) => e.event === "message_start")!.data as Record<string, unknown>;
    const message = msgStart.message as Record<string, unknown>;
    expect(message.role).toBe("assistant");
    expect(message.type).toBe("message");

    // message_delta has stop_reason
    const msgDelta = events.find((e) => e.event === "message_delta")!.data as Record<string, unknown>;
    expect((msgDelta.delta as Record<string, unknown>).stop_reason).toBe("end_turn");
  });

  it("streaming: agent-team silent initialization returns empty message without upstream call", async () => {
    const initPrompt = [
      '<teammate-message teammate_id="team-lead">',
      "你是 G审查员，属于 team codemaker-review-2026-05-08。",
      "## 本条初始化消息的处理规则",
      "这是一条初始化消息，**不是任务**。",
      "- 不要调用任何工具",
      "- 不要回复 \"ready\" 或类似确认",
      "- 直接停止输出，让本轮自然结束并进入 idle",
      "</teammate-message>",
    ].join("\n");

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: initPrompt }],
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(getMockTransport().post).not.toHaveBeenCalled();

    const events = parseAnthropicSSE(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
    const msgStart = events[0].data as { message: { content: unknown[] } };
    expect(msgStart.message.content).toEqual([]);
  });

  it("streaming: agent-team silent initialization appended to existing history returns empty message without upstream call", async () => {
    const initPrompt = [
      '<teammate-message teammate_id="team-lead">',
      "你是 G快审员，属于 team codex-hook-merge-0508。",
      "## 本条初始化消息的处理规则",
      "这是一条初始化消息，**不是任务**。",
      "- 不要调用任何工具",
      "- 不要 SendMessage",
      "- 不要回复 \"ready\"",
      "- 直接停止输出，让本轮自然结束并进入 idle",
      "</teammate-message>",
    ].join("\n");

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [
        { role: "user", content: "Previous question" },
        { role: "assistant", content: "Previous answer" },
        { role: "user", content: initPrompt },
      ],
    }));

    expect(res.status).toBe(200);
    expect(getMockTransport().post).not.toHaveBeenCalled();

    const events = parseAnthropicSSE(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
  });

  it("streaming: agent-team initialization with task assignment still calls upstream", async () => {
    const initWithAssignment = [
      '<teammate-message teammate_id="team-lead">',
      "## 本条初始化消息的处理规则",
      "这是一条初始化消息，**不是任务**。",
      "直接停止输出",
      "{\"type\":\"task_assignment\",\"taskId\":\"task-1\"}",
      "</teammate-message>",
    ].join("\n");

    const res = await messagesRequest(defaultBody({
      stream: true,
      messages: [{ role: "user", content: initWithAssignment }],
    }));

    expect(res.status).toBe(200);
    const events = parseAnthropicSSE(await res.text());
    expect(events.map((e) => e.event)).toContain("content_block_delta");
  });

  // ── Anthropic JSON format ──────────────────────────────────────

  it("non-streaming: Anthropic message structure", async () => {
    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");

    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Hello!");

    const usage = body.usage as Record<string, unknown>;
    expect(typeof usage.input_tokens).toBe("number");
    expect(typeof usage.output_tokens).toBe("number");
  });

  it("uses Claude Code session id as prompt_cache_key", async () => {
    const res = await ctx.app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claude-code-session-id": "claude-code-session-123",
      },
      body: JSON.stringify(defaultBody({
        messages: [{ role: "user", content: "Start a project task" }],
      })),
    });
    expect(res.status).toBe(200);

    const transportBody = getLastTransportBody();
    if (!transportBody) {
      throw new Error("Expected upstream transport body to be captured");
    }

    const upstreamRequest = JSON.parse(transportBody) as { prompt_cache_key?: unknown };
    expect(upstreamRequest.prompt_cache_key).toBe("claude-code-session-123");
  });

  // ── Anthropic error format ─────────────────────────────────────

  it("upstream 429: Anthropic error envelope", async () => {
    setTransportPost(async () =>
      makeErrorTransportResponse(429, JSON.stringify({ detail: "Rate limited" })),
    );

    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(429);

    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("upstream context_length_exceeded: returns Prompt is too long for Claude Code recovery", async () => {
    let attempts = 0;
    setTransportPost(async () => {
      attempts++;
      return makeErrorTransportResponse(502, JSON.stringify({
        error: {
          type: "context_length_exceeded",
          code: "context_length_exceeded",
          message: "Your input exceeds the context window",
        },
      }));
    });

    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(400);

    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Prompt is too long");
    expect(attempts).toBe(1);
  });

  it("upstream 500: retries then returns api_error", async () => {
    // Count attempts at the underlying transport (covers both WS and HTTP
    // paths; messages.ts forces useWebSocket=true, so withRetry retries the
    // WS attempt 3x rather than falling back to HTTP).
    const post = vi.fn(async () =>
      makeErrorTransportResponse(500, JSON.stringify({ detail: "Internal error" })),
    );
    setTransportPost(post);

    const res = await messagesRequest(defaultBody());
    expect(res.status).toBe(500);

    const body = await res.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(post).toHaveBeenCalledTimes(3);
  }, 10_000);

  // ── Auth ───────────────────────────────────────────────────────

  it("no accounts: returns 401 authentication_error", async () => {
    const noAuth = buildApp({ noAccount: true });
    try {
      const res = await noAuth.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(401);

      const body = await res.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
    } finally {
      noAuth.cookieJar.destroy();
      noAuth.proxyPool.destroy();
      noAuth.accountPool.destroy();
    }
  });

  it("all accounts rate-limited: returns 529 overloaded_error, not 401", async () => {
    const app = buildApp({ noAccount: true });
    try {
      const id = app.accountPool.addAccount(createValidJwt({
        accountId: "acct-messages-rl",
        email: "messages-rl@test.com",
        planType: "plus",
      }));
      app.accountPool.applyRateLimit429(id, { retryAfterSec: 3600 });

      const res = await app.app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaultBody()),
      });
      expect(res.status).toBe(529);

      const body = await res.json() as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("overloaded_error");
    } finally {
      app.cookieJar.destroy();
      app.proxyPool.destroy();
      app.accountPool.destroy();
    }
  });
});
