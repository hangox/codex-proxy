/**
 * compact 输入体积统计（`summarizeCompactInputBytes` + `phase=compact_start` 的
 * `bytes=` / `by_kind=` 字段）。
 *
 * 为什么需要它：tencent1 生产 24.4 小时窗口里 472 次 compact 尝试失败 440 次，
 * 原因 100% 是上游 400 `Prompt is too long`，零例外。但当时 `compact_start` 只有
 * `items=N`，而 items 和成败几乎无关——成功过 875 items 的，失败过 142 items 的。
 * 决定生死的是字节体积，所以必须把体积按 item 类型拆开落盘，否则"超限前先裁剪"
 * 的阈值只能靠猜。
 *
 * ★ 8.7 更新：`anthropicHistoryToCompactCodexInput`（原
 * `anthropicHistoryToLosslessCodexInput`）已经在源头丢弃 thinking /
 * redacted_thinking 块（task #24——它们曾经是 compact 与普通路径体积差的
 * 91.2%），所以走真实转换函数的输入里不会再出现这两类。但 `classifyInputItem`
 * 的分类逻辑本身**没有删**（team-lead 原话："观测还有用"）——万一丢弃逻辑被
 * 绕过或回归，这个分类还能把它们重新分出来，而不是塌陷进笼统的 text 桶悄悄
 * 消失。这里改成直接构造"手工包装过的 thinking 块"（绕开转换函数）来验证
 * 分类逻辑本身依然认识这个形状，是纯粹的观测通路测试，不代表生产会再产出
 * 这种输入。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CodexCompactRequest, CodexInputItem } from "@src/proxy/codex-types.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { AcquiredAccount } from "@src/auth/types.js";

vi.mock("@src/routes/shared/proxy-handler-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/routes/shared/proxy-handler-utils.js")>();
  return { ...actual, buildCodexApi: vi.fn() };
});

vi.mock("@src/config.js", () => ({
  getConfig: () => ({ auth: { request_interval_ms: null } }),
}));

const proxyHandlerUtils = await import("@src/routes/shared/proxy-handler-utils.js");
const { executeCompactOnly, summarizeCompactInputBytes, anthropicHistoryToCompactCodexInput } =
  await import("@src/routes/shared/codex-compact-service.js");

/**
 * 手工构造一个"被包装成 JSON 文本"的 thinking/redacted_thinking 块，模拟
 * `anthropicHistoryToCompactCodexInput` 8.7 之前会产出的形状——8.7 之后真实
 * 转换函数不会再产出它，这里只是为了验证 `classifyInputItem` 这条分类通路
 * 本身还认识这个形状（观测用，见文件头注释）。
 */
function wrappedThinkingItem(role: "assistant", innerType: "thinking" | "redacted_thinking", payload: Record<string, unknown>): CodexInputItem {
  return {
    role,
    content: [{
      type: "output_text",
      text: JSON.stringify({ anthropic_content_block: { type: innerType, ...payload } }),
    }],
  };
}

const buildCodexApiMock = vi.mocked(proxyHandlerUtils.buildCodexApi);

/** 解析 by_kind="a:1/100,b:2/50" 成 { a: {count,bytes}, … } 方便断言。 */
function parseBreakdown(breakdown: string): Record<string, { count: number; bytes: number }> {
  const out: Record<string, { count: number; bytes: number }> = {};
  for (const part of breakdown.split(",")) {
    if (!part) continue;
    const [kind, nums] = part.split(":");
    const [count, bytes] = nums.split("/").map(Number);
    out[kind] = { count, bytes };
  }
  return out;
}

