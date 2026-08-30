import { beforeEach, describe, expect, it } from "vitest";
import { getLayoutMode, saveLayoutMode } from "../../../web/src/lib/layout-preferences";

describe("layout preferences", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    globalThis.localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      length: Object.keys(store).length,
    };
  });

  it("defaults to the sidebar and persists the classic layout choice", () => {
    expect(getLayoutMode()).toBe("sidebar");

    saveLayoutMode("top");

    expect(getLayoutMode()).toBe("top");
  });

  it("falls back to the sidebar for unknown values", () => {
    globalThis.localStorage.setItem("codex-proxy-layout-mode", "unknown");

    expect(getLayoutMode()).toBe("sidebar");
  });

  it("falls back gracefully when localStorage throws", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("Storage disabled");
      },
      setItem: () => {
        throw new Error("Storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    expect(getLayoutMode()).toBe("sidebar");
    expect(() => saveLayoutMode("top")).not.toThrow();
  });
});
