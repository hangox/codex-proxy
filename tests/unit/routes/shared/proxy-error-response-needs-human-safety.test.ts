/**
 * ★ #81 safety-rope test — mandated by team-lead, not optional coverage.
 *
 * The needs_human bucket's non-retryable status (403) is NOT unconditionally
 * safe from client-side auto-retry. Extracted directly from the Claude Code
 * 2.1.220 binary (`/Users/hangox/.local/share/claude/versions/2.1.220`,
 * function `Uke`, 2026-08-04):
 *
 *   function Uke(e){return e instanceof hi&&e.status===403&&(e.message?.includes("OAuth token has been revoked")??!1)}
 *
 * i.e. Claude Code DOES retry a 403 if — and only if — the error message
 * contains the literal substring "OAuth token has been revoked". That
 * string is Anthropic's own OAuth-flow wording, unrelated to this repo's
 * account-pool messaging, but the safety of choosing 403 for this bucket
 * depends ENTIRELY on our messages never accidentally containing it —
 * whether through a future text edit, a translation, or string
 * concatenation with upstream error text. This test is the guard against
 * that: it locks both the actual message-building function AND does a raw
 * source-text scan of the files that construct needs_human bucket text, so
 * a future refactor that moves the message elsewhere still gets caught.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildAccountExhaustionDetail } from "@src/routes/shared/proxy-error-response.js";

const FORBIDDEN_SUBSTRING = "OAuth token has been revoked";

describe("★ #81 safety rope: needs_human bucket text must never contain the Claude Code 403-retry trigger string", () => {
  it("buildAccountExhaustionDetail never produces the forbidden substring, across every summary shape", () => {
    const summaries = [
      { total: 0, active: 0, expired: 0, quota_exhausted: 0, rate_limited: 0, refreshing: 0, disabled: 0, banned: 0 },
      { total: 3, active: 0, expired: 3, quota_exhausted: 0, rate_limited: 0, refreshing: 0, disabled: 0, banned: 0 },
      { total: 3, active: 0, expired: 0, quota_exhausted: 0, rate_limited: 0, refreshing: 0, disabled: 3, banned: 0 },
      { total: 3, active: 0, expired: 0, quota_exhausted: 0, rate_limited: 0, refreshing: 0, disabled: 0, banned: 3 },
      { total: 6, active: 0, expired: 1, quota_exhausted: 1, rate_limited: 1, refreshing: 1, disabled: 1, banned: 1 },
    ];
    const messages = [
      "Run /clear and start a new session, or contact your administrator.",
      "Account credentials are unavailable.",
      "No account can serve this request.",
    ];
    for (const summary of summaries) {
      for (const message of messages) {
        const result = buildAccountExhaustionDetail(summary, message);
        expect(result).not.toContain(FORBIDDEN_SUBSTRING);
      }
    }
  });

  it("raw source scan: no needs_human-bucket-relevant file contains the forbidden substring anywhere, even in a comment mistakenly used as a template", () => {
    // Deliberately scans the SOURCE TEXT, not just tested code paths — a
    // future refactor could add a new hardcoded message string without
    // exercising this test's specific call patterns above. The files
    // scanned are exactly the ones that can influence the needs_human
    // bucket's response body: the shared response builder plus each
    // format's own message construction.
    const files = [
      "src/routes/shared/proxy-error-response.ts",
      "src/routes/messages.ts",
      "src/routes/gemini.ts",
      "src/routes/chat.ts",
      "src/routes/responses.ts",
    ];
    for (const relPath of files) {
      const fullPath = resolve(__dirname, "../../../../", relPath);
      const content = readFileSync(fullPath, "utf-8");
      // The one expected exception: this test file (and the doc comments
      // that reference the string for documentation purposes) quote it
      // deliberately. Production source files must not contain it at all —
      // if this assertion ever fails on messages.ts, it means someone wrote
      // the literal string into that file (even a comment referencing it,
      // like this test file does, would trip a naive scan — hence why this
      // list only includes files that don't currently document the
      // Uke() finding in prose).
      expect(
        content,
        `${relPath} must never contain the literal string "${FORBIDDEN_SUBSTRING}" — see this test's header comment`,
      ).not.toContain(FORBIDDEN_SUBSTRING);
    }
  });
});
