import { describe, it, expect, beforeEach } from "vitest";
import { LogStore } from "./store.js";

describe("LogStore", () => {
  let store: LogStore;

  beforeEach(() => {
    store = new LogStore(10);
  });

  it("returns newest records first when listing", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
    });
    store.enqueue({
      id: "2",
      requestId: "r2",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/b",
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("redacts request payloads on flush", async () => {
    store.enqueue({
      id: "1",
      requestId: "r1",
      direction: "ingress",
      ts: new Date().toISOString(),
      method: "POST",
      path: "/a",
      request: {
        headers: { authorization: "Bearer secret" },
        nested: { token: "abc" },
      },
    });

    await Promise.resolve();
    const result = store.list({ limit: 10, offset: 0 });
    expect(result.records[0].request).toMatchObject({
      headers: { authorization: "Bea***et" },
      nested: { token: "***" },
    });
  });
});
