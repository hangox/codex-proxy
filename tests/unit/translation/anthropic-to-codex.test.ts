/**
 * Tests for translateAnthropicToCodexRequest — Anthropic Messages → Codex format.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

// ★ 8.15/8.16：`clampReasoningEffortToModel`/`isRecognizedReasoningEffort`
// 的 mock 复刻真实实现的行为（不是 stub 成恒等函数）——因为本文件里
// "output_config.effort 优先级最高"/"钳制"这两组新测试依赖它们的真实
// 语义（不在 supported 列表里就钳到最接近的档、supported 为空就不钳、
// 未识别的档位名视为未提供）。算法本身的独立单测在
// `tests/unit/translation/shared-utils.test.ts`，这里只是复用同一份逻辑
// 让翻译层的优先级测试能跑通，不重复验证算法本身对不对。
const REASONING_EFFORT_RANK: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7,
};
vi.mock("@src/translation/shared-utils.js", () => ({
  buildInstructions: vi.fn((text: string) => text),
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  budgetToEffort: vi.fn((budget: number | undefined) => {
    if (!budget || budget <= 0) return undefined;
    if (budget < 2000) return "low";
    if (budget < 8000) return "medium";
    if (budget < 20000) return "high";
    return "xhigh";
  }),
  isRecognizedReasoningEffort: vi.fn((effort: string) => Object.hasOwn(REASONING_EFFORT_RANK, effort)),
  // ★ 8.16：钳到"最接近"的支持档位，不是永远钳到最高——8.15 那版"永远
  // 钳到最高"的方向性错误已经修掉，mock 必须跟着换，否则这里的测试会
  // 继续验证一个已经被证明是错的行为。
  clampReasoningEffortToModel: vi.fn(
    (effort: string, modelInfo: { supportedReasoningEfforts?: { reasoningEffort: string }[] } | undefined) => {
      const supported = (modelInfo?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
      if (supported.length === 0 || supported.includes(effort)) {
        return { effort, clamped: false, supported };
      }
      const rankOf = (e: string) => REASONING_EFFORT_RANK[e] ?? -1;
      const requestedRank = rankOf(effort);
      const nearest = [...supported].sort((a, b) => {
        const d = Math.abs(rankOf(a) - requestedRank) - Math.abs(rankOf(b) - requestedRank);
        return d !== 0 ? d : rankOf(a) - rankOf(b);
      })[0];
      return { effort: nearest ?? effort, clamped: true, supported };
    },
  ),
}));

vi.mock("@src/translation/tool-format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/translation/tool-format.js")>();
  return {
    ...actual,
    anthropicToolsToCodex: vi.fn(actual.anthropicToolsToCodex),
    anthropicToolChoiceToCodex: vi.fn(() => undefined),
  };
});

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((input: string) => {
    if (input === "codex") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: null };
    if (input === "gpt-5.4-fast") return { modelId: "gpt-5.4", serviceTier: "fast", reasoningEffort: null };
    if (input === "gpt-5.4-high") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: "high" };
    return { modelId: input, serviceTier: null, reasoningEffort: null };
  }),
  getModelInfo: vi.fn((id: string) => {
    if (id === "gpt-5.4") return { defaultReasoningEffort: "medium" };
    // ★ 8.15：专供 output_config.effort 优先级/钳制测试用——只声明到
    // xhigh，不含 max/ultra，模拟真实 gpt-5.4-mini 那类模型。
    if (id === "limited-effort-model") {
      return {
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
          { reasoningEffort: "xhigh", description: "" },
        ],
      };
    }
    // ★ 8.15：支持到 max/ultra 的模型，模拟真实 gpt-5.6-sol。
    if (id === "full-effort-model") {
      return {
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
          { reasoningEffort: "xhigh", description: "" },
          { reasoningEffort: "max", description: "" },
          { reasoningEffort: "ultra", description: "" },
        ],
      };
    }
    // ★ 8.16：真实型号（生产 models-cache.yaml 里的 gpt-5.4-pro）——不含
    // low，专供"钳到最高是方向性错误"这条回归测试用：请求 low 应该钳到
    // medium（下限），不是钳到 xhigh（上限）。
    if (id === "no-low-model") {
      return {
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
          { reasoningEffort: "xhigh", description: "" },
        ],
      };
    }
    return undefined;
  }),
}));

import { translateAnthropicToCodexRequest } from "@src/translation/anthropic-to-codex.js";
import { anthropicToolsToCodex, anthropicToolChoiceToCodex } from "@src/translation/tool-format.js";
import type { ModelConfigOverride } from "@src/translation/shared-utils.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

function makeRequest(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: "gpt-5.4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  } as AnthropicMessagesRequest;
}

/**
 * 构造一份 ModelConfigOverride 直传给 translateAnthropicToCodexRequest，
 * 避免依赖全局 config mock。默认对齐 schema 默认值，逐 case 覆盖。
 */
