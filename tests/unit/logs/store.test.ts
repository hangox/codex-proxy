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

/**
 * ★ 排查压缩明细面板"跳转日志页"链接时（team-lead 要求"必须实测，不要
 * 假设"）发现：`src/logs/store.test.ts` 里有一份内容更完整的 `LogStore`
 * 测试（分页/无效分页参数归一化/请求体脱敏/容量收缩淘汰），但那个文件
 * 不在 `vitest.config.ts` 的 `include` 范围内（只覆盖
 * `shared/**`/`tests/unit/**`/`tests/integration/**`/`tests/e2e/**`/
 * `packages/electron/__tests__/**`，不含裸的 `src/**`）——`npx vitest run
 * src/logs/store.test.ts` 直接报 "No test files found"，从来没在任何
 * `npm test`/CI 里跑过。和这次发布追查到的另外两个"检查存在但没有约束
 * 力"的问题（#83 的 tsconfig 穷尽性守卫、v2.0.95 的 ci-quality.yml 触发
 * 不可靠）是同一类：`git status` 干净、代码看起来有测试覆盖，实际上从没
 * 被验证过——包括请求体脱敏（`request/response` 里的 token/密码打码）
 * 这种真正要紧的行为。这里把那份测试里真正独有、这个文件没覆盖到的用例
 * 搬过来（分页/无效参数/脱敏/容量淘汰——newest-first 排序和
 * direction+search 过滤这两条和上面"不传 search 时返回全部记录"/已有
 * search 测试重复，不重复搬），孤儿文件本身已删除。
 */
describe("LogStore — 分页 / 脱敏 / 容量淘汰（原 src/logs/store.test.ts，此前从未被任何 vitest 配置实际执行过）", () => {
  let store: LogStore;

  beforeEach(() => {
    store = new LogStore(10);
  });

  it("分页时最新的记录排在前面，跨页也保持这个顺序", async () => {
    for (const id of ["1", "2", "3", "4"]) {
      store.enqueue(makeRecord({ id, requestId: `r${id}`, path: `/${id}` }));
    }
    await Promise.resolve();

    const page0 = store.list({ limit: 2, offset: 0 });
    const page1 = store.list({ limit: 2, offset: 2 });

    expect(page0.records.map((r) => r.id)).toEqual(["4", "3"]);
    expect(page1.records.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("非法的 limit/offset（NaN）会被归一化成默认值，不会直接崩掉或原样透传", async () => {
    store.enqueue(makeRecord({ id: "1" }));
    await Promise.resolve();

    const result = store.list({ limit: Number.NaN, offset: Number.NaN });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("★ 请求体里的敏感字段（Authorization/token）落盘前会被脱敏，不是原样存进日志", async () => {
    store.enqueue(
      makeRecord({
        id: "1",
        request: {
          headers: { authorization: "Bearer secret" },
          nested: { token: "abc" },
        },
      }),
    );
    await Promise.resolve();

    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records[0]!.request).toMatchObject({
      headers: { authorization: "Bea***et" },
      nested: { token: "***" },
    });
  });

  it("调低容量时会立刻淘汰超出新容量的旧记录，只保留最新的那几条", async () => {
    for (const id of ["1", "2", "3", "4"]) {
      store.enqueue(makeRecord({ id, requestId: `r${id}`, path: `/${id}` }));
    }
    await Promise.resolve();

    const state = store.setState({ capacity: 2 });
    const result = store.list({ limit: 10, offset: 0 });

    expect(state.capacity).toBe(2);
    expect(state.size).toBe(2);
    expect(state.dropped).toBe(2);
    expect(result.records.map((r) => r.id)).toEqual(["4", "3"]);
  });
});
