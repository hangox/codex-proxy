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

/**
 * ★★ 8.15：`clampReasoningEffortToModel` 的独立单测——qa 实测过不钳制的
 * 真实后果（gpt-5.4-mini + "max" → 上游连接空转、3 次重试全空、502），
 * 这里锁住钳制算法本身的边界行为。`anthropic-to-codex.test.ts` 里的
 * "output_config.effort" 那组测试用的是这个函数的 mock（复刻同一份逻辑），
 * 不重复验证算法本身对不对，职责分开：那边测优先级链接线对不对，这里测
 * 算法本身对不对。
 */
describe("isRecognizedReasoningEffort", () => {
  it("识别所有已知档位", () => {
    for (const e of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(isRecognizedReasoningEffort(e)).toBe(true);
    }
  });

  it("不认识空字符串、大小写变体、完全陌生的字符串", () => {
    expect(isRecognizedReasoningEffort("")).toBe(false);
    expect(isRecognizedReasoningEffort("High")).toBe(false); // 大小写敏感，不做归一化猜测
    expect(isRecognizedReasoningEffort("banana")).toBe(false);
  });
});

/**
 * ★★ 8.16：`clampReasoningEffortToModel` 的钳制方向修复——8.15 那版
 * "不在支持列表里就钳到最高档"是任务描述阶段的方向性错误（只想到了 qa
 * 实测的 `mini+max→502` 这一个方向，完全没考虑"请求的档位低于模型下限"
 * 这个反方向），实现和两轮 review 都没跳出这个框，直到生产
 * `models-cache.yaml` 里找出反例才发现——见 `shared-utils.ts` 里这个
 * 函数头部注释的完整背景。这里的测试模型形状尽量用真实生产型号（
 * `gpt-5.4-pro`: medium/high/xhigh 不含 low；`gpt-5-2-pro`: 只有单档
 * medium），不编造不存在的组合。
 */
describe("clampReasoningEffortToModel", () => {
  function model(efforts: string[]): Pick<CodexModelInfo, "supportedReasoningEfforts"> {
    return { supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: "" })) };
  }

  it("请求的档位在支持列表里——原样放行，不钳制", () => {
    const result = clampReasoningEffortToModel("high", model(["low", "medium", "high", "xhigh"]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: ["low", "medium", "high", "xhigh"] });
  });

  it("请求高于模型支持上限——钳到上限（回归：8.15 覆盖过的方向，这次不能改坏）", () => {
    // gpt-5.4-mini 那类真实场景：只到 xhigh，客户端选 max。
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
    expect(result.supported).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("★★ 请求低于模型支持下限——钳到下限，不是钳到上限（这是这轮真正要修的方向）", () => {
    // 真实 gpt-5.4-pro 的形状：medium/high/xhigh，不含 low。客户端要最
    // 便宜的 low，绝不能给出最贵的 xhigh。
    const result = clampReasoningEffortToModel("low", model(["medium", "high", "xhigh"]));
    expect(result.effort).toBe("medium");
    expect(result.clamped).toBe(true);
  });

  it("请求 minimal，模型最低只到 medium——同样钳到下限 medium", () => {
    const result = clampReasoningEffortToModel("minimal", model(["medium", "high", "xhigh"]));
    expect(result.effort).toBe("medium");
    expect(result.clamped).toBe(true);
  });

  it("★ 请求落在区间内但不是声明支持的具体值——钳到距离更近的那个（不是上限也不是下限，是真正的最近邻）", () => {
    // 模型只支持 low 和 xhigh（跳过中间档），请求 medium：
    // medium(3) 到 low(2) 距离1，到 xhigh(5) 距离2 → 应该钳到 low。
    const result = clampReasoningEffortToModel("medium", model(["low", "xhigh"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("★ 距离相等时取更低的档位——不确定时不该替用户多花钱", () => {
    // 模型只支持 low 和 high，请求 medium：medium(3) 到 low(2) 距离1，
    // 到 high(4) 距离1，平局，必须取 low。
    const result = clampReasoningEffortToModel("medium", model(["low", "high"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("★ 只有单档的模型（真实 gpt-5-2-pro 的形状，只有 medium）——无论请求什么都钳到这唯一一档", () => {
    for (const requested of ["none", "minimal", "low", "high", "xhigh", "max", "ultra"]) {
      const result = clampReasoningEffortToModel(requested, model(["medium"]));
      expect(result.effort).toBe("medium");
      expect(result.clamped).toBe(true);
    }
  });

  it("请求的档位是模型支持列表里的最高档本身——不钳制（边界：等于上限不算超出）", () => {
    const result = clampReasoningEffortToModel("xhigh", model(["low", "medium", "high", "xhigh"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("xhigh");
  });

  it("模型声明支持 max/ultra——请求 max 原样放行，不钳到别的档位", () => {
    const result = clampReasoningEffortToModel("max", model(["low", "medium", "high", "xhigh", "max", "ultra"]));
    expect(result.clamped).toBe(false);
    expect(result.effort).toBe("max");
  });

  it("modelInfo 为 undefined（未知型号，没有任何元数据）——不钳制，原样放行（回归）", () => {
    const result = clampReasoningEffortToModel("ultra", undefined);
    expect(result).toEqual({ effort: "ultra", clamped: false, supported: [] });
  });

  it("supportedReasoningEfforts 是空数组（比如纯图片生成模型）——不钳制，原样放行（回归）", () => {
    const result = clampReasoningEffortToModel("high", model([]));
    expect(result).toEqual({ effort: "high", clamped: false, supported: [] });
  });

  it("支持列表乱序也能正确找到最近邻（不依赖声明顺序）", () => {
    const result = clampReasoningEffortToModel("ultra", model(["xhigh", "low", "high", "medium"]));
    expect(result.effort).toBe("xhigh");
    expect(result.clamped).toBe(true);
  });

  // ★★ 8.16：这个函数自己对"完全未知字符串"的防御性兜底——主防线在调用方
  // （`translateAnthropicToCodexRequest` 用 `isRecognizedReasoningEffort`
  // 提前过滤，未识别值视为未提供、走 fallback 链，见该调用点注释），这里
  // 测的是"万一有别的调用方没做那层过滤，直接把未知字符串传进来"时这个
  // 函数自己的行为——未知档位的 rank 记为 -1（比所有已知档位都低），因此
  // 会被判定为"最接近支持列表里 rank 最低的那个"，即钳到最低档，不是最高
  // 档。选这个方向的理由和"距离相等时取更低"一致：面对完全不认识的值，
  // 不确定时不该替用户多花钱。
  it("请求的档位是完全未知的字符串——钳到支持列表里 rank 最低的那个（不是最高），这是这个函数自己的防御性默认方向", () => {
    const result = clampReasoningEffortToModel("banana", model(["low", "medium", "high"]));
    expect(result.effort).toBe("low");
    expect(result.clamped).toBe(true);
  });

  it("未知字符串 + 模型只支持 high/xhigh（不含更低档）——仍然钳到这份列表里最低的 high", () => {
    const result = clampReasoningEffortToModel("banana", model(["high", "xhigh"]));
    expect(result.effort).toBe("high");
    expect(result.clamped).toBe(true);
  });
});
