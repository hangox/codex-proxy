import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { vi, describe, expect, beforeEach, afterEach, it } from "vitest";
import { setPaths } from "@src/paths.js";
import { CodexApi, CodexApiError } from "@src/proxy/codex-api.js";
import {
  getRawUsageObservationSnapshot,
  reserveRawUsageAttempt,
  startRawUsageObservation,
  stopRawUsageObservation,
} from "@src/proxy/raw-usage-observer.js";
import type { TlsTransport } from "@src/tls/transport.js";

const { mockCreateWebSocketResponse } = vi.hoisted(() => ({
  mockCreateWebSocketResponse: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    api: { base_url: "https://test.example" },
    client: { app_version: "1.0.0", build_number: "1", platform: "test", arch: "test", chromium_version: "1" },
    model: { compact_protocol: "auto" },
  })),
}));
vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
  buildHeadersWithContentType: vi.fn(() => ({ "Content-Type": "application/json" })),
}));
vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: mockCreateWebSocketResponse,
}));

const root = mkdtempSync(join("/tmp", "codex-controlled-budget-"));
setPaths({
  rootDir: root,
  configDir: join(root, "config"),
  dataDir: join(root, "data"),
  binDir: join(root, "bin"),
  publicDir: join(root, "public"),
});

function request(useWebSocket: boolean): Parameters<CodexApi["createResponse"]>[0] {
  return {
    model: "gpt-5.4",
    instructions: "x ".repeat(12_000),
    input: [{ role: "user", content: "tail" }],
    stream: true,
    store: false,
    useWebSocket,
  };
}

function transport(post: TlsTransport["post"]): TlsTransport {
  return { post } as unknown as TlsTransport;
}

function okTransportResponse(): { status: number; headers: Headers; body: ReadableStream<Uint8Array>; setCookieHeaders: string[] } {
  return {
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({ start(controller) { controller.close(); } }),
    setCookieHeaders: [],
  };
}

beforeEach(() => {
  stopRawUsageObservation();
  mockCreateWebSocketResponse.mockReset();
});

afterEach(() => {
  stopRawUsageObservation();
});

describe("CodexApi controlled wire budget", () => {
  it("rejects oversized HTTP wire before transport.post", async () => {
    const started = startRawUsageObservation({ runId: "budget-http", ttlSeconds: 60, maxEvents: 9 });
    const post = vi.fn<TlsTransport["post"]>();
    const api = new CodexApi("token", null, null, "entry", null, undefined, transport(post));
    api.setRawUsageContext({ requestId: "prompt-cache-budget-http-1", attempt: 1, observerToken: started.runToken, observerRunId: "budget-http" });

    await expect(api.createResponse(request(false), new AbortController().signal)).rejects.toBeInstanceOf(CodexApiError);
    expect(post).not.toHaveBeenCalled();
    expect(getRawUsageObservationSnapshot()).toMatchObject({ reservedPendingInputTokens: 0, committedOrUncertainInputTokens: 0, stopReason: "budget_exceeded" });
  });

  it("rejects oversized WebSocket wire before createWebSocketResponse", async () => {
    const started = startRawUsageObservation({ runId: "budget-ws", ttlSeconds: 60, maxEvents: 9 });
    const api = new CodexApi("token", null, null, "entry", null, undefined, transport(vi.fn()));
    api.setRawUsageContext({ requestId: "prompt-cache-budget-ws-1", attempt: 1, observerToken: started.runToken, observerRunId: "budget-ws" });

    await expect(api.createResponse(request(true), new AbortController().signal)).rejects.toBeInstanceOf(CodexApiError);
    expect(mockCreateWebSocketResponse).not.toHaveBeenCalled();
  });

  it("atomically caps nine reservations and rejects the tenth", () => {
    const started = startRawUsageObservation({ runId: "budget-reserve", ttlSeconds: 60, maxEvents: 9 });
    const tickets = Array.from({ length: 9 }, () => reserveRawUsageAttempt(started.runToken, 2_500));
    expect(tickets.every(Boolean)).toBe(true);
    expect(reserveRawUsageAttempt(started.runToken, 1)).toBe(false);
    expect(getRawUsageObservationSnapshot()).toMatchObject({
      reservedPendingInputTokens: 22_500,
      committedOrUncertainInputTokens: 0,
      stopReason: "budget_exceeded",
    });
  });

  it("does not reserve when no controlled token is present", async () => {
    const post = vi.fn<TlsTransport["post"]>(async () => okTransportResponse());
    const api = new CodexApi("token", null, null, "entry", null, undefined, transport(post));
    await api.createResponse({ ...request(false), instructions: "short" }, new AbortController().signal);
    expect(post).toHaveBeenCalledOnce();
  });

  it("marks transport failure after reserve as dispatch_uncertain", async () => {
    const started = startRawUsageObservation({ runId: "budget-uncertain", ttlSeconds: 60, maxEvents: 9 });
    const post = vi.fn<TlsTransport["post"]>(async () => { throw new Error("connection dropped after send"); });
    const api = new CodexApi("token", null, null, "entry", null, undefined, transport(post));
    api.setRawUsageContext({ requestId: "prompt-cache-budget-uncertain-1", attempt: 1, observerToken: started.runToken, observerRunId: "budget-uncertain" });

    await expect(api.createResponse({ ...request(false), instructions: "short" }, new AbortController().signal)).rejects.toThrow();
    expect(getRawUsageObservationSnapshot()).toMatchObject({
      reservedPendingInputTokens: 0,
      committedOrUncertainInputTokens: expect.any(Number),
      stopReason: "dispatch_uncertain",
    });
  });
});
