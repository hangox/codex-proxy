import { describe, expect, it } from "vitest";
import { opaqueCompactVariantHash } from "@src/routes/shared/opaque-compact-bridge.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

/**
 * `opaqueCompactVariantHash` 是 opaque compact 专用的 variant 绑定包装函数
 * （`opaque-compact-bridge.ts`），不是 `computeVariantHash` 本身
 * （`variant-hash.ts` 有自己的 `variant-hash.test.ts`，测的是共用函数，不
 * 在这个文件的范围内，也不应该因为这次改动而变）。
 *
 * 团队裁决：`instructions` 从这个 hash 里去掉，只留 `tools`
 * （+ `codexWindowId`）。理由三条证据链见 `opaqueCompactVariantHash` 的
 * 文档注释，这里只验证行为本身。
 */
function translated(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gpt-5.4",
    instructions: "system prompt A",
    input: [],
    stream: true,
    store: false,
    tools: [{ type: "function", name: "Read" }],
    ...overrides,
  };
}

describe("opaqueCompactVariantHash", () => {
  it("核心回归：instructions 不同、tools 相同 → hash 相同（本次事故的真实场景：22344 → 16472，tools 不变）", () => {
    const before = translated({ instructions: "compact 之前的长 instructions，22344 字符量级" });
    const after = translated({ instructions: "compact 之后被翻译层重写过的短 instructions，16472 字符量级" });
    expect(opaqueCompactVariantHash(before)).toBe(opaqueCompactVariantHash(after));
  });

  it("instructions 从 null/undefined/空字符串变为非空字符串，hash 依然相同（覆盖所有可能出现的缺省值形态）", () => {
    // computeVariantHash 内部对 instructions 做 `?? ""`，null/undefined/""
    // 三者在那一层本就等价（reviewer 读代码确认过）；这里补上字面量空
    // 字符串 "" 这一种此前没有显式覆盖到的形态，不留防护网上的孔——即便
    // 现在 opaqueCompactVariantHash 已经不再把 translated.instructions
    // 传给 computeVariantHash（固定传 null），这条断言依然是真实防护：
    // 它验证的是"不管 instructions 传什么值，wrapper 的输出都不变"这个
    // 对外可观察的行为，而不是内部实现细节。
    const withInstructions = translated({ instructions: "some instructions" });
    const withoutInstructions = translated({ instructions: null });
    const undefinedInstructions = translated({ instructions: undefined });
    const emptyInstructions = translated({ instructions: "" });
    const hash = opaqueCompactVariantHash(withInstructions);
    expect(opaqueCompactVariantHash(withoutInstructions)).toBe(hash);
    expect(opaqueCompactVariantHash(undefinedInstructions)).toBe(hash);
    expect(opaqueCompactVariantHash(emptyInstructions)).toBe(hash);
  });

  it("保留隔离能力：tools 不同 → hash 依然不同（没有把整层 variant 绑定废掉，只去掉了 instructions 这一半）", () => {
    const readOnly = translated({ tools: [{ type: "function", name: "Read" }] });
    const webFetch = translated({ tools: [{ type: "function", name: "WebFetch" }] });
    expect(opaqueCompactVariantHash(readOnly)).not.toBe(opaqueCompactVariantHash(webFetch));
  });

  it("保留隔离能力：tools 数组顺序不同 → hash 依然不同（沿用 computeVariantHash 的既有顺序敏感设计，未被这次改动影响）", () => {
    const order1 = translated({ tools: [{ type: "function", name: "Read" }, { type: "function", name: "WebFetch" }] });
    const order2 = translated({ tools: [{ type: "function", name: "WebFetch" }, { type: "function", name: "Read" }] });
    expect(opaqueCompactVariantHash(order1)).not.toBe(opaqueCompactVariantHash(order2));
  });

  it("codexWindowId 不同 → hash 依然不同（不同 Codex 窗口仍然隔离，未被这次改动影响）", () => {
    const windowA = translated({ codexWindowId: "window-a" });
    const windowB = translated({ codexWindowId: "window-b" });
    expect(opaqueCompactVariantHash(windowA)).not.toBe(opaqueCompactVariantHash(windowB));
  });

  it("codexWindowId 缺省 vs 空白字符串，效果等价（trim 后判空，不因客户端传了空白串就产生一个新 identity）", () => {
    const missing = translated({ codexWindowId: undefined });
    const blank = translated({ codexWindowId: "   " });
    expect(opaqueCompactVariantHash(missing)).toBe(opaqueCompactVariantHash(blank));
  });
});
