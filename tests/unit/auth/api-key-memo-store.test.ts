import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyMemoStore, memoSignature } from "@src/auth/api-key-memo-store.js";
import type { ApiKeyMemoPersistence } from "@src/auth/api-key-memo-store.js";

function createMemoryPersistence(): ApiKeyMemoPersistence & { snapshot(): { memos: unknown[] } } {
  let stored: unknown[] = [];
  return {
    load: () => ({ memos: stored.map((m) => ({ ...m })) } as never),
    save: (memos) => {
      stored = memos.map((m) => ({ ...m }));
    },
    snapshot: () => ({ memos: stored }),
  };
}

const sample = {
  name: "My Relay",
  provider: "custom" as const,
  baseUrl: "https://example.com/v1",
  wire: "codex-responses" as const,
  apiKey: "sk-secret",
  capabilities: ["chat" as const],
};

describe("ApiKeyMemoStore", () => {
  let persistence: ReturnType<typeof createMemoryPersistence>;
  let store: ApiKeyMemoStore;

  beforeEach(() => {
    persistence = createMemoryPersistence();
    store = new ApiKeyMemoStore(persistence);
  });

  it("creates a memo with defaults and persists it", () => {
    const memo = store.create(sample);
    expect(memo.id).toBeTruthy();
    expect(memo.name).toBe("My Relay");
    expect(memo.capabilities).toEqual(["chat"]);
    expect(memo.models).toEqual([]);
    expect(memo.modelsFetchedAt).toBeNull();
    expect(persistence.snapshot().memos).toHaveLength(1);
  });

  it("derives the memo name from the base URL host when absent", () => {
    const memo = store.create({ ...sample, name: undefined });
    expect(memo.name).toBe("example.com");
  });

  it("returns the existing memo when the signature matches (no duplicates)", () => {
    const first = store.create(sample);
    const second = store.create({ ...sample, name: "Renamed" });
    expect(second.id).toBe(first.id);
    expect(persistence.snapshot().memos).toHaveLength(1);
  });

  it("treats different capabilities as a different memo", () => {
    const first = store.create(sample);
    const second = store.create({ ...sample, capabilities: ["chat", "embeddings" as const] });
    expect(second.id).not.toBe(first.id);
    expect(persistence.snapshot().memos).toHaveLength(2);
  });

  it("isCovered mirrors signature equality", () => {
    store.create(sample);
    expect(store.isCovered(sample)).toBe(true);
    expect(store.isCovered({ ...sample, apiKey: "sk-other" })).toBe(false);
    expect(store.isCovered({ ...sample, wire: "chat" as const })).toBe(false);
  });

  it("updates the key and clears the old model snapshot", () => {
    const memo = store.create(sample);
    store.setModels(memo.id, [{ id: "gpt-6", displayName: "GPT 6" }], "2026-09-09T00:00:00Z");
    const updated = store.update(memo.id, { apiKey: "sk-new", name: "  " });
    expect(updated?.id).toBe(memo.id);
    expect(updated?.apiKey).toBe("sk-new");
    expect(updated?.name).toBe("My Relay");
    expect(updated?.models).toEqual([]);
    expect(updated?.modelsFetchedAt).toBeNull();
  });

  it("setModels stores the fetched snapshot", () => {
    const memo = store.create(sample);
    const updated = store.setModels(memo.id, [{ id: "gpt-6", displayName: "GPT 6" }], "2026-09-09T00:00:00Z");
    expect(updated?.models).toEqual([{ id: "gpt-6", displayName: "GPT 6" }]);
    expect(updated?.modelsFetchedAt).toBe("2026-09-09T00:00:00Z");
    expect(store.get(memo.id)?.models).toHaveLength(1);
  });

  it("remove deletes only the requested memo", () => {
    const a = store.create(sample);
    const b = store.create({ ...sample, apiKey: "sk-2" });
    expect(store.remove(a.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeDefined();
  });

  it("generateFromEntries groups by signature and skips covered groups", () => {
    store.create(sample);
    const result = store.generateFromEntries([
      { ...sample },
      { ...sample, model: "gpt-6" },
      { ...sample, apiKey: "sk-2", model: "gpt-5.6" },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(persistence.snapshot().memos).toHaveLength(2);
  });

  it("memoSignature is order-insensitive for capabilities", () => {
    const a = memoSignature({ ...sample, capabilities: ["chat", "embeddings" as const] });
    const b = memoSignature({ ...sample, capabilities: ["embeddings" as const, "chat"] });
    expect(a).toBe(b);
  });
});
