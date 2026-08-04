/**
 * ★ #81 safety-rope test — mandated by team-lead, not optional coverage.
 *
 * Gemini's SDK has no `x-should-retry`-equivalent header override — retry
 * eligibility is decided ENTIRELY by a static client-side status-code
 * whitelist. Confirmed by pulling the real published package and reading
 * the actual source (not memory, not GitHub main which can be ahead of what
 * users actually have installed):
 *
 *   npm pack @google/genai@2.15.0
 *   dist/index.cjs, DEFAULT_RETRY_HTTP_STATUS_CODES (line ~7975, 2026-08-04):
 *     [408, 429, 500, 502, 503, 504]
 *
 * `gemini.ts`'s `noAccountStatus` (503) is deliberately IN this list — the
 * self-heal buckets need the client to auto-retry. `needsHumanStatus` (403)
 * is deliberately NOT in it — that's the entire mechanism this bucket
 * relies on for Gemini, since there's no header to fall back on. If
 * `needsHumanStatus` is ever changed to a value that happens to land in
 * this list, retries would silently resume for a bucket that's supposed to
 * be terminal, with no error or warning anywhere.
 *
 * If `@google/genai` ever changes this list in a future version, this test
 * needs to be re-verified against the new real source — don't just bump the
 * hardcoded array below without re-running `npm pack` and reading it again.
 */

import { describe, expect, it } from "vitest";

// Source: @google/genai v2.15.0, dist/index.cjs, DEFAULT_RETRY_HTTP_STATUS_CODES,
// pulled and read 2026-08-04. See this file's header comment for the exact command.
const GEMINI_SDK_RETRY_WHITELIST = [408, 429, 500, 502, 503, 504];

describe("★ #81 safety rope: Gemini's needsHumanStatus must never land in the SDK's static retry whitelist", () => {
  it("gemini.ts's needsHumanStatus is not in @google/genai's DEFAULT_RETRY_HTTP_STATUS_CODES", async () => {
    const geminiModule = await import("@src/routes/gemini.js");
    // GEMINI_FORMAT itself isn't exported — go through the same route
    // registration surface a real request would, to avoid this test
    // silently drifting from what's actually wired up if someone
    // refactors the module's internals without touching its exports.
    expect(geminiModule.createGeminiRoutes).toBeTypeOf("function");

    // The concrete status value is asserted directly against the source
    // file text below (not by exercising a live request — a 200/error
    // response body wouldn't tell us which literal status Hono actually
    // sent without a real account pool in play, which is more setup than
    // this specific guarantee needs). This keeps the test tightly scoped
    // to exactly the property it's meant to lock down.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "../../../src/routes/gemini.ts"), "utf-8");
    const match = /needsHumanStatus:\s*(\d+)/.exec(source);
    expect(match, "gemini.ts must declare a literal numeric needsHumanStatus").not.toBeNull();
    const needsHumanStatus = Number(match![1]);

    expect(
      GEMINI_SDK_RETRY_WHITELIST,
      `needsHumanStatus (${needsHumanStatus}) must NOT be in @google/genai's retry whitelist — ` +
        `if it is, the needs_human bucket silently becomes auto-retried on Gemini with no header to override it`,
    ).not.toContain(needsHumanStatus);
  });

  it("gemini.ts's noAccountStatus (self-heal bucket) IS in the whitelist — sanity check the whitelist constant itself isn't stale/wrong", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "../../../src/routes/gemini.ts"), "utf-8");
    const match = /noAccountStatus:\s*(\d+)/.exec(source);
    expect(match).not.toBeNull();
    const noAccountStatus = Number(match![1]);
    expect(GEMINI_SDK_RETRY_WHITELIST).toContain(noAccountStatus);
  });
});
