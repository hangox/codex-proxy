/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { getLayoutMode, saveLayoutMode } from "./layout-preferences";

describe("layout preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the sidebar and persists the classic layout choice", () => {
    expect(getLayoutMode()).toBe("sidebar");

    saveLayoutMode("top");

    expect(getLayoutMode()).toBe("top");
  });

  it("falls back to the sidebar for unknown values", () => {
    localStorage.setItem("codex-proxy-layout-mode", "unknown");

    expect(getLayoutMode()).toBe("sidebar");
  });
});
