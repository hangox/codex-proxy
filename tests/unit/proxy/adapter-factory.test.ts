import { afterEach, describe, expect, it, vi } from "vitest";

const { mockWithFetchDispatcher } = vi.hoisted(() => ({
  mockWithFetchDispatcher: vi.fn((init: RequestInit) => ({ ...init, dispatcher: "mock-dispatcher" })),
}));

vi.mock("@src/proxy/fetch-dispatcher.js", () => ({
  withFetchDispatcher: mockWithFetchDispatcher,
}));

import { createAdapterForEntry } from "@src/proxy/adapter-factory.js";
import { OpenAIUpstream } from "@src/proxy/openai-upstream.js";
import { ResponsesUpstream } from "@src/proxy/responses-upstream.js";
import { AnthropicUpstream } from "@src/proxy/anthropic-upstream.js";
import { GeminiUpstream } from "@src/proxy/gemini-upstream.js";
import type { ApiKeyEntry, ApiKeyProvider, ApiKeyWire } from "@src/auth/api-key-pool.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";

function entry(
  provider: ApiKeyProvider,
  wire: ApiKeyWire = "chat",
  baseUrl = "https://api.example.com/v1",
): ApiKeyEntry {
  return {
    id: "id1",
    provider,
    model: "m",
    apiKey: "k",
    baseUrl,
    label: null,
    capabilities: ["chat"],
    wire,
    status: "active",
    addedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
  };
}

function codexRequest(model: string): CodexResponsesRequest {
  return {
    model,
    input: [{ role: "user", content: "hello" }],
    stream: true,
    store: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAdapterForEntry — wire routing", () => {
  it("OpenAI-family default to Chat Completions (OpenAIUpstream)", () => {
    for (const p of ["openai", "openrouter", "custom"] as const) {
      expect(createAdapterForEntry(entry(p, "chat"))).toBeInstanceOf(OpenAIUpstream);
    }
  });

  it("OpenAI-family with wire=responses use ResponsesUpstream", () => {
    for (const p of ["openai", "openrouter", "custom"] as const) {
      const adapter = createAdapterForEntry(entry(p, "responses"));
      expect(adapter).toBeInstanceOf(ResponsesUpstream);
      expect(adapter.tag).toBe(p);
    }
  });

  it("custom can use Anthropic and Gemini native wires", () => {
    expect(createAdapterForEntry(entry("custom", "anthropic"))).toBeInstanceOf(AnthropicUpstream);
    expect(createAdapterForEntry(entry("custom", "gemini"))).toBeInstanceOf(GeminiUpstream);
  });

  it("built-in anthropic/gemini ignore wire and use their native adapters with custom baseUrl", () => {
    const customUrl = "https://custom.endpoint.com/v1";
    const anthropicAdapter = createAdapterForEntry(entry("anthropic", "responses", customUrl)) as AnthropicUpstream;
    expect(anthropicAdapter).toBeInstanceOf(AnthropicUpstream);
    expect(anthropicAdapter.baseUrl).toBe("https://custom.endpoint.com/v1");

    const geminiAdapter = createAdapterForEntry(entry("gemini", "responses", customUrl)) as GeminiUpstream;
    expect(geminiAdapter).toBeInstanceOf(GeminiUpstream);
    expect(geminiAdapter.baseUrl).toBe("https://custom.endpoint.com/v1");
  });

  it("AnthropicUpstream posts to custom baseUrl /messages", async () => {
    const fetchMock = vi.fn(async () => new Response("event: message_stop\ndata: {}\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("sk-ant", "https://anthropic.example.com/v1/");
    await upstream.createResponse(codexRequest("claude-custom"), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic.example.com/v1/messages");
    expect(mockWithFetchDispatcher).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      dispatcher: "mock-dispatcher",
      headers: {
        "x-api-key": "sk-ant",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
    });
  });

  it("GeminiUpstream posts to custom baseUrl streamGenerateContent endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("data: {}\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new GeminiUpstream("gem-key", "https://gemini.example.com/v1beta/");
    await upstream.createResponse(codexRequest("gemini-custom"), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://gemini.example.com/v1beta/models/gemini-custom:streamGenerateContent?alt=sse&key=gem-key");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
    });
  });
});

// ── shared deterministic-schema-error reclassification ────────────
//
// AnthropicUpstream / GeminiUpstream / OpenAIUpstream all share the exact
// same "wrap non-2xx into CodexApiError" snippet copy-pasted from codex-api.ts
// (the primary Codex/ChatGPT backend path, where this reclassification was
// first added to fix a real production hang — see error-classification.ts).
// These three run through classifyRawUpstreamError() too, so a deterministic
// schema/param error that upstream reports as a 5xx must not be endlessly
// retried on these routes either.
const SCHEMA_ERROR_BODY = "Invalid schema for function 'Artifact': "
  + "'^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$' is not a 'regex'.";

describe("non-Codex upstream adapters — deterministic schema-error reclassification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases: Array<{ name: string; make: () => UpstreamAdapter }> = [
    { name: "AnthropicUpstream", make: () => new AnthropicUpstream("sk-ant") },
    { name: "GeminiUpstream", make: () => new GeminiUpstream("gem-key") },
    { name: "OpenAIUpstream", make: () => new OpenAIUpstream("openai", "sk") },
  ];

  for (const { name, make } of cases) {
    it(`${name} reclassifies a schema-error 502 to 400 + retryable:false`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(SCHEMA_ERROR_BODY, { status: 502 })));
      const upstream = make();

      let caught: unknown;
      try {
        await upstream.createResponse(codexRequest("m"), new AbortController().signal);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CodexApiError);
      const err = caught as CodexApiError;
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
    });

    it(`${name} leaves an ordinary transport 502 as a normal retryable 5xx`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })));
      const upstream = make();

      let caught: unknown;
      try {
        await upstream.createResponse(codexRequest("m"), new AbortController().signal);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CodexApiError);
      const err = caught as CodexApiError;
      expect(err.status).toBe(502);
      expect(err.retryable).toBeUndefined();
    });
  }
});