describe("summarizeCompactInputBytes", () => {
  it("thinking 和 redacted_thinking 分类通路仍然存在（观测用，8.7 之后不会再由真实转换函数产出，见文件头注释）", () => {
    const input: CodexInputItem[] = [
      { role: "user", content: "看看这个" },
      wrappedThinkingItem("assistant", "thinking", { thinking: "推理".repeat(100), signature: "sig" }),
      { role: "assistant", content: [{ type: "output_text", text: "结论" }] },
      wrappedThinkingItem("assistant", "redacted_thinking", { data: "x".repeat(80) }),
    ];

    const { breakdown, totalBytes } = summarizeCompactInputBytes(input);
    const kinds = parseBreakdown(breakdown);

    expect(kinds.thinking?.count).toBe(1);
    expect(kinds.redacted_thinking?.count).toBe(1);
    expect(kinds.text?.count).toBe(2); // 用户那条 + assistant 的结论
    // thinking 是这批里最大的一块，拆分必须能体现出来。
    expect(kinds.thinking.bytes).toBeGreaterThan(kinds.text.bytes);
    expect(totalBytes).toBe(
      Object.values(kinds).reduce((sum, v) => sum + v.bytes, 0),
    );
  });

  it("8.7：anthropicHistoryToCompactCodexInput 真实转换不再产出 thinking/redacted_thinking", () => {
    const input = anthropicHistoryToCompactCodexInput([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "推理".repeat(100), signature: "sig" },
          { type: "text", text: "结论" },
        ],
      },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "x".repeat(80) }] },
    ] as never);

    const { breakdown } = summarizeCompactInputBytes(input);
    const kinds = parseBreakdown(breakdown);

    expect(kinds.thinking).toBeUndefined();
    expect(kinds.redacted_thinking).toBeUndefined();
    expect(kinds.text?.count).toBe(1); // 只剩"结论"，thinking 块整个不产出 item
  });

  it("tool_call 与 tool_result 分开计数，且 totalBytes 是 UTF-8 字节而非字符数", () => {
    const input = anthropicHistoryToCompactCodexInput([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }],
      },
      // 中文在 UTF-8 下 3 字节/字：字节数必须明显大于字符数，否则说明用了 .length。
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内容".repeat(100) }] },
    ] as never);

    const { breakdown, totalBytes } = summarizeCompactInputBytes(input);
    const kinds = parseBreakdown(breakdown);

    expect(kinds.tool_call?.count).toBe(1);
    expect(kinds.tool_result?.count).toBe(1);
    expect(kinds.tool_result.bytes).toBeGreaterThan(200 * 2);
    expect(totalBytes).toBeGreaterThan(200 * 2);
  });

  it("空输入不炸，返回 0 字节和空拆分", () => {
    expect(summarizeCompactInputBytes([])).toEqual({ totalBytes: 0, breakdown: "" });
  });
});

describe("phase=compact_start 携带 bytes 与 by_kind", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildCodexApiMock.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("成功路径的 compact_start 同时打出 items / bytes / by_kind", async () => {
    const acquired: AcquiredAccount = {
      entryId: "e1", token: "t", accountId: "a", prevSlotMs: null,
    };
    const pool = {
      acquire: vi.fn(() => acquired),
      release: vi.fn(),
      getPoolSummary: vi.fn(() => ({
        total: 1, active: 1, expired: 0, quota_exhausted: 0, rate_limited: 0, refreshing: 0, disabled: 0, banned: 0,
      })),
      getEntry: vi.fn(() => ({ email: "t@example.com" })),
      markStatus: vi.fn(),
    } as unknown as AccountPool;

    buildCodexApiMock.mockReturnValue({
      createCompactResponse: vi.fn().mockResolvedValue({ output: [] }),
    } as never);

    // 用手工包装的 thinking 形状（而不是走真实转换函数）——8.7 起真实转换
    // 函数不再产出这种 item（见文件头注释），这里只验证 by_kind 分类通路
    // 本身仍然认识这个形状。
    const request: CodexCompactRequest = {
      model: "gpt-5.4",
      input: [wrappedThinkingItem("assistant", "thinking", { thinking: "想".repeat(300), signature: "s" })],
      instructions: "",
    };

    await executeCompactOnly({
      accountPool: pool,
      compactRequest: request,
      signal: new AbortController().signal,
      requestId: "rid-size-0001",
    });

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("phase=compact_start"));
    expect(line).toBeDefined();
    expect(line).toContain("items=1");
    expect(line).toMatch(/bytes=\d{3,}/);
    expect(line).toContain("by_kind=thinking:1/");
  });
});
