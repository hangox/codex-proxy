/**
 * Tests for parseRateLimitsEvent — extracts quota from the
 * `codex.rate_limits` WebSocket SSE event payload.
 */

import { describe, it, expect } from "vitest";
import { parseRateLimitsEvent } from "../rate-limit-headers.js";

describe("parseRateLimitsEvent", () => {
  it("parses a full codex.rate_limits event with primary + secondary", () => {
    const data = {
      type: "codex.rate_limits",
      plan_type: "plus",
      rate_limits: {
        primary: { used_percent: 42.0, window_minutes: 300, reset_at: 1700000000 },
        secondary: { used_percent: 18.0, window_minutes: 10080, reset_at: 1700500000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 42.0, window_minutes: 300, reset_at: 1700000000 },
      secondary: { used_percent: 18.0, window_minutes: 10080, reset_at: 1700500000 },
    });
  });

  it("parses event with only primary window", () => {
    const data = {
      type: "codex.rate_limits",
      rate_limits: {
        primary: { used_percent: 80.5, window_minutes: 300, reset_at: 1700000000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 80.5, window_minutes: 300, reset_at: 1700000000 },
      secondary: null,
    });
  });

  it("parses event with only secondary window", () => {
    const data = {
      type: "codex.rate_limits",
      rate_limits: {
        secondary: { used_percent: 50.0, window_minutes: 10080, reset_at: 1700500000 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: null,
      secondary: { used_percent: 50.0, window_minutes: 10080, reset_at: 1700500000 },
    });
  });

  it("returns null for missing rate_limits field", () => {
    expect(parseRateLimitsEvent({ type: "codex.rate_limits" })).toBeNull();
    expect(parseRateLimitsEvent({})).toBeNull();
    expect(parseRateLimitsEvent(null)).toBeNull();
    expect(parseRateLimitsEvent("string")).toBeNull();
  });

  it("returns null when rate_limits has no windows", () => {
    expect(parseRateLimitsEvent({ rate_limits: {} })).toBeNull();
    expect(parseRateLimitsEvent({ rate_limits: { primary: null } })).toBeNull();
  });

  it("handles missing optional fields in window", () => {
    const data = {
      rate_limits: {
        primary: { used_percent: 10 },
      },
    };
    const result = parseRateLimitsEvent(data);
    expect(result).toEqual({
      primary: { used_percent: 10, window_minutes: null, reset_at: null },
      secondary: null,
    });
  });

  it("handles invalid used_percent gracefully", () => {
    const data = {
      rate_limits: {
        primary: { used_percent: "not_a_number", window_minutes: 300, reset_at: 1700000000 },
      },
    };
    expect(parseRateLimitsEvent(data)).toBeNull();
  });
});
