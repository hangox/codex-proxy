/**
 * Tests for recordStreamCloseEvent — the structured persistence layer for
 * premature stream close / client abort events. Verifies both downstream
 * sinks (Errors-tab error log + in-memory audit log) receive a record with
 * the caller-supplied diagnostic context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

const mockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return { ...actual, getDataDir: () => tmpDataDir };
});

vi.mock("@src/config.js", () => ({ getConfig: () => mockConfig }));

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "stream-close-evt-"));
  // Re-enable the file writer under Vitest — see error-log.ts for why
  // it's suppressed by default.
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

async function importAll() {
  const { recordStreamCloseEvent } = await import("@src/logs/stream-close-event.js");
  const { logStore } = await import("@src/logs/store.js");
  // 必须和 stream-close-event.js 同一次 vi.resetModules() 之后动态 import——
  // auditAccountTag 的盐（AUDIT_SALT）是 randomBytes(32) 在模块顶层算的，
  // 每次 resetModules 后都是新的一份，静态 import 在文件顶部只会加载一次、
  // 拿到和被测代码内部不同的盐，算出来的哈希永远对不上。
  const { auditAccountTag } = await import("@src/routes/shared/opaque-compact-audit.js");
  logStore.clear();
  logStore.setState({ enabled: true, paused: false });
  return { recordStreamCloseEvent, logStore, auditAccountTag };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

function readErrorLogLines(): Array<Record<string, unknown>> {
  const path = resolve(tmpDataDir, "error-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("recordStreamCloseEvent", () => {
  it("writes an Errors-tab entry and an audit log entry for upstream-premature", async () => {
    const { recordStreamCloseEvent, logStore, auditAccountTag } = await importAll();
    recordStreamCloseEvent({
      kind: "upstream-premature",
      requestId: "rid-abc",
      tag: "Responses",
      model: "gpt-5.5",
      accountEntryId: "e-42",
      responseId: "resp_pc",
      variantHash: "vh-deadbeef",
      eventCount: 1920,
      hadReasoning: true,
      detail: "WebSocket closed before terminal event: code=1006",
      closeCode: 1006,
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const err = errEntries[0];
    expect(err.source).toBe("server");
    const errBody = err.error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamUpstreamPrematureClose");
    expect(errBody.message).toBe("Upstream WebSocket closed before terminal event (code=1006)");
    const ctx = err.context as Record<string, unknown>;
    expect(ctx).toMatchObject({
      kind: "upstream-premature",
      requestId: "rid-abc",
      tag: "Responses",
      model: "gpt-5.5",
      accountHash: auditAccountTag("e-42"),
      responseId: "resp_pc",
      variantHash: "vh-deadbeef",
      eventCount: 1920,
      hadReasoning: true,
      closeCode: 1006,
    });
    expect(ctx).not.toHaveProperty("accountEntryId");

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    const log = audit.records[0];
    expect(log.requestId).toBe("rid-abc");
    expect(log.direction).toBe("egress");
    expect(log.model).toBe("gpt-5.5");
    expect(log.provider).toBe("codex");
    expect(log.stream).toBe(true);
    expect(log.error).toBe("Upstream WebSocket closed before terminal event (code=1006)");
    const req = log.request as Record<string, unknown>;
    expect(req).toMatchObject({
      kind: "upstream-premature",
      accountHash: auditAccountTag("e-42"),
      responseId: "resp_pc",
      eventCount: 1920,
      hadReasoning: true,
      closeCode: 1006,
      variantHash: "vh-deadbeef",
    });
    expect(req).not.toHaveProperty("accountEntryId");

    // blocker（reviewer 复审发现）：raw entryId 不能以任何形态落进
    // error-log.jsonl——之前 Errors 页的 ErrorRow 会把 context 整段
    // JSON.stringify 出来，明文账号 ID 因此直接暴露在 Dashboard 上。
    const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
    expect(raw).not.toContain("e-42");
  });

  it("emits a client-abort entry with the correct name and message", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "client-abort",
      requestId: "rid-cli",
      tag: "Responses",
      model: "gpt-5.5",
      accountEntryId: "e-7",
      variantHash: "vh-cafef00d",
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const errBody = errEntries[0].error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamClientAbort");
    expect(errBody.message).toBe("Client closed stream before completion");

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].error).toBe("Client closed stream before completion");
    const req = audit.records[0].request as Record<string, unknown>;
    expect(req.kind).toBe("client-abort");
    expect(req).not.toHaveProperty("eventCount");
    expect(req).not.toHaveProperty("hadReasoning");
  });

  it("propagates client-write-failed diagnostics (chunks/bytes/lastEvent)", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "client-write-failed",
      requestId: "rid-wf",
      tag: "Anthropic",
      model: "claude-opus-4-7",
      writtenChunks: 12,
      writtenBytes: 3456,
      lastSentEvent: "response.output_text.delta",
      sentTerminal: false,
      detail: "socket hang up",
    });

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const errBody = errEntries[0].error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamClientWriteFailed");
    expect(errBody.message).toBe("Client disconnected while proxy was writing stream: socket hang up");
    const ctx = errEntries[0].context as Record<string, unknown>;
    expect(ctx).toMatchObject({
      writtenChunks: 12,
      writtenBytes: 3456,
      lastSentEvent: "response.output_text.delta",
      sentTerminal: false,
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    const req = audit.records[0].request as Record<string, unknown>;
    expect(req.writtenChunks).toBe(12);
    expect(req.writtenBytes).toBe(3456);
  });

  it("populates status from a numeric upstreamStatus", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "upstream-error",
      requestId: "rid-err",
      model: "gpt-5.5",
      upstreamStatus: 502,
      detail: "Bad gateway",
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records[0].status).toBe(502);
  });

  it("uses caller-supplied provider and path for direct upstream audit entries", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({
      kind: "upstream-error",
      requestId: "rid-openai",
      model: "gpt-4.1",
      provider: "openai",
      path: "/v1/responses",
      upstreamStatus: 502,
      detail: "direct stream died",
    });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records[0]).toMatchObject({
      provider: "openai",
      path: "/v1/responses",
      status: 502,
    });

    const errEntries = readErrorLogLines();
    const ctx = errEntries[0].context as Record<string, unknown>;
    expect(ctx).toMatchObject({
      provider: "openai",
      path: "/v1/responses",
    });
  });

  it("falls back to a synthetic requestId when none is provided", async () => {
    const { recordStreamCloseEvent, logStore } = await importAll();
    recordStreamCloseEvent({ kind: "upstream-premature", detail: "early eof" });

    await flushMicrotasks();
    const audit = logStore.list({ limit: 50 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].requestId).toBe("stream-close");

    const errEntries = readErrorLogLines();
    expect(errEntries).toHaveLength(1);
    const errBody = errEntries[0].error as Record<string, unknown>;
    expect(errBody.name).toBe("StreamUpstreamPrematureClose");
    expect(errBody.message).toBe("Upstream WebSocket closed before terminal event: early eof");
    const ctx = errEntries[0].context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty("requestId");
  });

  // reviewer 发现：`detail`（调用方捕获到的底层异常自由文本）此前原样拼进
  // `message`，落进 appendErrorLog 顶层 error.message——那个字段不经过
  // redactJson，且 Dashboard 的 ErrorsPage 把 group.message 直接渲染出来。
  // 这里验证修复：顶层 message 与 context.detail 都经过
  // sanitizeFreeTextForLog（marker 值级脱敏 + 截断），不是简单假设安全。
  describe("detail sanitization（Dashboard 展示面排查发现的既有风险，本轮一并修）", () => {
    const MARKER_TOKEN =
      `codex-opaque-state:v1:${"A".repeat(32)}:${"B".repeat(43)}:${"C".repeat(43)}`;

    it("嵌在 detail 里的 opaque marker 不会原样落进顶层 message 或 context.detail", async () => {
      const { recordStreamCloseEvent } = await importAll();
      recordStreamCloseEvent({
        kind: "client-write-failed",
        requestId: "rid-marker",
        detail: `socket hang up while replaying ${MARKER_TOKEN} to client`,
      });

      const raw = readFileSync(resolve(tmpDataDir, "error-log.jsonl"), "utf-8");
      expect(raw).not.toContain(MARKER_TOKEN);
      expect(raw).not.toContain("A".repeat(32));
      expect(raw).not.toContain("B".repeat(43));
      expect(raw).not.toContain("C".repeat(43));
      expect(raw).toContain("codex-opaque-state:***");
    });

    it("超长 detail 被截断，不会把整段上游异常文本原样落盘", async () => {
      const { recordStreamCloseEvent } = await importAll();
      const longDetail = "x".repeat(5000);
      recordStreamCloseEvent({
        kind: "upstream-error",
        requestId: "rid-long-detail",
        detail: longDetail,
      });

      const errEntries = readErrorLogLines();
      const errBody = errEntries[0].error as Record<string, unknown>;
      const ctx = errEntries[0].context as Record<string, unknown>;
      expect((errBody.message as string).length).toBeLessThan(longDetail.length);
      expect(errBody.message).toContain("truncated");
      expect((ctx.detail as string).length).toBeLessThan(longDetail.length);
      expect(ctx.detail).toContain("truncated");
    });

    it("audit log（enqueueLogEntry 的 error 字段）复用同一份脱敏结果，不是第二套逻辑", async () => {
      const { recordStreamCloseEvent, logStore } = await importAll();
      recordStreamCloseEvent({
        kind: "client-write-failed",
        requestId: "rid-audit-marker",
        detail: `write failed: ${MARKER_TOKEN}`,
      });

      await flushMicrotasks();
      const audit = logStore.list({ limit: 50 });
      expect(audit.records[0].error).not.toContain(MARKER_TOKEN);
      expect(audit.records[0].error).toContain("codex-opaque-state:***");
    });

    it("正常长度、不含 marker 的 detail 不受影响，行为与修复前一致", async () => {
      const { recordStreamCloseEvent } = await importAll();
      recordStreamCloseEvent({
        kind: "upstream-error",
        requestId: "rid-plain",
        detail: "connection reset by peer",
      });

      const errEntries = readErrorLogLines();
      const errBody = errEntries[0].error as Record<string, unknown>;
      expect(errBody.message).toBe("Upstream stream failed while proxying response: connection reset by peer");
    });
  });
});
