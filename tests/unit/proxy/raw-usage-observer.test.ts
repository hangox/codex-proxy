import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRawUsageObservationSink,
  markRawUsageDispatch,
  readRawUsageObservationEvents,
  recordRawUsageObservation,
  reserveRawUsageAttempt,
  getRawUsageObservationSnapshot,
  startRawUsageObservation,
  setRawUsageLockLivenessForTesting,
  stopRawUsageObservation,
} from "@src/proxy/raw-usage-observer.js";

let previousCwd: string;
let testRoot: string;

beforeEach(() => {
  previousCwd = process.cwd();
  testRoot = mkdtempSync(join(tmpdir(), "codex-raw-usage-"));
  process.chdir(testRoot);
});

afterEach(() => {
  stopRawUsageObservation();
  setRawUsageLockLivenessForTesting();
  process.chdir(previousCwd);
});

describe("raw usage observer", () => {
  it("is disabled by default and auto-disables after nine observations", () => {
    expect(getRawUsageObservationSnapshot().enabled).toBe(false);
    const started = startRawUsageObservation({ runId: "test-run", ttlSeconds: 60, maxEvents: 9 });
    expect(started.enabled).toBe(true);

    const sink = getRawUsageObservationSink();
    expect(sink).toBeTypeOf("function");
    for (let i = 0; i < 9; i++) {
      sink?.({
        requestId: `rid-${i}`,
        attempt: 1,
        transport: "http",
        responseId: `resp-${i}`,
        terminalEvent: "response.completed",
        usagePresent: true,
        usage: { input_tokens: 100, output_tokens: 2, cached_tokens: 80 },
      });
    }

    const snapshot = getRawUsageObservationSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.eventCount).toBe(9);
    expect(snapshot.stopReason).toBe("max_events");
    const rows = readFileSync(snapshot.filePath!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({
      schema_version: 1,
      run_id: "test-run",
      request_id_hash: expect.any(String),
      usage_present: true,
      input_tokens_present: true,
      output_tokens_present: true,
      cached_tokens_present: true,
      cached_tokens: 80,
    });
    expect(rows[0]).not.toHaveProperty("payload");
    expect(rows[0]).not.toHaveProperty("prompt");
  });

  it("rejects a second process-style start while the lock is active", () => {
    setRawUsageLockLivenessForTesting(() => "owner");
    startRawUsageObservation({ runId: "lock-first", ttlSeconds: 60, maxEvents: 9 });
    expect(() => startRawUsageObservation({ runId: "lock-second", ttlSeconds: 60, maxEvents: 9 })).toThrow(/already active/);
    expect(stopRawUsageObservation().stopReason).toBe("manual_delete");
    expect(startRawUsageObservation({ runId: "lock-second", ttlSeconds: 60, maxEvents: 9 }).enabled).toBe(true);
  });

  it("reclaims only an expired metadata lock and fails closed for fresh/malformed/symlink locks", () => {
    setRawUsageLockLivenessForTesting(() => "owner");
    const directory = join(testRoot, "data", "raw-usage-observations");
    const lockPath = join(directory, ".active.lock");
    const metadata = (expiresAt: number, identity = "owner") => JSON.stringify({
      schema_version: 1,
      pid: 1,
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      run_id: "locked-run",
      process_start_identity: identity,
    });

    startRawUsageObservation({ runId: "seed", ttlSeconds: 60, maxEvents: 9 });
    stopRawUsageObservation();
    writeFileSync(lockPath, `${metadata(Date.now() + 60_000)}\n`, { mode: 0o600 });
    expect(() => startRawUsageObservation({ runId: "fresh", ttlSeconds: 60, maxEvents: 9 })).toThrow(/already active/);
    expect(existsSync(lockPath)).toBe(true);

    setRawUsageLockLivenessForTesting(() => null);
    expect(startRawUsageObservation({ runId: "dead-owner", ttlSeconds: 60, maxEvents: 9 }).runId).toBe("dead-owner");
    stopRawUsageObservation();
    setRawUsageLockLivenessForTesting(() => "new-owner");
    writeFileSync(lockPath, `${metadata(Date.now() + 60_000, "old-owner")}\n`, { mode: 0o600 });
    expect(startRawUsageObservation({ runId: "reused-pid", ttlSeconds: 60, maxEvents: 9 }).runId).toBe("reused-pid");
    stopRawUsageObservation();
    setRawUsageLockLivenessForTesting(() => "owner");

    writeFileSync(lockPath, `${metadata(Date.now() - 1_000)}\n`, { mode: 0o600 });
    expect(startRawUsageObservation({ runId: "reclaimed", ttlSeconds: 60, maxEvents: 9 }).runId).toBe("reclaimed");
    stopRawUsageObservation();

    writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
    expect(() => startRawUsageObservation({ runId: "malformed", ttlSeconds: 60, maxEvents: 9 })).toThrow(/malformed|inaccessible/);
    expect(existsSync(lockPath)).toBe(true);

    unlinkSync(lockPath);
    const target = join(directory, "target");
    writeFileSync(target, "lock-target");
    symlinkSync(target, lockPath);
    expect(() => startRawUsageObservation({ runId: "symlink", ttlSeconds: 60, maxEvents: 9 })).toThrow(/malformed|inaccessible|regular/);
    expect(existsSync(lockPath)).toBe(true);
    unlinkSync(lockPath);
  });

  it("tracks reserved versus dispatched lifecycle budget", () => {
    const started = startRawUsageObservation({ runId: "ticket-run", ttlSeconds: 60, maxEvents: 9 });
    const ticket = reserveRawUsageAttempt(started.runToken, 1_000);
    expect(ticket).toMatch(/^[A-Za-z0-9-]{32,}$/);
    expect(getRawUsageObservationSnapshot()).toMatchObject({ reservedPendingInputTokens: 1_000, committedOrUncertainInputTokens: 0 });
    markRawUsageDispatch(started.runToken, ticket as string, "dispatched");
    expect(getRawUsageObservationSnapshot()).toMatchObject({ reservedPendingInputTokens: 0, committedOrUncertainInputTokens: 1_000 });
  });

  it("auto-expires after the configured TTL", () => {
    vi.useFakeTimers();
    try {
      startRawUsageObservation({ runId: "ttl-run", ttlSeconds: 1, maxEvents: 9 });
      expect(getRawUsageObservationSnapshot().enabled).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(getRawUsageObservationSnapshot()).toMatchObject({ enabled: false, stopReason: "ttl_expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces private directory and file modes even with permissive umask", () => {
    const previousUmask = process.umask(0o022);
    try {
      const snapshot = startRawUsageObservation({ runId: "mode-run", ttlSeconds: 60, maxEvents: 9 });
      const directoryMode = statSync(join(testRoot, "data", "raw-usage-observations")).mode & 0o777;
      const fileMode = statSync(snapshot.filePath!).mode & 0o777;
      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("writes only matching run-scoped request ids", () => {
    const started = startRawUsageObservation({ runId: "scope-run", ttlSeconds: 60, maxEvents: 9 });
    const base = {
      requestId: "prompt-cache-scope-run-1",
      attempt: 1,
      transport: "http" as const,
      responseId: "resp-scope",
      terminalEvent: "response.completed" as const,
      usagePresent: true,
      usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 8 },
    };
    recordRawUsageObservation(base, started.runToken, "scope-run");
    recordRawUsageObservation({ ...base, requestId: "prompt-cache-other-run-1" }, started.runToken, "scope-run");
    recordRawUsageObservation(base, "wrong-token", "scope-run");

    expect(getRawUsageObservationSnapshot()).toMatchObject({ eventCount: 1, rejectedCount: 2 });
  });

  it("projects tampered allowed keys and counts invalid lines without leaking values", () => {
    const started = startRawUsageObservation({ runId: "tamper-run", ttlSeconds: 60, maxEvents: 9 });
    const sink = getRawUsageObservationSink();
    sink?.({ requestId: "prompt-cache-tamper-run-1", attempt: 1, transport: "http", responseId: "resp-ok", terminalEvent: "response.completed", usagePresent: true, usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 8 } });
    appendFileSync(started.filePath!, `${JSON.stringify({
      schema_version: 1, run_id: "tamper-run", ts: new Date().toISOString(), request_id_hash: "0000000000000000", attempt: 1,
      transport: "http", response_id: "SECRET-PAYLOAD", terminal_event: "response.completed", usage_present: true,
      input_tokens_present: true, input_tokens: "SECRET-PROMPT", output_tokens_present: true, output_tokens: 2,
      cached_tokens_present: true, cached_tokens: 8, reasoning_tokens_present: false, reasoning_tokens: null,
      header: "credential-like-secret",
    })}\n`, "utf8");

    const readback = readRawUsageObservationEvents();
    expect(readback.events).toHaveLength(1);
    expect(readback.invalidEventCount).toBe(1);
    expect(JSON.stringify(readback)).not.toContain("SECRET-PAYLOAD");
    expect(JSON.stringify(readback)).not.toContain("SECRET-PROMPT");
    expect(JSON.stringify(readback)).not.toContain("credential-like-secret");
  });

  it("writes a missing-usage terminal observation without manufacturing token zeros", () => {
    const started = startRawUsageObservation({ runId: "missing-run", ttlSeconds: 60, maxEvents: 9 });
    const sink = getRawUsageObservationSink();
    sink?.({
      requestId: "rid-missing",
      attempt: 1,
      transport: "websocket",
      responseId: "resp-missing",
      terminalEvent: "response.incomplete",
      usagePresent: false,
    });

    const snapshot = getRawUsageObservationSnapshot();
    const row = JSON.parse(readFileSync(snapshot.filePath!, "utf8").trim());
    expect(row).toMatchObject({
      schema_version: 1,
      run_id: "missing-run",
      usage_present: false,
      input_tokens_present: false,
      output_tokens_present: false,
      cached_tokens_present: false,
      input_tokens: null,
      cached_tokens: null,
    });
  });
});
