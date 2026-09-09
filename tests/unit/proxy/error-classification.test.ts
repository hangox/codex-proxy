import { describe, it, expect } from "vitest";
import { CodexApiError } from "@src/proxy/codex-types.js";
import {
  classifyRawUpstreamError,
  extractRetryAfterSec,
  isBanError,
  isCfChallengeError,
  isCfPathBlockError,
  isDeterministicSchemaOrParamErrorBody,
  isQuotaExhaustedError,
  isServerOverloadedError,
  isTokenInvalidError,
  isModelNotSupportedError,
  isUnansweredFunctionCallError,
} from "@src/proxy/error-classification.js";

describe("extractRetryAfterSec", () => {
  it("extracts resets_in_seconds from 429 body", () => {
    const body = JSON.stringify({ error: { resets_in_seconds: 30 } });
    expect(extractRetryAfterSec(body)).toBe(30);
  });

  it("computes seconds from resets_at timestamp", () => {
    const futureTs = Date.now() / 1000 + 60;
    const body = JSON.stringify({ error: { resets_at: futureTs } });
    const result = extractRetryAfterSec(body);
    expect(result).toBeGreaterThan(50);
    expect(result).toBeLessThanOrEqual(60);
  });

  it("returns undefined for past resets_at", () => {
    const pastTs = Date.now() / 1000 - 10;
    const body = JSON.stringify({ error: { resets_at: pastTs } });
    expect(extractRetryAfterSec(body)).toBeUndefined();
  });

  it("returns undefined for missing error field", () => {
    expect(extractRetryAfterSec(JSON.stringify({ detail: "nope" }))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractRetryAfterSec("not json")).toBeUndefined();
  });

  it("returns undefined for zero resets_in_seconds", () => {
    const body = JSON.stringify({ error: { resets_in_seconds: 0 } });
    expect(extractRetryAfterSec(body)).toBeUndefined();
  });
});

