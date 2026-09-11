import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashRequestId,
  mergeUpstreamEvidence,
  type RequestRecord,
} from "../../../scripts/experiments/prompt-cache-driver.js";

function record(): RequestRecord {
  return {
    type: "request",
    index: 1,
    requestId: "prompt-cache-run-1",
    runId: "run",
    scenario: "fixed-prefix",
    variant: "same-tail",
    prefixHash: "prefix",
    prefixChars: 10,
    routingKeyHash: "routing",
    sessionIdHash: "session",
    tailHash: "tail",
    tailChars: 4,
    inputTokenLowerBound: 10,
    status: 200,
    ok: true,
    elapsedMs: 1,
    usage: {
      evidenceSource: "downstream",
      responseId: "downstream-response",
      rawAvailable: false,
      rawCachedTokensPresent: false,
      rawUsageValid: false,
      clientAvailable: true,
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    run_id: "run",
    ts: "2026-09-11T00:00:00.000Z",
    request_id_hash: hashRequestId("prompt-cache-run-1"),
    attempt: 1,
    transport: "http",
    response_id: "downstream-response",
    terminal_event: "response.completed",
    usage_present: true,
    input_tokens_present: true,
    input_tokens: 100,
    output_tokens_present: true,
    output_tokens: 2,
    cached_tokens_present: true,
    cached_tokens: 80,
    reasoning_tokens_present: false,
    reasoning_tokens: null,
    ...overrides,
  }) + "\n";
}

async function merge(lines: string[]): Promise<RequestRecord> {
  const root = await mkdtemp(join(tmpdir(), "prompt-cache-evidence-"));
  const path = join(root, "observer.jsonl");
  await writeFile(path, lines.join(""), "utf8");
  const result = record();
  await mergeUpstreamEvidence([result], path, "responses");
  return result;
}

describe("prompt-cache-driver evidence contract", () => {
  it("accepts the observer schema and maps valid raw usage", async () => {
    const result = await merge([evidence()]);
    expect(result.usage.evidenceSource).toBe("upstream");
    expect(result.usage.rawInputTokens).toBe(100);
    expect(result.usage.rawCachedTokens).toBe(80);
  });

  it("keeps canonical partial usage as upstream unknown cost evidence", async () => {
    const result = await merge([evidence({ input_tokens_present: false, input_tokens: null })]);
    expect(result.usage.evidenceSource).toBe("upstream");
    expect(result.usage.rawInputTokens).toBeUndefined();
    expect(result.usage.rawUsageAvailabilityReason).toContain("missing_input_tokens");
  });

  it("rejects wrong schema versions, missing fields, and unknown keys", async () => {
    const badLines = [
      evidence({ schema_version: 2 }),
      evidence({ usage_present: false, input_tokens_present: true, input_tokens: 100 }),
      evidence({ input_tokens_present: false, input_tokens: 100 }),
      `${JSON.stringify({ ...JSON.parse(evidence()), unexpected: "payload" })}\n`,
    ];
    for (const [index, line] of badLines.entries()) {
      const result = await merge([line]);
      expect(result.usage.evidenceSource, `bad evidence index=${index}`).toBe("downstream");
      expect(result.upstreamEvidenceRejectReason, `bad evidence index=${index}`).toBeDefined();
    }
  });

  it("rejects conflicting same-request observations", async () => {
    const result = await merge([evidence(), evidence({ cached_tokens: 20 })]);
    expect(result.usage.evidenceSource).toBe("downstream");
    expect(result.upstreamEvidenceConflict).toBe(true);
  });
});
