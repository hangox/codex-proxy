/**
 * Tests for `LogStore`（`src/logs/store.ts`）——此前只有路由层测试
 * （`tests/unit/routes/logs.test.ts`），但那边是把 `store.list` 整个
 * mock 掉的，从没有真正跑过这个类自己的过滤逻辑。★ 8.17 顺手补上：给
 * 压缩明细面板"跳转日志页按 rid 搜索"这个链接生效，往 `search` 命中的
 * haystack 里加了 `requestId`，这个改动之前完全没有测试覆盖，这里锁住。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LogStore, type LogRecord } from "@src/logs/store.js";

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "id-1",
    requestId: "39587bd5-1234-5678-9abc-def012345678",
    direction: "ingress",
    ts: "2026-08-03T14:32:07.000Z",
    method: "POST",
    path: "/v1/messages",
    model: "gpt-5.6-sol",
    provider: "codex",
    status: 200,
    ...overrides,
  };
}

describe("LogStore.list — search", () => {
  let store: LogStore;

  beforeEach(async () => {
    store = new LogStore();
    store.enqueue(makeRecord({ id: "a", requestId: "aaaaaaaa-0000", method: "POST", path: "/v1/messages", model: "gpt-5.6-sol", status: 200 }));
    store.enqueue(makeRecord({ id: "b", requestId: "bbbbbbbb-1111", method: "GET", path: "/v1/models", model: "gpt-5.4", status: 404 }));
    // enqueue 是异步 flush（microtask）——等一轮 microtask 让两条记录真正写进 records。
    await Promise.resolve();
    await Promise.resolve();
  });

  it("★ 8.17：按 requestId 子串（前缀）搜索能命中——压缩明细面板“跳转日志页”链接依赖这个", () => {
    const result = store.list({ search: "aaaaaaaa" });
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
  });

  it("★ 8.17：requestId 搜索大小写不敏感（和其它字段一致）", () => {
    const result = store.list({ search: "AAAAAAAA" });
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
  });

  it("回归：按 method/path/model/provider/status 搜索仍然生效，没有被这次改动破坏", () => {
    expect(store.list({ search: "models" }).records.map((r) => r.id)).toEqual(["b"]);
    expect(store.list({ search: "gpt-5.6-sol" }).records.map((r) => r.id)).toEqual(["a"]);
    expect(store.list({ search: "200" }).records.map((r) => r.id)).toEqual(["a"]);
  });

  it("不传 search 时返回全部记录（newest-first）", () => {
    const result = store.list({});
    expect(result.records.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("搜索不命中任何记录时返回空数组，不抛错", () => {
    const result = store.list({ search: "totally-unrelated-string" });
    expect(result.records).toEqual([]);
    expect(result.total).toBe(0);
  });
});
