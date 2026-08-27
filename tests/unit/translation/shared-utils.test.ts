import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "Desktop context prompt content"),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      inject_desktop_context: true,
      suppress_desktop_directives: true,
    },
  })),
}));

import { budgetToEffort, buildInstructions, clampReasoningEffortToModel, isRecognizedReasoningEffort } from "@src/translation/shared-utils.js";
import { getConfig } from "@src/config.js";
import type { CodexModelInfo } from "@src/models/model-store.js";

describe("budgetToEffort", () => {
  it("returns undefined for 0", () => {
    expect(budgetToEffort(0)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(budgetToEffort(undefined)).toBeUndefined();
  });

  it("returns undefined for negative", () => {
    expect(budgetToEffort(-100)).toBeUndefined();
  });

  it("returns 'low' for budget < 2000", () => {
    expect(budgetToEffort(1000)).toBe("low");
    expect(budgetToEffort(1999)).toBe("low");
  });

  it("returns 'medium' for budget < 8000", () => {
    expect(budgetToEffort(2000)).toBe("medium");
    expect(budgetToEffort(5000)).toBe("medium");
    expect(budgetToEffort(7999)).toBe("medium");
  });

  it("returns 'high' for budget < 20000", () => {
    expect(budgetToEffort(8000)).toBe("high");
    expect(budgetToEffort(15000)).toBe("high");
    expect(budgetToEffort(19999)).toBe("high");
  });

  it("returns 'xhigh' for budget >= 20000", () => {
    expect(budgetToEffort(20000)).toBe("xhigh");
    expect(budgetToEffort(25000)).toBe("xhigh");
  });
});

describe("buildInstructions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends suppress prompt when suppress_desktop_directives is true", async () => {
    // Re-import to get fresh cache
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("user instructions");
    expect(result).toContain("user instructions");
    // When desktop context is loaded and suppress is on, should contain suppress marker
    expect(result).toContain("NOT applicable");
  });

  it("returns string containing user instructions", async () => {
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("custom instructions");
    expect(result).toContain("custom instructions");
    expect(typeof result).toBe("string");
  });

  it("includes desktop context when available", async () => {
    const mod = await import("@src/translation/shared-utils.js");
    const result = mod.buildInstructions("user text");
    // Desktop context is mocked as "Desktop context prompt content"
    expect(result).toContain("user text");
    expect(result).toContain("Desktop context");
  });
});

describe("budgetToEffort additional edge cases", () => {
  it("returns 'low' for budget = 1 (minimum positive)", () => {
    expect(budgetToEffort(1)).toBe("low");
  });

  it("returns undefined for budget = -1", () => {
    expect(budgetToEffort(-1)).toBeUndefined();
  });

  it("returns 'xhigh' for very large budget (100000)", () => {
    expect(budgetToEffort(100000)).toBe("xhigh");
  });
});

describe("isRecognizedReasoningEffort", () => {
  it("recognizes every known level", () => {
    for (const e of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(isRecognizedReasoningEffort(e)).toBe(true);
    }
  });

  it("rejects empty strings, case variants, and unknown names", () => {
    expect(isRecognizedReasoningEffort("")).toBe(false);
    expect(isRecognizedReasoningEffort("High")).toBe(false); // case-sensitive, no guessing
    expect(isRecognizedReasoningEffort("banana")).toBe(false);
  });
});

describe("clampReasoningEffortToModel", () => {
  function model(efforts: string[]): Pick<CodexModelInfo, "supportedReasoningEfforts"> {
    return { supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: "" })) };
  }

  it("passes through a requested level that is in the supported list", () => {
    const result = clampReasoningEffortToModel("high", model(["low", "medium", "high", "xhigh"]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: ["low", "medium", "high", "xhigh"] });
  });

  it("clamps to the model's max when requested above it", () => {
    // Real gpt-5.4-mini shape: supports up to xhigh, client asks for max.
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
  });

  it("clamps to the model's min when requested below it", () => {
    // Real gpt-5.4-pro shape: medium/high/xhigh, no low. Client asking for
    // the cheapest low must NOT get the most expensive xhigh.
    const result = clampReasoningEffortToModel("low", model(["medium", "high", "xhigh"]));
    expect(result.effort).toBe("medium");
    expect(result.clamped).toBe(true);
  });

  it("clamps minimal to the model's min too", () => {
    const result = clampReasoningEffortToModel("minimal", model(["medium", "high", "xhigh"]));
    expect(result.effort).toBe("medium");
    expect(result.clamped).toBe(true);
  });

  it("clamps to the nearest supported level when requested between supported ones", () => {
    // Model supports only low and xhigh; medium(3) is distance 1 from low(2)
    // and distance 2 from xhigh(5) → low.
    const result = clampReasoningEffortToModel("medium", model(["low", "xhigh"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("breaks rank-distance ties toward the lower level", () => {
    // Model supports only low and high; medium(3) is distance 1 from both →
    // must pick low, never charge the user more when uncertain.
    const result = clampReasoningEffortToModel("medium", model(["low", "high"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("single-level models always clamp to that one level", () => {
    // Real gpt-5-2-pro shape: single "medium" level.
    for (const requested of ["none", "minimal", "low", "high", "xhigh", "max", "ultra"]) {
      const result = clampReasoningEffortToModel(requested, model(["medium"]));
      expect(result.effort).toBe("medium");
      expect(result.clamped).toBe(true);
    }
  });

  it("does not clamp when the requested level equals the model's max", () => {
    const result = clampReasoningEffortToModel("xhigh", model(["low", "medium", "high", "xhigh"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("xhigh");
  });

  it("passes through max on models that support it", () => {
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh", "max", "ultra"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("max");
  });

  it("passes through unchanged when modelInfo is undefined", () => {
    const result = clampReasoningEffortToModel("ultra", undefined);
    expect(result).toEqual({ effort: "ultra", clamped: false, supported: [] });
  });

  it("passes through unchanged when the supported list is empty", () => {
    const result = clampReasoningEffortToModel("high", model([]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: [] });
  });

  it("finds the nearest level regardless of declaration order", () => {
    const result = clampReasoningEffortToModel("ultra", model(["xhigh", "low", "high", "medium"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
  });

  it("clamps unknown level strings to the lowest supported level (cheaper direction)", () => {
    const result = clampReasoningEffortToModel("banana", model(["low", "medium", "high"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("clamps unknown strings to the lowest supported level even when the list has no lower tiers", () => {
    const result = clampReasoningEffortToModel("banana", model(["high", "xhigh"]));
    expect(result.effort).toBe("high");
    expect(result.clamped).toBe(true);
  });
});