describe("isQuotaExhaustedError", () => {
  it("returns true for 402", () => {
    const err = new CodexApiError(402, '{"detail": "Payment required"}');
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  it("returns false for non-402", () => {
    const err = new CodexApiError(429, '{"error": "rate limited"}');
    expect(isQuotaExhaustedError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isQuotaExhaustedError(new Error("402"))).toBe(false);
    expect(isQuotaExhaustedError(null)).toBe(false);
  });
});

describe("isServerOverloadedError", () => {
  it("accepts only a structured server_is_overloaded 503", () => {
    expect(isServerOverloadedError(new CodexApiError(503, JSON.stringify({
      error: { code: "server_is_overloaded" },
    })))).toBe(true);
    expect(isServerOverloadedError(new CodexApiError(503, "database unavailable"))).toBe(false);
    expect(isServerOverloadedError(new CodexApiError(502, JSON.stringify({
      error: { code: "server_is_overloaded" },
    })))).toBe(false);
  });
});

describe("isBanError", () => {
  it("returns true for non-CF 403", () => {
    const err = new CodexApiError(403, '{"detail": "Your account has been flagged"}');
    expect(isBanError(err)).toBe(true);
  });

  it("returns false for CF challenge 403 (cf_chl)", () => {
    const err = new CodexApiError(403, '<!DOCTYPE html><html><body>cf_chl_managed</body></html>');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for CF challenge 403 (mitigation headers)", () => {
    const err = new CodexApiError(403, "cf-mitigated: challenge; cf-chl-bypass: managed");
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for CF challenge 403 when the signal is only in response headers", () => {
    const err = new CodexApiError(403, "", new Headers({ "cf-mitigated": "challenge" }));
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for CF challenge 403 (HTML page)", () => {
    const err = new CodexApiError(403, '<!DOCTYPE html><html><head></head></html>');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for non-403 status", () => {
    const err = new CodexApiError(429, '{"error": "rate limited"}');
    expect(isBanError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isBanError(new Error("random"))).toBe(false);
    expect(isBanError("string")).toBe(false);
    expect(isBanError(null)).toBe(false);
  });
});

describe("isCfChallengeError", () => {
  it("returns true for Cloudflare challenge indicators", () => {
    expect(isCfChallengeError(new CodexApiError(403, "<html>cf_chl challenge</html>"))).toBe(true);
    expect(isCfChallengeError(new CodexApiError(403, "<html>Just a Moment</html>"))).toBe(true);
    expect(isCfChallengeError(new CodexApiError(403, "cf-mitigated: challenge"))).toBe(true);
    expect(isCfChallengeError(new CodexApiError(403, "", new Headers({ "cf-chl-bypass": "managed" })))).toBe(true);
  });

  it("returns false for non-CF 403 bans", () => {
    const err = new CodexApiError(403, '{"detail": "Your account has been flagged"}');
    expect(isCfChallengeError(err)).toBe(false);
  });

  it("returns false for non-403 and non-Codex errors", () => {
    expect(isCfChallengeError(new CodexApiError(404, "<html>cf_chl challenge</html>"))).toBe(false);
    expect(isCfChallengeError(new Error("cf_chl"))).toBe(false);
  });
});

describe("isTokenInvalidError", () => {
  it("returns true for 401", () => {
    const err = new CodexApiError(401, '{"detail": "unauthorized"}');
    expect(isTokenInvalidError(err)).toBe(true);
  });

  it("returns false for non-401", () => {
    const err = new CodexApiError(403, '{"detail": "forbidden"}');
    expect(isTokenInvalidError(err)).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isTokenInvalidError(new Error("401"))).toBe(false);
  });
});

describe("isModelNotSupportedError", () => {
  it("detects 'model not supported' in message", () => {
    const err = new CodexApiError(400, '{"detail": "Model gpt-5.4 not supported for free plan"}');
    expect(isModelNotSupportedError(err)).toBe(true);
  });

  it("detects 'model not_available' in message", () => {
    const err = new CodexApiError(400, '{"detail": "Model gpt-5.4 not_available"}');
    expect(isModelNotSupportedError(err)).toBe(true);
  });

  it("returns false for 429 (rate limit)", () => {
    const err = new CodexApiError(429, '{"detail": "Model not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });

  it("returns false for 5xx", () => {
    const err = new CodexApiError(500, '{"detail": "Model not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });

  it("returns false when message lacks 'model'", () => {
    const err = new CodexApiError(400, '{"detail": "Feature not supported"}');
    expect(isModelNotSupportedError(err)).toBe(false);
  });
});

describe("isUnansweredFunctionCallError", () => {
  it("detects 'No tool output found for function call'", () => {
    const body = JSON.stringify({
      error: {
        message: "No tool output found for function call call_8vO7oqvintBWH5bAoAz3vPh5.",
        type: "invalid_request_error",
      },
    });
    expect(isUnansweredFunctionCallError(new CodexApiError(400, body))).toBe(true);
  });

  it("returns false for unrelated 400", () => {
    const body = JSON.stringify({ error: { message: "Something else broke" } });
    expect(isUnansweredFunctionCallError(new CodexApiError(400, body))).toBe(false);
  });

  it("returns false for non-400", () => {
    const body = JSON.stringify({
      error: { message: "No tool output found for function call call_x." },
    });
    expect(isUnansweredFunctionCallError(new CodexApiError(429, body))).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isUnansweredFunctionCallError(new Error("No tool output found"))).toBe(false);
    expect(isUnansweredFunctionCallError(null)).toBe(false);
  });
});

describe("isDeterministicSchemaOrParamErrorBody", () => {
  it("matches the real production string (Artifact tool doc_id regex rejected by upstream)", () => {
    const body = "Invalid schema for function 'Artifact': "
      + "'^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$' is not a 'regex'.";
    expect(isDeterministicSchemaOrParamErrorBody(body)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDeterministicSchemaOrParamErrorBody("INVALID SCHEMA FOR FUNCTION 'x'")).toBe(true);
  });

  it("does not match an unrelated 5xx body (empty / generic gateway text)", () => {
    expect(isDeterministicSchemaOrParamErrorBody("")).toBe(false);
    expect(isDeterministicSchemaOrParamErrorBody("Bad Gateway")).toBe(false);
    expect(isDeterministicSchemaOrParamErrorBody("<html><body>502 Bad Gateway</body></html>")).toBe(false);
  });
});

describe("classifyRawUpstreamError", () => {
  it("reclassifies a schema-error 502 to 400 + retryable: false", () => {
    const body = "Invalid schema for function 'Artifact': '...' is not a 'regex'.";
    expect(classifyRawUpstreamError(502, body)).toEqual({ status: 400, retryable: false });
  });

  it("leaves an ordinary transport 5xx untouched (status kept, retryable left undefined)", () => {
    expect(classifyRawUpstreamError(502, "Bad Gateway")).toEqual({ status: 502 });
    expect(classifyRawUpstreamError(503, "")).toEqual({ status: 503 });
  });

  it("leaves non-5xx statuses untouched even without matching text", () => {
    expect(classifyRawUpstreamError(401, "Unauthorized")).toEqual({ status: 401 });
  });
});

describe("isCfPathBlockError", () => {
  it("matches empty-body 404 (Cloudflare stealth deny)", () => {
    expect(isCfPathBlockError(new CodexApiError(404, ""))).toBe(true);
    expect(isCfPathBlockError(new CodexApiError(404, "   "))).toBe(true);
    expect(isCfPathBlockError(new CodexApiError(404, "\n"))).toBe(true);
  });

  it("does not match 404 with a real error body", () => {
    const body = JSON.stringify({ error: { message: "Not found" } });
    expect(isCfPathBlockError(new CodexApiError(404, body))).toBe(false);
  });

  it("does not match other empty-body statuses", () => {
    expect(isCfPathBlockError(new CodexApiError(403, ""))).toBe(false);
    expect(isCfPathBlockError(new CodexApiError(502, ""))).toBe(false);
  });

  it("returns false for non-CodexApiError", () => {
    expect(isCfPathBlockError(new Error("404"))).toBe(false);
    expect(isCfPathBlockError(null)).toBe(false);
  });
});
