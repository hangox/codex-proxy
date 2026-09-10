import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyModelCache,
  MODEL_CACHE_TTL_MS,
  normalizeProviderModels,
  type ApiKeyModelCacheFile,
  type ApiKeyModelCachePersistence,
} from "@src/auth/api-key-model-cache.js";

function createMemoryPersistence(initial: ApiKeyModelCacheFile = { entries: {} }): ApiKeyModelCachePersistence & { snapshot(): ApiKeyModelCacheFile } {
  let stored = initial;
  return {
    load: () => ({ entries: { ...stored.entries } }),
    save: (cache) => {
      stored = { entries: { ...cache.entries } };
    },
    snapshot: () => stored,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiKeyModelCache", () => {
  it("isolates cached models by API key and force-refreshes the matching entry", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-one", name: "GPT One" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-two", name: "GPT Two" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-one-fresh", name: "GPT One Fresh" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const first = await cache.fetchModels({ provider: "openai", apiKey: "key-one" });
    const second = await cache.fetchModels({ provider: "openai", apiKey: "key-two" });
    const forced = await cache.fetchModels({ provider: "openai", apiKey: "key-one", force: true });
    const secondCached = await cache.fetchModels({ provider: "openai", apiKey: "key-two" });

    expect(first.models).toEqual([{ id: "gpt-one", displayName: "GPT One" }]);
    expect(first).toMatchObject({ fromCache: false, stale: false });
    expect(first.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second).toMatchObject({ models: [{ id: "gpt-two", displayName: "GPT Two" }], fromCache: false, stale: false });
    expect(forced).toMatchObject({ models: [{ id: "gpt-one-fresh", displayName: "GPT One Fresh" }], fromCache: false, stale: false });
    expect(secondCached).toMatchObject({ models: second.models, fromCache: true, stale: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const snapshot = persistence.snapshot();
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(Object.keys(snapshot.entries).every((key) => /#provider=openai&wire=chat&key=[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("key-one");
    expect(JSON.stringify(snapshot)).not.toContain("key-two");
  });

  it("forces a fresh fetch even when a non-expired cache entry exists", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "cached" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "fresh" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => new Date("2026-01-01T00:30:00Z"),
    });

    await cache.fetchModels({ provider: "openai", apiKey: "key" });
    const cached = await cache.fetchModels({ provider: "openai", apiKey: "key" });
    const forced = await cache.fetchModels({ provider: "openai", apiKey: "key", force: true });

    expect(cached).toMatchObject({ fromCache: true, models: [{ id: "cached", displayName: "cached" }] });
    expect(forced).toMatchObject({ fromCache: false, models: [{ id: "fresh", displayName: "fresh" }] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("falls back to a stale cache entry when a refresh fails, and force surfaces the error", async () => {
    let now = new Date(new Date("2026-01-01T00:00:00Z").getTime() - MODEL_CACHE_TTL_MS - 1);
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "stale" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => now,
    });

    await cache.fetchModels({ provider: "openai", apiKey: "key" });
    now = new Date("2026-01-01T00:00:00Z");
    fetchFn.mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await cache.fetchModels({ provider: "openai", apiKey: "key" });
    expect(result).toMatchObject({ models: [{ id: "stale", displayName: "stale" }], fromCache: true, stale: true });
    fetchFn.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(cache.fetchModels({ provider: "openai", apiKey: "key", force: true }))
      .rejects.toMatchObject({ kind: "network" });
  });

  it("expires cache entries after the TTL", async () => {
    let now = new Date(new Date("2026-01-01T00:00:00Z").getTime() - MODEL_CACHE_TTL_MS - 1);
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "stale" }] }));
    const cache = new ApiKeyModelCache({
      persistence,
      fetchFn,
      now: () => now,
    });

    await cache.fetchModels({ provider: "openai", apiKey: "key" });
    now = new Date("2026-01-01T00:00:00Z");
    fetchFn.mockResolvedValueOnce(jsonResponse({ data: [{ id: "fresh" }] }));
    await expect(cache.fetchModels({ provider: "openai", apiKey: "key" })).resolves.toMatchObject({ models: [{ id: "fresh", displayName: "fresh" }], fromCache: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("includes original error message for network failures", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED 127.0.0.1:443"); });
    const cache = new ApiKeyModelCache({ persistence: createMemoryPersistence(), fetchFn });

    await expect(cache.fetchModels({ provider: "openai", apiKey: "sk" }))
      .rejects.toMatchObject({ kind: "network", message: expect.stringContaining("ECONNREFUSED") });
  });

  it("uses a Gemini request key without storing it in the cache URL", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] }));
    const cache = new ApiKeyModelCache({ persistence, fetchFn });

    await cache.fetchModels({ provider: "gemini", apiKey: "gem-key" });

    const requestedUrl = String(fetchFn.mock.calls[0][0]);
    expect(requestedUrl).toContain("key=gem-key");
    expect(Object.keys(persistence.snapshot().entries)).toEqual([
      expect.stringMatching(/https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models#provider=gemini&wire=gemini&key=[0-9a-f]{64}/),
    ]);
    expect(JSON.stringify(persistence.snapshot())).not.toContain("gem-key");
  });

  it("uses x-api-key for Anthropic model discovery", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "claude-test", display_name: "Claude Test" }] }));
    const cache = new ApiKeyModelCache({ persistence: createMemoryPersistence(), fetchFn });

    await cache.fetchModels({ provider: "custom", apiKey: "sk-ant", baseUrl: "https://anthropic.example.com/v1", wire: "anthropic" });

    expect(fetchFn.mock.calls[0][1]).toEqual({
      headers: {
        "x-api-key": "sk-ant",
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
  });

  it("builds custom provider cache keys from normalized model URLs, wire, and key digest", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "custom-one" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "custom-two" }] }));
    const cache = new ApiKeyModelCache({ persistence, fetchFn });

    await cache.fetchModels({ provider: "custom", apiKey: "custom-key", baseUrl: "https://example.com/v1/" });
    await cache.fetchModels({ provider: "custom", apiKey: "another-key", baseUrl: "https://example.com/v1" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(Object.keys(persistence.snapshot().entries)).toEqual([
      expect.stringMatching(/https:\/\/example\.com\/v1\/models#provider=custom&wire=chat&key=[0-9a-f]{64}/),
      expect.stringMatching(/https:\/\/example\.com\/v1\/models#provider=custom&wire=chat&key=[0-9a-f]{64}/),
    ]);
    expect(JSON.stringify(persistence.snapshot())).not.toContain("custom-key");
    expect(JSON.stringify(persistence.snapshot())).not.toContain("another-key");
  });

  it("does not reuse custom model cache entries across different wires", async () => {
    const persistence = createMemoryPersistence();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("key=")) return jsonResponse({ models: [{ name: "models/gemini-model", displayName: "Gemini Model" }] });
      return jsonResponse({ data: [{ id: "chat-model", name: "Chat Model" }] });
    });
    const cache = new ApiKeyModelCache({ persistence, fetchFn });

    const chatModels = await cache.fetchModels({ provider: "custom", apiKey: "custom-key", baseUrl: "https://example.com/v1", wire: "chat" });
    const geminiModels = await cache.fetchModels({ provider: "custom", apiKey: "custom-key", baseUrl: "https://example.com/v1", wire: "gemini" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(chatModels.models).toEqual([{ id: "chat-model", displayName: "Chat Model" }]);
    expect(geminiModels.models).toEqual([{ id: "gemini-model", displayName: "Gemini Model" }]);
    expect(Object.keys(persistence.snapshot().entries).every((key) => /https:\/\/example\.com\/v1\/models#provider=custom&wire=(chat|gemini)&key=[0-9a-f]{64}/.test(key))).toBe(true);
    expect(Object.keys(persistence.snapshot().entries).some((key) => key.includes("wire=chat"))).toBe(true);
    expect(Object.keys(persistence.snapshot().entries).some((key) => key.includes("wire=gemini"))).toBe(true);
  });

  it("does not use token-scoped entries in the anonymous built-in catalog", () => {
    const persistence = createMemoryPersistence({
      entries: {
        "https://api.anthropic.com/v1/models": {
          url: "https://api.anthropic.com/v1/models",
          fetchedAt: "2026-01-01T00:00:00Z",
          models: [{ id: "claude-test", displayName: "Claude Test" }],
        },
      },
    });
    const cache = new ApiKeyModelCache({
      persistence,
      now: () => new Date("2026-01-01T00:30:00Z"),
    });

    const catalog = cache.getCatalogWithCachedModels();

    expect(catalog.anthropic.models).not.toEqual([{ id: "claude-test", displayName: "Claude Test" }]);
    expect(catalog.openai.models.length).toBeGreaterThan(0);
    expect(catalog.openai.models[0]).toHaveProperty("id");
  });

  it("normalizes provider model payloads", () => {
    expect(normalizeProviderModels({ provider: "openai" }, { data: [{ id: "gpt", name: "GPT" }, { id: "gpt", name: "Duplicate" }] })).toEqual([
      { id: "gpt", displayName: "Duplicate" },
    ]);
    expect(normalizeProviderModels({ provider: "anthropic" }, { data: [{ id: "claude", display_name: "Claude" }] })).toEqual([
      { id: "claude", displayName: "Claude" },
    ]);
    expect(normalizeProviderModels({ provider: "gemini" }, { models: [{ name: "models/gemini", displayName: "Gemini" }] })).toEqual([
      { id: "gemini", displayName: "Gemini" },
    ]);
    expect(normalizeProviderModels({ provider: "custom" }, { data: [{ id: "custom", display_name: "Custom" }] })).toEqual([
      { id: "custom", displayName: "Custom" },
    ]);
    expect(normalizeProviderModels({ provider: "custom", wire: "anthropic" }, { data: [{ id: "claude-custom", display_name: "Claude Custom" }] })).toEqual([
      { id: "claude-custom", displayName: "Claude Custom" },
    ]);
    expect(normalizeProviderModels({ provider: "custom", wire: "gemini" }, { models: [{ name: "models/gemini-custom", displayName: "Gemini Custom" }] })).toEqual([
      { id: "gemini-custom", displayName: "Gemini Custom" },
    ]);
  });
});
