import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyMemoStore } from "@src/auth/api-key-memo-store.js";
import type { ApiKeyMemoPersistence } from "@src/auth/api-key-memo-store.js";
import { ApiKeyModelCache } from "@src/auth/api-key-model-cache.js";
import { refreshAllMemoModels } from "@src/memo-model-refresher.js";

function createMemoryMemoPersistence(): ApiKeyMemoPersistence {
  let stored: ReturnType<ApiKeyMemoStore["list"]> = [];
  return {
    load: () => ({ memos: stored.map((m) => ({ ...m })) }),
    save: (memos) => {
      stored = memos.map((m) => ({ ...m }));
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("refreshAllMemoModels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces a live fetch per memo and stores the snapshot on each", async () => {
    const store = new ApiKeyMemoStore(createMemoryMemoPersistence());
    store.create({ provider: "custom", baseUrl: "https://a.example.com/v1", wire: "chat", apiKey: "sk-a" });
    store.create({ provider: "custom", baseUrl: "https://b.example.com/v1", wire: "chat", apiKey: "sk-b" });
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: `model-${fetchFn.mock.calls.length}` }] }));
    const cache = new ApiKeyModelCache({ fetchFn });

    const walk = refreshAllMemoModels(store, cache, { warn: () => {} });
    await vi.runAllTimersAsync();
    const result = await walk;

    expect(result).toEqual({ refreshed: 2, failed: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // force=true must bypass the shared URL-keyed cache
    const bodies = fetchFn.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(bodies[0]).toMatchObject({ Authorization: "Bearer sk-a" });
    expect(bodies[1]).toMatchObject({ Authorization: "Bearer sk-b" });
    const [first, second] = store.list();
    expect(first?.models).toEqual([{ id: "model-1", displayName: "model-1" }]);
    expect(second?.models).toEqual([{ id: "model-2", displayName: "model-2" }]);
    expect(first?.modelsFetchedAt).toBeTruthy();
  });

  it("keeps walking when a memo refresh fails", async () => {
    const store = new ApiKeyMemoStore(createMemoryMemoPersistence());
    store.create({ provider: "custom", baseUrl: "https://bad.example.com/v1", wire: "chat", apiKey: "sk-bad" });
    store.create({ provider: "custom", baseUrl: "https://good.example.com/v1", wire: "chat", apiKey: "sk-good" });
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("bad")) throw new Error("ECONNRESET");
      return jsonResponse({ data: [{ id: "m" }] });
    });
    const cache = new ApiKeyModelCache({ fetchFn });
    const warns: string[] = [];

    const walk = refreshAllMemoModels(store, cache, { warn: (msg: string) => warns.push(msg) });
    await vi.runAllTimersAsync();
    const result = await walk;

    expect(result).toEqual({ refreshed: 1, failed: 1 });
    expect(warns.join("\n")).toContain("bad.example.com");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("completes immediately with zero memos", async () => {
    const store = new ApiKeyMemoStore(createMemoryMemoPersistence());
    const cache = new ApiKeyModelCache({ fetchFn: vi.fn() });
    const result = await refreshAllMemoModels(store, cache);
    expect(result).toEqual({ refreshed: 0, failed: 0 });
  });
});
