import { describe, it, expect } from "vitest";
import { AnthropicMessagesRequestSchema } from "@src/types/anthropic.js";

const BASE_REQUEST = {
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello" },
  ],
};

describe("AnthropicMessagesRequestSchema", () => {
  it("accepts string content", () => {
    const result = AnthropicMessagesRequestSchema.safeParse(BASE_REQUEST);
    expect(result.success).toBe(true);
  });

  it("accepts known array content (text block)", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_use + tool_result multi-turn", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "run bash" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown content block types (forward-compatibility)", () => {
    // Simulate a new type like "document" sent by future Claude Code versions.
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Here is a file:" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // ★★ 8.15：qa 用 TCP 层抓包证实的真实回归——`output_config.effort` 这个
  // 字段此前完全没在 schema 里声明，被 Zod 默认（非 `.strict()`）静默
  // strip 掉，不是客户端没发，是我们自己在业务逻辑看到它之前就吃掉了。
  // 这组测试锁住"这个字段现在会被保留"这个前提，防止以后有人在别处重构
  // schema 时又把它漏掉（那种回归不会报错、不会测试失败，只会悄悄丢数据
  // ——上次就是这样漏掉的，必须靠显式测试而不是"应该没问题"）。
  describe("output_config（8.15：qa 抓包证实的真实 effort 信号）", () => {
    it("保留 output_config.effort 字段——不再被 Zod 默认 strip 丢弃", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: { effort: "max" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config?.effort).toBe("max");
      }
    });

    it("output_config 是可选字段——不带时照常通过", () => {
      const result = AnthropicMessagesRequestSchema.safeParse(BASE_REQUEST);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config).toBeUndefined();
      }
    });

    it("effort 本身是可选的——只带别的 output_config 子字段也不报错", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: { format: { type: "json_schema" } },
      });
      expect(result.success).toBe(true);
    });

    it("★ .passthrough()：output_config 里未声明的子字段（比如 format/task_budget）也原样保留，不会被吃掉——这正是这次教训要求的，不能只声明 effort 一个字段就 .strict()", () => {
      const result = AnthropicMessagesRequestSchema.safeParse({
        ...BASE_REQUEST,
        output_config: {
          effort: "high",
          task_budget: { type: "tokens", total: 64000 },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output_config).toEqual({
          effort: "high",
          task_budget: { type: "tokens", total: 64000 },
        });
      }
    });
  });

  it("accepts thinking blocks in assistant messages", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "think hard" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason...", signature: "sig" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("moves inline system messages to top-level system", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      system: "Existing system.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "system", content: "Inline system." },
        { role: "assistant", content: "Hi" },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.system).toBe("Existing system.\n\nInline system.");
    expect(result.data.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });
});
