import { describe, it, expect } from "vitest";

import { pickEventForRid, normalizeCompactEventsQueryState } from "./use-compact-outcome-events.js";
import type { CompactOutcomeEvent } from "./use-compact-outcome-events.js";

function makeEvent(overrides: Partial<CompactOutcomeEvent> = {}): CompactOutcomeEvent {
  return {
    ts: "2026-08-04T00:00:01.000Z",
    rid: "shared-rid",
    conv_hash: "a3f9e21c",
    model: "gpt-5.6-sol",
    compact_path: "opaque",
    outcome: "success",
    ...overrides,
  };
}

/**
 * ★ task #109（team-lead 拍板）：只传 rid、不传 ts 时选哪一条不是"随便挑
 * 第一个碰到的"，是明确决定——见 `pickEventForRid` 头部文档。这里直接测
 * 纯函数本身，不用透过整个 hook + mock fetch 才能验证这条决策。
 */
describe("pickEventForRid", () => {
  it("传 ts 时精确匹配 rid+ts 那一条", () => {
    const decision = makeEvent({ ts: "2026-08-04T00:00:01.000Z", compact_path: "fallback_decision" });
    const render = makeEvent({ ts: "2026-08-04T00:00:02.000Z", compact_path: "fallback_render", outcome: "render_completed" });
    const result = pickEventForRid([render, decision], "shared-rid", "2026-08-04T00:00:02.000Z");
    expect(result).toBe(render);
  });

  it("传 ts 但没有任何一条匹配时返回 null", () => {
    const decision = makeEvent();
    const result = pickEventForRid([decision], "shared-rid", "not-a-real-ts");
    expect(result).toBeNull();
  });

  it("只传 rid、这个 rid 只有一条记录（没有降级）时直接返回那一条", () => {
    const only = makeEvent();
    const result = pickEventForRid([only, makeEvent({ rid: "other-rid" })], "shared-rid");
    expect(result).toBe(only);
  });

  it("★ 核心：只传 rid、命中两条（降级场景）时优先选 fallback_decision，不是数组里排在前面的那条", () => {
    const decision = makeEvent({ ts: "2026-08-04T00:00:01.000Z", compact_path: "fallback_decision", outcome: "upstream_failed" });
    const render = makeEvent({ ts: "2026-08-04T00:00:02.000Z", compact_path: "fallback_render", outcome: "render_completed" });
    // events 数组按 ts 倒序（最新在前）是后端真实返回顺序——render 排在
    // decision 前面，如果 pickEventForRid 只是"取第一条匹配"会选错。
    const result = pickEventForRid([render, decision], "shared-rid");
    expect(result).toBe(decision);
  });

  it("只传 rid、fallback_decision 排在数组更后面时依然选中它（不依赖数组顺序）", () => {
    const decision = makeEvent({ ts: "2026-08-04T00:00:01.000Z", compact_path: "fallback_decision", outcome: "upstream_failed" });
    const render = makeEvent({ ts: "2026-08-04T00:00:02.000Z", compact_path: "fallback_render", outcome: "render_completed" });
    const result = pickEventForRid([decision, render], "shared-rid");
    expect(result).toBe(decision);
  });

  it("这个 rid 在 events 里完全没有匹配时返回 null", () => {
    const result = pickEventForRid([makeEvent({ rid: "other-rid" })], "shared-rid");
    expect(result).toBeNull();
  });
});

/**
 * ★ task #109：`compactPath` 维度接入归一化逻辑——切换它也要回第一页、
 * 清选中项，跟 outcome/model/search/hours 同一条纪律。
 */
describe("normalizeCompactEventsQueryState — compactPath 维度", () => {
  it("切换 compactPath 时回到第一页、清空选中项", () => {
    const next = normalizeCompactEventsQueryState(
      { outcome: "all", model: "", compactPath: "all", search: "", hours: 24, page: 2, selected: { id: "1" } },
      { compactPath: "fallback_render" },
    );
    expect(next.compactPath).toBe("fallback_render");
    expect(next.page).toBe(0);
    expect(next.selected).toBeNull();
  });

  it("compactPath 不变、只翻页时保留 compactPath，仍然清空选中项", () => {
    const next = normalizeCompactEventsQueryState(
      { outcome: "all", model: "", compactPath: "opaque", search: "", hours: 24, page: 0, selected: { id: "1" } },
      { page: 1 },
    );
    expect(next.compactPath).toBe("opaque");
    expect(next.page).toBe(1);
    expect(next.selected).toBeNull();
  });
});
