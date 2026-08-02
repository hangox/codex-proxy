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

import { budgetToEffort, buildInstructions, clampReasoningEffortToModel } from "@src/translation/shared-utils.js";
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

/**
 * ★★ 8.15：`clampReasoningEffortToModel` 的独立单测——qa 实测过不钳制的
 * 真实后果（gpt-5.4-mini + "max" → 上游连接空转、3 次重试全空、502），
 * 这里锁住钳制算法本身的边界行为。`anthropic-to-codex.test.ts` 里的
 * "output_config.effort" 那组测试用的是这个函数的 mock（复刻同一份逻辑），
 * 不重复验证算法本身对不对，职责分开：那边测优先级链接线对不对，这里测
 * 算法本身对不对。
 */
describe("clampReasoningEffortToModel", () => {
  function model(efforts: string[]): Pick<CodexModelInfo, "supportedReasoningEfforts"> {
    return { supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: "" })) };
  }

  it("请求的档位在支持列表里——原样放行，不钳制", () => {
    const result = clampReasoningEffortToModel("high", model(["low", "medium", "high", "xhigh"]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: ["low", "medium", "high", "xhigh"] });
  });

  it("★ 请求的档位超出模型支持范围——钳到该模型支持的最高档，不是钳到最接近的档", () => {
    // gpt-5.4-mini 那类真实场景：只到 xhigh，客户端选 max。
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
    expect(result.supported).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("请求 ultra，模型只到 max——钳到 max", () => {
    const result = clampReasoningEffortToModel("ultra", model(["low", "medium", "high", "xhigh", "max"]));
    expect(result.effort).toBe("max");
    expect(result.clamped).toBe(true);
  });

  it("请求的档位是模型支持列表里的最高档本身——不钳制（边界：等于上限不算超出）", () => {
    const result = clampReasoningEffortToModel("xhigh", model(["low", "medium", "high", "xhigh"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("xhigh");
  });

  it("模型声明支持 max/ultra——请求 max 原样放行，不钳到 xhigh", () => {
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh", "max", "ultra"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("max");
  });

  it("modelInfo 为 undefined（未知型号，没有任何元数据）——不钳制，原样放行", () => {
    const result = clampReasoningEffortToModel("ultra", undefined);
    expect(result).toEqual({ effort: "ultra", clamped: false, supported: [] });
  });

  it("supportedReasoningEfforts 是空数组（比如纯图片生成模型）——不钳制，原样放行", () => {
    const result = clampReasoningEffortToModel("high", model([]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: [] });
  });

  it("支持列表乱序也能正确找到最高档（不依赖声明顺序）", () => {
    const result = clampReasoningEffortToModel("ultra", model(["xhigh", "low", "high", "medium"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
  });

  it("请求的档位是完全未知的字符串（既不在支持列表也不在排序表里）——钳到支持列表里排序最高的那个", () => {
    const result = clampReasoningEffortToModel("super-ultra-mega", model(["low", "medium", "high"]));
    expect(result.effort).toBe("high");
    expect(result.clamped).toBe(true);
  });
});
