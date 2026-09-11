/** 实验驱动的 raw evidence 汇总口径回归。 */

import { describe, expect, it } from "vitest";
import {
  summarize,
  type Config,
  type RequestRecord,
  type UsageObservation,
} from "../../../scripts/experiments/prompt-cache-driver.js";

const config = {
  format: "responses",
  model: "gpt-5.4",
  prefix: "stable-prefix",
  prefixTokens: 8_192,
  prefixHash: "prefix-hash",
  routingKey: "routing-key",
  sessionId: "session-id",
  runId: "run-id",
  maxInputTokens: 100_000,
} as Config;

function record(index: number, usage: UsageObservation): RequestRecord {
  return {
    type: "request",
    index,
    requestId: `request-${index}`,
    runId: "run-id",
    scenario: "fixed-prefix",
    variant: `v-${index}`,
    prefixHash: "prefix-hash",
    prefixChars: 100,
    routingKeyHash: "routing-hash",
    sessionIdHash: "session-hash",
    tailHash: `tail-${index}`,
    tailChars: 10,
    inputTokenLowerBound: 100,
    status: 200,
    ok: true,
    elapsedMs: 1,
    usage,
  };
}

function rawUsage(input: number, cached: number | undefined, terminal: string = "response.completed"): UsageObservation {
  return {
    evidenceSource: "upstream",
    responseId: "resp-1",
    upstreamTerminalEvent: terminal,
    rawAvailable: true,
    rawInputTokens: input,
    rawCachedTokens: cached,
    rawCachedTokensPresent: cached !== undefined,
    rawUsageValid: true,
    clientAvailable: false,
  };
}

describe("prompt-cache-driver summarize", () => {
  it("does not treat an unknown sample as zero in the headline rate", () => {
    const summary = summarize(
      config,
      [record(1, rawUsage(1_000, 800)), record(2, rawUsage(9_000, undefined))],
      10_000,
      false,
      false,
    );

    expect(summary.evidenceSufficient).toBe(false);
    expect(summary.rawCacheHitRate).toBeNull();
    expect(summary.knownOnlySampleCount).toBe(1);
    expect(summary.knownOnlyInputTokens).toBe(1_000);
    expect(summary.knownOnlyCachedTokens).toBe(800);
    expect(summary.knownOnlyCacheHitRate).toBe(0.8);
    expect(summary.unknownRawUsageCount).toBe(1);
  });

  it("counts explicit cached_tokens=0 as valid known evidence", () => {
    const summary = summarize(
      config,
      [record(1, rawUsage(1_000, 0))],
      1_000,
      false,
      false,
    );

    expect(summary.evidenceSufficient).toBe(true);
    expect(summary.rawCacheHitRate).toBe(0);
    expect(summary.invalidRawUsageCount).toBe(0);
  });

  it("keeps failed usage as cost evidence but excludes it from every hit rate", () => {
    const summary = summarize(
      config,
      [record(1, rawUsage(1_000, 800, "response.failed"))],
      1_000,
      false,
      false,
    );

    expect(summary.measuredRawInputTokens).toBe(1_000);
    expect(summary.measuredRawCachedTokens).toBe(800);
    expect(summary.knownOnlySampleCount).toBe(0);
    expect(summary.knownOnlyCacheHitRate).toBeNull();
    expect(summary.rawCacheHitRate).toBeNull();
    expect(summary.evidenceSufficient).toBe(false);
  });

  it("excludes invalid cached_tokens values from evidence", () => {
    const summary = summarize(
      config,
      [record(1, {
        ...rawUsage(100, 120),
        rawUsageValid: false,
        rawUsageInvalidReason: "cached_tokens_exceeds_input_tokens",
      })],
      100,
      false,
      false,
    );

    expect(summary.evidenceSufficient).toBe(false);
    expect(summary.rawCacheHitRate).toBeNull();
    expect(summary.invalidRawUsageCount).toBe(1);
    expect(summary.knownOnlySampleCount).toBe(0);
  });
});
