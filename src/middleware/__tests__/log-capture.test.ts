import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueLogEntry: vi.fn(),
}));

vi.mock("../../logs/entry.js", () => ({
  enqueueLogEntry: mocks.enqueueLogEntry,
}));

import { logCapture } from "../log-capture.js";

function createContext() {
  const headers = new Map<string, string>();
  return {
    get: vi.fn((key: string) => (key === "requestId" ? "req-123" : undefined)),
    header: vi.fn((key: string, value: string) => {
      headers.set(key, value);
    }),
    req: { method: "POST", path: "/v1/messages" },
    res: { status: 201 },
  } as unknown as Parameters<typeof logCapture>[0];
}

describe("logCapture middleware", () => {
  beforeEach(() => {
    mocks.enqueueLogEntry.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));
  });

  it("enqueues an ingress log after the request completes", async () => {
    const c = createContext();
    const next = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-04-15T00:00:00.025Z"));
    });

    await logCapture(c, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueLogEntry).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-123",
      direction: "ingress",
      method: "POST",
      path: "/v1/messages",
      status: 201,
      latencyMs: 25,
    }));
  });
});