function makeModelConfig(
  overrides: Partial<ModelConfigOverride> = {},
): ModelConfigOverride {
  return {
    default_reasoning_effort: null,
    default_service_tier: null,
    inject_desktop_context: false,
    suppress_desktop_directives: false,
    system_prompt_strategy: "instructions",
    ...overrides,
  };
}

describe("translateAnthropicToCodexRequest", () => {
  it("does not forward max_tokens to Codex", () => {
    const result = translateAnthropicToCodexRequest(
      makeRequest({ max_tokens: 8192 }),
    );
    expect(result).not.toHaveProperty("max_output_tokens");
  });

  // ── System instructions ──────────────────────────────────────────────

  describe("system instructions", () => {
    it("uses string system as instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "Be concise." }),
      );
      expect(result.instructions).toBe("Be concise.");
    });

    it("joins text block array system into instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "First paragraph." },
            { type: "text" as const, text: "Second paragraph." },
          ],
        }),
      );
      expect(result.instructions).toBe("First paragraph.\n\nSecond paragraph.");
    });

    it("strips Claude billing header noise from system blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            {
              type: "text" as const,
              text: "x-anthropic-billing-header: cc_version=2.1.100.db0; cch=abcd1;",
            },
            { type: "text" as const, text: "Keep answers short." },
          ],
        }),
      );
      expect(result.instructions).toBe("Keep answers short.");
    });

    // Real Claude Code 2.1.84 emits the billing header as a standalone block[0]
    // with per-request rotating cc_version + cch. Tests must prove the strip is
    // invariant across that rotation, otherwise the cache-buster leaks into
    // `instructions` and tanks upstream prompt cache.
    it.each([
      "x-anthropic-billing-header: cc_version=2.1.84.c8e; cc_entrypoint=cli; cch=da09b;",
      "x-anthropic-billing-header: cc_version=2.1.84.76b; cc_entrypoint=cli; cch=46d1d;",
      "x-anthropic-billing-header: cc_version=2.1.84.f51; cc_entrypoint=cli; cch=3c1ed;",
      "x-anthropic-billing-header: cc_version=2.1.84.5b4; cc_entrypoint=cli; cch=8f29c;",
      "x-anthropic-billing-header: cc_version=2.1.84.4f3; cc_entrypoint=cli; cch=d1658;",
    ])("strips Claude Code billing header variant: %s", (billingText) => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: billingText },
            {
              type: "text" as const,
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text" as const,
              text: "\nYou are an interactive agent that helps users with software engineering tasks.",
              cache_control: { type: "ephemeral" },
            },
          ],
        }),
      );
      expect(result.instructions).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive agent that helps users with software engineering tasks.",
      );
      expect(result.instructions).not.toMatch(/cch=|cc_version=|x-anthropic-billing/);
    });

    it("produces identical instructions across rotating cc_version + cch values", () => {
      const baseSystem = (billingText: string) => [
        { type: "text" as const, text: billingText },
        {
          type: "text" as const,
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" as const },
        },
      ];
      const a = translateAnthropicToCodexRequest(
        makeRequest({
          system: baseSystem(
            "x-anthropic-billing-header: cc_version=2.1.84.c8e; cc_entrypoint=cli; cch=da09b;",
          ),
        }),
      );
      const b = translateAnthropicToCodexRequest(
        makeRequest({
          system: baseSystem(
            "x-anthropic-billing-header: cc_version=2.1.84.4f3; cc_entrypoint=cli; cch=d1658;",
          ),
        }),
      );
      expect(a.instructions).toBe(b.instructions);
    });

    it("falls back to default instructions when no system provided", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.instructions).toBe("You are a helpful assistant.");
    });
  });

  // ── Messages ─────────────────────────────────────────────────────────

  describe("messages", () => {
    it("converts user text string to input item", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("converts user with array content (text blocks) to text string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Line one" },
                { type: "text" as const, text: "Line two" },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Line one\nLine two" });
    });

    it("converts image block to input_image content part", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Describe this" },
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png",
                    data: "iVBOR...",
                  },
                },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      const item = result.input[0];
      expect(Array.isArray(item.content)).toBe(true);
      const parts = item.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "input_text", text: "Describe this" });
      expect(parts[1]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,iVBOR...",
      });
    });

    it("converts tool_use block to function_call input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_01",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItem).toBeDefined();
      expect(fcItem).toMatchObject({
        type: "function_call",
        call_id: "toolu_01",
        name: "search",
        arguments: '{"query":"test"}',
      });
    });

    it("converts tool_result block to function_call_output input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_01",
                  content: "result data",
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect(outputItem).toMatchObject({
        type: "function_call_output",
        call_id: "toolu_01",
        output: "result data",
      });
    });

    it("prepends 'Error: ' to tool_result output when is_error is true", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_02",
                  content: "something went wrong",
                  is_error: true,
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe(
        "Error: something went wrong",
      );
    });
  });

  // ── Thinking → reasoning effort ──────────────────────────────────────

  describe("thinking to reasoning effort", () => {
    it("maps enabled thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      // budgetToEffort(5000) → "medium"
      expect(result.reasoning?.effort).toBe("medium");
    });

    it("maps enabled thinking with small budget to low effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 500 },
        }),
      );
      expect(result.reasoning?.effort).toBe("low");
    });

    it("maps disabled thinking to undefined effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "disabled" },
        }),
      );
      // disabled → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });

    it("maps adaptive thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive", budget_tokens: 15000 },
        }),
      );
      // budgetToEffort(15000) → "high"
      expect(result.reasoning?.effort).toBe("high");
    });

    it("maps adaptive thinking without budget_tokens to undefined", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive" },
        }),
      );
      // adaptive without budget → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });
  });

  // ── output_config.effort（8.15：qa 抓包证实的真实 Claude Code 信号）────

  describe("output_config.effort", () => {
    it("优先级最高——比 thinking.budget_tokens 推出来的档位优先采纳", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          // adaptive 模式，budget_tokens 缺失是真实 Claude Code 的常态，
          // 这里额外显式给了 budget_tokens 是为了证明"就算两者都在，
          // output_config.effort 也赢"——不是因为 thinking 那条路失效了
          // 才轮到它。
          thinking: { type: "adaptive", budget_tokens: 500 } as never,
          output_config: { effort: "high" },
        }),
      );
      // budgetToEffort(500) 会得到 "low"，但 output_config.effort="high"
      // 必须赢。
      expect(result.reasoning?.effort).toBe("high");
    });

    it("没有 thinking 字段时单独生效（真实 Claude Code adaptive 模式的常态：只有 output_config，没有 budget_tokens）", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive" },
          output_config: { effort: "xhigh" },
        }),
      );
      expect(result.reasoning?.effort).toBe("xhigh");
    });

    it("不带 output_config 时完全不影响现有优先级链（thinking > suffix > config default）", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      expect(result.reasoning?.effort).toBe("medium");
    });

    it("★★ 钳制：模型只支持到 xhigh，客户端选 max 时钳到 xhigh，并打一行 warn 日志", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "limited-effort-model",
            output_config: { effort: "max" },
          }),
        );
        expect(result.reasoning?.effort).toBe("xhigh");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const logged = warnSpy.mock.calls[0]?.[0] as string;
        expect(logged).toContain("phase=effort_clamped");
        expect(logged).toContain("requested=max");
        expect(logged).toContain("clamped_to=xhigh");
      } finally {
        warnSpy.mockRestore();
      }
    });

    // ★★ 8.16：修方向性错误本身——8.15 那版把这种情况也钳到最高档
    // （xhigh），是"我们脑子里只有 qa 实测的 max 那个方向"导致的真实生产
    // 反例：生产 models-cache.yaml 里有 32 个模型不支持 low（比如
    // gpt-5.4-pro 只声明 medium/high/xhigh），客户端明确要最便宜的 low，
    // 旧版会给最贵的 xhigh。新版必须钳到该模型支持的下限（medium），不是
    // 上限。
    it("★★ 钳制方向修复：模型最低只支持 medium（真实 gpt-5.4-pro 的形状，不含 low），客户端选 low 时必须钳到 medium（下限），不能钳到 xhigh（上限）", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "no-low-model",
            output_config: { effort: "low" },
          }),
        );
        expect(result.reasoning?.effort).toBe("medium");
        expect(result.reasoning?.effort).not.toBe("xhigh");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const logged = warnSpy.mock.calls[0]?.[0] as string;
        expect(logged).toContain("requested=low");
        expect(logged).toContain("clamped_to=medium");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("模型支持 max/ultra 时不钳制，原样放行，也不打 warn", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "full-effort-model",
            output_config: { effort: "max" },
          }),
        );
        expect(result.reasoning?.effort).toBe("max");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("模型没有 supportedReasoningEfforts 元数据（未知型号）时不钳制，原样放行——没有依据就不假装有判断", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "totally-unknown-model",
            output_config: { effort: "ultra" },
          }),
        );
        expect(result.reasoning?.effort).toBe("ultra");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("effort 不是字符串（畸形请求）时忽略 output_config，回退到下一优先级", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          output_config: { effort: 123 } as never,
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      // output_config.effort 不是字符串 → 视为未提供，回退到 thinking
      expect(result.reasoning?.effort).toBe("medium");
    });

    // ★★ reviewer2 揪出的真缺陷：`typeof==="string"` 通不过空串/空白串
    // 这一关，`??` 又只处理 null/undefined 不处理空字符串，两个坏结果都
    // 不报错，只是安静地做错事——必须分别锁住"到底回退到了哪一级"，不能
    // 只断言"没崩"。

    it("★ effort 是空字符串——不能整条 fallback 链都被顶掉、变成完全不带 reasoning（这是改动前都不会出现的更差结果），必须回退到下一级", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          output_config: { effort: "" },
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      // 决定性断言：不是"没报错"，是"真的回退到了 thinking 算出来的 medium"
      // ——如果这里退化成 undefined（bug 修复前的行为），说明空串又把
      // 整条链吞掉了。
      expect(result.reasoning?.effort).toBe("medium");
      expect(result.reasoning?.effort).not.toBeUndefined();
    });

    it("★ effort 是空字符串，且没有任何下一级可回退——必须落到 config 默认值，而不是完全不带 reasoning", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ output_config: { effort: "" } }),
        makeModelConfig({ default_reasoning_effort: "medium" }),
      );
      expect(result.reasoning?.effort).toBe("medium");
    });

    it("★★ effort 是纯空白字符串——不能被钳制成模型支持的最高档（等于把一个空白值悄悄升级成 max，这不是处理，是换了语义），必须回退到下一级", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "full-effort-model", // 支持到 max/ultra，最容易暴露"被钳成 max"这个坏结果
            output_config: { effort: "   " },
            thinking: { type: "enabled", budget_tokens: 5000 },
          }),
        );
        // 决定性断言：必须是 thinking 算出来的 medium，不能是 max（钳制的
        // 产物）——如果这里是 "max"，说明空白串被当成"未知档位"送进了
        // clampReasoningEffortToModel，被钳到了这个模型支持的最高档。
        expect(result.reasoning?.effort).toBe("medium");
        expect(result.reasoning?.effort).not.toBe("max");
        // 空白串在回退阶段就被过滤掉了，压根不会进入钳制逻辑，因此不应该
        // 有任何 phase=effort_clamped 的 warn。
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("effort 带前后空白但本身是合法档位（' high '）——应该按 trim 后的规范值 'high' 处理，不能因为原始字符串不完全匹配而被误判成未知档位、钳到最高档", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "limited-effort-model", // 支持到 xhigh，若被误钳会变成 xhigh 而不是 high
            output_config: { effort: " high " },
          }),
        );
        expect(result.reasoning?.effort).toBe("high");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    // ★★ 8.16：完全未知的档位字符串（不在 REASONING_EFFORT_RANK 里，比如
    // 客户端发了个我们没见过的新档位名）——三个候选处理方式里选的是"当成
    // 没提供，让下一优先级接管"，不是"钳到最高"也不是"钳到最低"（两个都是
    // 在猜），完整取舍见 anthropic-to-codex.ts 调用点和
    // clampReasoningEffortToModel 头部注释。这里要断言的是"确实换到了
    // thinking 那一级"，不是"没有崩"。
    it("★ effort 是完全未识别的档位字符串（比如 'banana'）——视为未提供，回退到 thinking 那一级，不钳到任何档位、也不打 warn", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = translateAnthropicToCodexRequest(
          makeRequest({
            model: "full-effort-model", // 支持到 max/ultra——如果走了"钳到最高"这条错路，会得到 ultra
            output_config: { effort: "banana" },
            thinking: { type: "enabled", budget_tokens: 5000 },
          }),
        );
        // 决定性断言：必须是 thinking 算出来的 medium，既不是 "banana"
        // 原样透传（那样上游铁定拒绝），也不是被误判成需要钳制。
        expect(result.reasoning?.effort).toBe("medium");
        expect(result.reasoning?.effort).not.toBe("banana");
        expect(result.reasoning?.effort).not.toBe("ultra");
        // 未识别值在优先级链的过滤阶段就被拦下了，压根不会进入
        // clampReasoningEffortToModel，因此不应该有 phase=effort_clamped。
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("effort 是完全未识别的档位字符串，且没有任何下一级可回退——落到 config 默认值", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "full-effort-model", output_config: { effort: "banana" } }),
        makeModelConfig({ default_reasoning_effort: "medium" }),
      );
      expect(result.reasoning?.effort).toBe("medium");
    });
  });

  // ── Model parsing ────────────────────────────────────────────────────

  describe("model parsing", () => {
    it("resolves 'codex' alias via parseModelName", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "codex" }),
      );
      expect(result.model).toBe("gpt-5.4");
    });

    it("extracts service_tier from -fast suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-fast" }),
      );
      expect(result.service_tier).toBe("fast");
    });

    it("extracts reasoning effort from -high suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-high" }),
      );
      expect(result.reasoning?.effort).toBe("high");
    });
  });

  // ── Tools ────────────────────────────────────────────────────────────

  describe("tools", () => {
    it("converts Anthropic function tools with explicit strict:false", () => {
      const tools = [
        { name: "search", description: "Search the web", input_schema: { type: "object" as const } },
      ];
      const result = translateAnthropicToCodexRequest(makeRequest({ tools }));

      expect(anthropicToolsToCodex).toHaveBeenCalledWith(tools);
      expect(result.tools).toEqual([
        {
          type: "function",
          name: "search",
          strict: false,
          description: "Search the web",
          parameters: { type: "object", properties: {} },
        },
      ]);
    });

    it("delegates tool_choice to anthropicToolChoiceToCodex", () => {
      const toolChoice = { type: "auto" as const };
      translateAnthropicToCodexRequest(makeRequest({ tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, undefined);
    });

    it("passes tools context when converting tool_choice", () => {
      const tools = [
        { name: "web_search", description: "Custom search", input_schema: {} },
      ];
      const toolChoice = { type: "tool" as const, name: "web_search" };
      translateAnthropicToCodexRequest(makeRequest({ tools, tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, tools);
    });

    it("passes Claude Code WebSearch mapping option when requested", () => {
      const tools = [
        { name: "WebSearch", description: "Search the web", input_schema: {} },
      ];
      const toolChoice = { type: "tool" as const, name: "WebSearch" };
      translateAnthropicToCodexRequest(
        makeRequest({ tools, tool_choice: toolChoice }),
        undefined,
        { mapClaudeCodeWebSearch: true },
      );

      expect(anthropicToolsToCodex).toHaveBeenCalledWith(
        tools,
        { mapClaudeCodeWebSearch: true },
      );
      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(
        toolChoice,
        tools,
        { mapClaudeCodeWebSearch: true },
      );
    });

    it("does not inject hosted web_search by default", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());

      expect(result.tools).toEqual([]);
    });

    it("injects hosted web_search when explicitly requested", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest(),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search" }]);
    });

    it("does not duplicate hosted web_search when injected and already present", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ tools: [{ type: "web_search" as const, name: "web_search" }] }),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search" }]);
    });
  });

  // ── Fixed fields ─────────────────────────────────────────────────────

  describe("fixed fields", () => {
    it("always sets stream to true", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.stream).toBe(true);
    });

    it("always sets store to false", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.store).toBe(false);
    });

    it("does not set reasoning when no effort is configured or requested", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.reasoning).toBeUndefined();
    });
  });

  // ── Empty messages ───────────────────────────────────────────────────

  describe("empty messages", () => {
    it("ensures at least one input item when messages produce no items", () => {
      // All thinking blocks get filtered out, producing no items
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
              ],
            },
          ],
        }),
      );
      expect(result.input.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── tool_result with array content ─────────────────────────────────

  describe("tool_result with array content", () => {
    it("converts tool_result with array text content to joined string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_arr",
                  content: [
                    { type: "text" as const, text: "Line 1" },
                    { type: "text" as const, text: "Line 2" },
                  ],
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("Line 1\nLine 2");
    });
  });

  // ── tool_result with image content (screenshot scenario) ───────────

  describe("tool_result with image content", () => {
    it("extracts images from tool_result into a following user message", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img",
                  content: [
                    { type: "text" as const, text: "Screenshot captured" },
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/png",
                        data: "iVBORw0KGgo=",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      // Should produce function_call_output with text only
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("Screenshot captured");

      // Should produce a follow-up user message with the image
      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("input_image");
      expect(parts[0].image_url).toBe("data:image/png;base64,iVBORw0KGgo=");
    });

    it("handles tool_result with image-only content (no text)", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img2",
                  content: [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/jpeg",
                        data: "/9j/4AAQ",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("");

      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts[0].image_url).toBe("data:image/jpeg;base64,/9j/4AAQ");
    });

    it("handles tool_result with multiple images", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_multi",
                  content: [
                    { type: "text" as const, text: "Two screenshots" },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img1" },
                    },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img2" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const userItem = result.input.find(
        (i) => "role" in i && i.role === "user" && Array.isArray(i.content),
      );
      expect(userItem).toBeDefined();
      const parts = (userItem as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toHaveLength(2);
      expect(parts[0].image_url).toBe("data:image/png;base64,img1");
      expect(parts[1].image_url).toBe("data:image/png;base64,img2");
    });
  });

  // ── Mixed assistant content ────────────────────────────────────────

  describe("mixed assistant content", () => {
    it("converts assistant text block to assistant input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Here is the result" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("Here is the result");
    });

    it("handles assistant with both text and tool_use blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Let me search" },
                {
                  type: "tool_use" as const,
                  id: "toolu_mixed",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(assistantItem).toBeDefined();
      expect(fcItem).toBeDefined();
    });

    it("converts multiple tool_use blocks in single assistant message", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_1",
                  name: "search",
                  input: { query: "a" },
                },
                {
                  type: "tool_use" as const,
                  id: "toolu_2",
                  name: "fetch",
                  input: { url: "https://example.com" },
                },
              ],
            },
          ],
        }),
      );
      const fcItems = result.input.filter(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItems).toHaveLength(2);
    });
  });

  // ── Thinking block filtering ──────────────────────────────────────

  describe("thinking block handling", () => {
    it("filters out thinking blocks from assistant text content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
                { type: "text" as const, text: "visible answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("visible answer");
    });

    it("filters out redacted_thinking blocks from assistant content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "redacted_thinking" as const, data: "encrypted" },
                { type: "text" as const, text: "answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("answer");
    });
  });

  // ── System instruction edge cases ─────────────────────────────────

  describe("system instruction edge cases", () => {
    it("uses default instructions for empty system string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "" }),
      );
      expect(result.instructions).toBe("You are a helpful assistant.");
    });

    it("handles single text block system", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [{ type: "text" as const, text: "Only one block." }],
        }),
      );
      expect(result.instructions).toBe("Only one block.");
    });
  });

  // ── system_prompt_strategy 开关 ──────────────────────────────────────
  // buildInstructions 在本文件被 mock 成 identity ((text) => text)，因此
  // instructions 字段直接等于传入的文本，便于断言「user system 是否进 instructions」。
  describe("system_prompt_strategy", () => {
    it("case 1: baseline 默认 — system 进 instructions 字段", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "hello" }),
        makeModelConfig(),
      );

      expect(result.instructions).toContain("hello");
      expect(result.input.length).toBe(1);
      const item = result.input[0] as any;
      expect(item.role).toBe("user");
      expect(item.content).toBe("Hello");
    });

    it("case 2: developer_inline 生效 — system 挪到 input[0] developer 消息", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "hello" }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      expect(result.instructions).not.toContain("hello");
      expect(result.input.length).toBe(2);
      const first = result.input[0] as any;
      const second = result.input[1] as any;
      expect(first.role).toBe("developer");
      expect(first.content[0].text).toBe("hello");
      expect(second.role).toBe("user");
    });

    it("case 3: system_inline 生效 — system 挪到 input[0] system 消息", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "hello" }),
        makeModelConfig({ system_prompt_strategy: "system_inline" }),
      );

      const first = result.input[0] as any;
      expect(first.role).toBe("system");
      expect(first.content[0].text).toBe("hello");
      expect(result.input.length).toBe(2);
      expect(result.instructions).not.toContain("hello");
    });

    it("case 4: 多 block system 数组 join", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "a" },
            { type: "text" as const, text: "b" },
          ],
        }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      const first = result.input[0] as any;
      expect(first.content[0].text).toBe("a\n\nb");
    });

    it("case 5: userInstructions 空（system 缺省）→ 不 unshift", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: undefined }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      expect(result.input.length).toBe(1);
      const item = result.input[0] as any;
      expect(item.role).toBe("user");
    });

    it("case 5b: 全空 block → 不 unshift", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "" },
            { type: "text" as const, text: "   " },
          ],
        }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      expect(result.input.length).toBe(1);
      const item = result.input[0] as any;
      expect(item.role).toBe("user");
    });

    it("case 6: billing header 仍被过滤", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "x-anthropic-billing-header: cc_version=2.1.185;" },
            { type: "text" as const, text: "real prompt" },
          ],
        }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      const first = result.input[0] as any;
      expect(first.content[0].text).toBe("real prompt");
      expect(first.content[0].text).not.toContain("billing");
      expect(first.content[0].text).not.toContain("cc_version");
    });

    it("case 7: inline item 形态严格 — 只有 role+content，无 type 字段", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "x" }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      const first = result.input[0] as any;
      expect(first).not.toHaveProperty("type");
      expect(Object.keys(first).sort()).toEqual(["content", "role"]);
      expect(first.content[0].type).toBe("input_text");
      expect(first.content[0].text).toBe("x");
    });

    // 合约测试：inline 模式下 user system 走 inline item，instructions 字段
    // 拿到的是 buildInstructions("", cfg) 的结果——即 user 内容不进 instructions，
    // 给 desktop context 留出注入口（inject_desktop_context 仍可往该字段注入 ctx）。
    // 注：本文件把 buildInstructions mock 成 identity，故传入空串时可观测结果为 ""；
    // 真实 buildInstructions 的 ctx 注入行为由 shared-utils.test.ts 覆盖，这里只验合约。
    it("case 8: developer_inline 下 instructions 不含 user 内容（给 ctx 注入留口）", () => {
      const cfg = makeModelConfig({
        system_prompt_strategy: "developer_inline",
        inject_desktop_context: true,
      });
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "hello" }),
        cfg,
      );

      // 传给 buildInstructions 的 user 内容为空串 → mock identity → instructions === ""
      expect(result.instructions).toBe("");
      expect(result.instructions).not.toContain("hello");

      const first = result.input[0] as any;
      expect(first.role).toBe("developer");
      expect(first.content[0].text).toBe("hello");
    });

    // 根因 bug 回归：Claude Code custom-model 路径把 system 作为单个 string 下发，
    // 首行是 billing header、空行后才是真 prompt。旧的整串 startsWith 判断会把
    // 真 prompt 一起丢掉。修复后按行剥离 billing 行，保留真 prompt。
    it("case 9: string-typed system with billing first line strips only that line", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system:
            "x-anthropic-billing-header: cc_version=2.1.195.c5e; cc_entrypoint=cli;\n\nReal prompt content here.",
        }),
        makeModelConfig(),
      );

      expect(result.instructions).toBe("Real prompt content here.");
      expect(result.instructions).not.toContain("billing");
      expect(result.instructions).not.toContain("cc_version");
    });

    it("case 10: string-typed system + billing + developer_inline puts real prompt into input[0]", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system:
            "x-anthropic-billing-header: cc_version=2.1.195.c5e;\n\nReal prompt content here.",
        }),
        makeModelConfig({ system_prompt_strategy: "developer_inline" }),
      );

      const first = result.input[0] as any;
      expect(first.role).toBe("developer");
      expect(first.content[0].text).toBe("Real prompt content here.");
      expect(first.content[0].type).toBe("input_text");
      // inline 模式合约：instructions 字段不含 user 内容
      expect(result.instructions).toBe("");
    });
  });
});
