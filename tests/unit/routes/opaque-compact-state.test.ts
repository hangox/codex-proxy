import { describe, expect, it } from "vitest";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";
import {
  OpaqueCompactStateError,
  OpaqueCompactStateStore,
  extractOpaqueCompactStateMarker,
  hasOpaqueCompactStateReference,
  isSelfHealableOpaqueCompactStateFailure,
  isUnparseableOpaqueCompactMarker,
  mergeOpaquePreservedTails,
  removeOpaquePreservedTailReplay,
  restoreOpaqueCompactInput,
  type OpaqueCompactStateFailure,
} from "@src/routes/shared/opaque-compact-state.js";

const OUTPUT = [
  { type: "reasoning", encrypted_content: "opaque-secret", summary: [] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "compact state" }] },
];

type SaveOptions = Parameters<OpaqueCompactStateStore["save"]>[0];

function saveState(
  store: OpaqueCompactStateStore,
  options: Omit<SaveOptions, "compactInputDigest"> & { compactInputDigest?: string },
) {
  return store.save({ compactInputDigest: "digest-state-unit-v1", ...options });
}

function expectReason(fn: () => unknown, reason: string): void {
  try {
    fn();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OpaqueCompactStateError);
    expect((error as OpaqueCompactStateError).reason).toBe(reason);
  }
}

describe("opaque compact state store", () => {
  it("creates a short strict marker without exposing opaque output", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 1) });
    const { marker } = saveState(store, {
      output: OUTPUT,
      sessionId: "session-a",
      model: "gpt-5.4",
      accountEntryId: "entry-a",
    });

    expect(marker).toMatch(/^<analysis>Opaque compact state retained locally\.<\/analysis>\n<summary>codex-opaque-state:v1:[A-Za-z0-9_-]{32}:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}<\/summary>$/);
    expect(marker).not.toContain("opaque-secret");
    expect(marker.length).toBeLessThan(260);
    expect(store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4", accountEntryId: "entry-a" }).output).toEqual(OUTPUT);
  });

  it("binds preserved tool tails into the marker digest and restores them in order", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 13) });
    const preservedTail = [
      { type: "function_call", call_id: "tool-1", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-1", output: "tool-only-canary" },
    ] as const;
    const { marker, state } = saveState(store, {
      output: OUTPUT,
      preservedTail: [...preservedTail],
      sessionId: "session-a",
      model: "gpt-5.4",
      accountEntryId: "entry-a",
    });

    expect(store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4" }).preservedTail).toEqual(preservedTail);
    expect(restoreOpaqueCompactInput([
      { role: "assistant", content: marker },
      { role: "user", content: "continue" },
    ], marker, OUTPUT, [...preservedTail])).toEqual([
      ...OUTPUT,
      ...preservedTail,
      { role: "user", content: "continue" },
    ]);

    state.preservedTail[1] = { type: "function_call_output", call_id: "tool-1", output: "tampered" };
    expectReason(() => store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4" }), "comp_hash_mismatch");
  });

  it("deduplicates byte-equivalent preserved tails and rejects conflicting call ids", () => {
    const previous = [
      { type: "function_call", call_id: "tool-old", name: "Read", arguments: "{\"a\":1,\"b\":2}" },
      { type: "function_call_output", call_id: "tool-old", output: "{\"result\":\"old\"}" },
    ] as const;
    const current = [
      ...previous,
      { type: "function_call", call_id: "tool-new", name: "WebFetch", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-new", output: "new" },
    ] as const;

    expect(mergeOpaquePreservedTails([...previous], [...current])).toEqual([
      ...previous,
      current[2],
      current[3],
    ]);
    expectReason(() => mergeOpaquePreservedTails([...previous], [{
      type: "function_call_output",
      call_id: "tool-old",
      output: "conflicting",
    }]), "preserved_tail_conflict");
  });

  it.each([
    ["large integer", "{\"value\":9007199254740992}", "{\"value\":9007199254740993}"],
    ["negative large integer", "{\"value\":-9007199254740992}", "{\"value\":-9007199254740993}"],
    ["exponent spelling", "{\"value\":1e3}", "{\"value\":1000}"],
    ["negative zero", "{\"value\":-0}", "{\"value\":0}"],
    ["object key order", "{\"a\":1,\"b\":2}", "{\"b\":2,\"a\":1}"],
  ])("fails closed when %s JSON lexemes differ", (_case, previousArguments, currentArguments) => {
    expectReason(() => mergeOpaquePreservedTails(
      [{ type: "function_call", call_id: "tool-number", name: "Test", arguments: previousArguments }],
      [{ type: "function_call", call_id: "tool-number", name: "Test", arguments: currentArguments }],
    ), "preserved_tail_conflict");
  });

  it("removes complete replayed tails after the marker and rejects conflict or partial replay", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 14) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });
    const previousTail = [
      { type: "function_call", call_id: "tool-old", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-old", output: "old" },
    ] as const;
    const input = [
      { role: "assistant", content: marker },
      ...previousTail,
      { role: "user", content: "continuation" },
      { type: "function_call", call_id: "tool-new", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-new", output: "new" },
    ] as const;

    expect(removeOpaquePreservedTailReplay([...input], marker, [...previousTail])).toEqual([
      input[0],
      input[3],
      input[4],
      input[5],
    ]);
    expectReason(() => removeOpaquePreservedTailReplay([
      input[0],
      previousTail[0],
      { type: "function_call_output", call_id: "tool-old", output: "changed" },
    ], marker, [...previousTail]), "preserved_tail_conflict");
    expectReason(() => removeOpaquePreservedTailReplay([
      input[0],
      previousTail[0],
    ], marker, [...previousTail]), "preserved_tail_conflict");
  });

  it("rejects tampered, missing, expired, session, model, account, and comp-hash mismatches", () => {
    let now = 1000;
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 2), ttlMs: 100, now: () => now });
    const { marker, state } = saveState(store, {
      output: OUTPUT,
      sessionId: "session-a",
      model: "gpt-5.4",
      accountEntryId: "entry-a",
    });

    expectReason(() => store.resolve({ marker: marker.replace(/.$/, "x"), sessionId: "session-a", model: "gpt-5.4" }), "invalid_marker");
    expectReason(() => store.resolve({ marker: marker.replace(/:([A-Za-z0-9_-]{43})<\/summary>$/, ":AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</summary>"), sessionId: "session-a", model: "gpt-5.4" }), "tampered");
    expectReason(() => store.resolve({ marker, sessionId: "session-b", model: "gpt-5.4" }), "session_mismatch");
    expectReason(() => store.resolve({ marker, sessionId: "session-a", model: "gpt-5.5" }), "model_mismatch");
    expectReason(() => store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4", accountEntryId: "entry-b" }), "account_mismatch");
    expectReason(() => store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4", variantHash: "other-variant" }), "variant_mismatch");

    state.output = [{ type: "message", role: "assistant", content: [] }];
    expectReason(() => store.resolve({ marker, sessionId: "session-a", model: "gpt-5.4" }), "comp_hash_mismatch");

    const expiring = saveState(store, { output: OUTPUT, sessionId: "session-a", model: "gpt-5.4", accountEntryId: "entry-a" });
    now = 1200;
    expectReason(() => store.resolve({ marker: expiring.marker, sessionId: "session-a", model: "gpt-5.4" }), "expired");

    const otherStore = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 2) });
    expectReason(() => otherStore.resolve({ marker, sessionId: "session-a", model: "gpt-5.4" }), "missing");
  });

  it("uses bounded LRU behavior and supports independent compact variants", () => {
    const store = new OpaqueCompactStateStore({ capacity: 2, secret: Buffer.alloc(32, 3) });
    const one = saveState(store, { output: [{ value: 1 }], sessionId: "s", model: "m", accountEntryId: "a", variantHash: "v1" });
    const two = saveState(store, { output: [{ value: 2 }], sessionId: "s", model: "m", accountEntryId: "a", variantHash: "v2" });
    store.resolve({ marker: one.marker, sessionId: "s", model: "m", variantHash: "v1" });
    const three = saveState(store, { output: [{ value: 3 }], sessionId: "s", model: "m", accountEntryId: "a", variantHash: "v3" });

    expect(store.size()).toBe(2);
    expectReason(() => store.resolve({ marker: two.marker, sessionId: "s", model: "m", variantHash: "v2" }), "missing");
    expect(store.resolve({ marker: one.marker, sessionId: "s", model: "m", variantHash: "v1" }).output).toEqual([{ value: 1 }]);
    expect(store.resolve({ marker: three.marker, sessionId: "s", model: "m", variantHash: "v3" }).output).toEqual([{ value: 3 }]);
  });

  it("evicts least-recently-used states when the byte budget is exceeded", () => {
    const store = new OpaqueCompactStateStore({ capacity: 10, maxBytes: 1_000, secret: Buffer.alloc(32, 7) });
    const one = saveState(store, { output: [{ value: "a".repeat(600) }], sessionId: "s", model: "m", accountEntryId: "a", variantHash: "v1" });
    const two = saveState(store, { output: [{ value: "b".repeat(600) }], sessionId: "s", model: "m", accountEntryId: "a", variantHash: "v2" });

    expect(store.size()).toBe(1);
    expectReason(() => store.resolve({ marker: one.marker, sessionId: "s", model: "m" }), "missing");
    expect(store.resolve({ marker: two.marker, sessionId: "s", model: "m" }).output).toEqual([{ value: "b".repeat(600) }]);
  });

  it("invalidates an older marker when the same session/model/variant is compacted again", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 9) });
    const one = saveState(store, {
      output: [{ value: 1 }],
      sessionId: "s",
      model: "m",
      accountEntryId: "a",
      variantHash: "v",
    });
    const two = saveState(store, {
      output: [{ value: 2 }],
      sessionId: "s",
      model: "m",
      accountEntryId: "a",
      variantHash: "v",
    });

    expectReason(() => store.resolve({ marker: one.marker, sessionId: "s", model: "m", variantHash: "v" }), "missing");
    expect(store.resolve({ marker: two.marker, sessionId: "s", model: "m", variantHash: "v" }).output).toEqual([{ value: 2 }]);
  });

  it("rejects a single state larger than the byte budget instead of returning an invalid marker", () => {
    const store = new OpaqueCompactStateStore({ maxBytes: 300, secret: Buffer.alloc(32, 8) });
    expectReason(() => saveState(store, {
      output: [{ value: "x".repeat(600) }],
      sessionId: "s",
      model: "m",
      accountEntryId: "a",
    }), "state_too_large");
    expect(store.size()).toBe(0);
  });

  it("extracts only strict markers and restores opaque output in place of marker text", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 4) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });
    const req = {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [
        { role: "assistant", content: marker },
        { role: "user", content: "continue" },
      ],
    } as AnthropicMessagesRequest;
    expect(extractOpaqueCompactStateMarker(req)).toBe(marker);
    const ordinaryQuoted = { ...req, messages: [{ role: "user", content: "codex-opaque-state:v1 quoted" }] } as AnthropicMessagesRequest;
    expect(extractOpaqueCompactStateMarker(ordinaryQuoted)).toBeNull();
    expect(hasOpaqueCompactStateReference(ordinaryQuoted)).toBe(false);

    const restored = restoreOpaqueCompactInput([
      { role: "user", content: "old history that must be replaced" },
      { role: "assistant", content: marker },
      { role: "user", content: "continue" },
    ], marker, OUTPUT);
    expect(restored.slice(0, OUTPUT.length)).toEqual(OUTPUT);
    expect(JSON.stringify(restored)).not.toContain("old history that must be replaced");
    expect(JSON.stringify(restored)).not.toContain("codex-opaque-state:v1");
    expect(restored.at(-1)).toEqual({ role: "user", content: "continue" });
  });

  it("extracts, resolves, and removes a Claude Code compact summary wrapper", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 5) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });
    const token = marker.match(/<summary>([^<]+)<\/summary>/)?.[1];
    expect(token).toBeDefined();
    const transcriptPath = "/tmp/claude-wrapper-test/session.jsonl";
    const wrapper =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
      token +
      "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, " +
      "or content you generated), read the full transcript at: " + transcriptPath;
    const req = {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [
        { role: "user", content: wrapper },
        { role: "user", content: "continue" },
      ],
    } as AnthropicMessagesRequest;

    expect(extractOpaqueCompactStateMarker(req)).toBe(wrapper);
    expect(store.resolve({ marker: wrapper, sessionId: "s", model: "m", accountEntryId: "a" }).output).toEqual(OUTPUT);

    const wrapperWithContinuation = wrapper + "\n\nsame-message continuation";
    const continuationReq = {
      ...req,
      messages: [{ role: "user", content: wrapperWithContinuation }],
    } as AnthropicMessagesRequest;
    expect(extractOpaqueCompactStateMarker(continuationReq)).toBe(wrapper);

    const restored = restoreOpaqueCompactInput([
      { role: "user", content: [{ type: "input_text", text: "old history" }] },
      { role: "user", content: wrapperWithContinuation },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ], wrapper, OUTPUT);
    expect(restored.slice(0, OUTPUT.length)).toEqual(OUTPUT);
    expect(JSON.stringify(restored)).not.toContain("old history");
    expect(JSON.stringify(restored)).toContain("same-message continuation");
    expect(JSON.stringify(restored)).not.toContain("codex-opaque-state:v1");
    expect(JSON.stringify(restored)).not.toContain(transcriptPath);
    expect(restored.at(-1)).toEqual({ role: "user", content: [{ type: "input_text", text: "continue" }] });
  });

  it("preserves same-block continuation and removes duplicate marker references", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 10) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });
    const token = marker.match(/<summary>([^<]+)<\/summary>/)?.[1];
    expect(token).toBeDefined();
    const wrapper =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
      token +
      "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, " +
      "or content you generated), read the full transcript at: /tmp/session.jsonl\n" +
      "Continue the conversation from where it left off without asking the user any further questions. " +
      "Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with " +
      "\"I'll continue\" or similar. Pick up the last task as if the break never happened.";

    const restored = restoreOpaqueCompactInput([
      { role: "user", content: [{ type: "input_text", text: "old history" }] },
      { role: "assistant", content: marker },
      { role: "user", content: [{ type: "input_text", text: wrapper + "\n\nsame-block continuation" }] },
      { role: "user", content: "continue" },
    ], wrapper, OUTPUT);

    expect(restored.slice(0, OUTPUT.length)).toEqual(OUTPUT);
    expect(JSON.stringify(restored)).toContain("same-block continuation");
    expect(JSON.stringify(restored)).toContain("continue");
    expect(JSON.stringify(restored)).not.toContain("old history");
    expect(JSON.stringify(restored)).not.toContain("codex-opaque-state:v1");
  });

  it("uses the last duplicate marker as the authoritative compact boundary", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 11) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });

    const restored = restoreOpaqueCompactInput([
      { role: "user", content: "OLD" },
      { role: "assistant", content: marker },
      { role: "user", content: "MID" },
      { role: "assistant", content: marker },
      { role: "user", content: "NEW" },
    ], marker, OUTPUT);

    expect(restored).toEqual([...OUTPUT, { role: "user", content: "NEW" }]);
  });

  it("extracts a strict raw marker prefix and preserves its same-string continuation", () => {
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 12) });
    const { marker } = saveState(store, { output: OUTPUT, sessionId: "s", model: "m", accountEntryId: "a" });
    const rawWithContinuation = marker + "\n\nraw continuation";
    const req = {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "assistant", content: rawWithContinuation }],
    } as AnthropicMessagesRequest;

    expect(extractOpaqueCompactStateMarker(req)).toBe(marker);
    expect(store.resolve({ marker: extractOpaqueCompactStateMarker(req)!, sessionId: "s", model: "m" }).output).toEqual(OUTPUT);
    const restored = restoreOpaqueCompactInput([
      { role: "user", content: "OLD" },
      { role: "assistant", content: rawWithContinuation },
    ], marker, OUTPUT);
    expect(restored).toEqual([...OUTPUT, { role: "assistant", content: "raw continuation" }]);
  });

  it("rejects malformed compact wrappers without matching ordinary wrapper-like text", () => {
    const malformed =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
      "codex-opaque-state:v1:not-a-valid-token\n\n" +
      "If you need specific details from before compaction (like exact code snippets, error messages, " +
      "or content you generated), read the full transcript at: /tmp/transcript.jsonl";
    const malformedReq = {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: malformed }],
    } as AnthropicMessagesRequest;
    expect(extractOpaqueCompactStateMarker(malformedReq)).toBe(malformed);
    const store = new OpaqueCompactStateStore({ secret: Buffer.alloc(32, 6) });
    expectReason(() => store.resolve({ marker: malformed, sessionId: "s", model: "m" }), "invalid_marker");

    const ordinary = {
      ...malformedReq,
      messages: [{
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context, " +
          "but this ordinary note merely mentions codex-opaque-state:v1.",
      }],
    } as AnthropicMessagesRequest;
    expect(extractOpaqueCompactStateMarker(ordinary)).toBeNull();
  });
});

describe("opaque compact failure reason classification (8.1/8.3 collapse point)", () => {
  // messages.ts 的 8.1/8.3 编排完全依赖这两个导出函数，不再散落
  // reason === "..." 比较——这里直接锁死它们的分类结果，防止未来新增 reason
  // 时漏分类（8.1 红线：store 级致命故障必须恒为 false）。
  const ALL_REASONS: OpaqueCompactStateFailure[] = [
    "invalid_marker",
    "tampered",
    "missing",
    "not_found",
    "expired",
    "session_mismatch",
    "model_mismatch",
    "account_mismatch",
    "variant_mismatch",
    "comp_hash_mismatch",
    "preserved_tail_conflict",
    "state_too_large",
    "store_unavailable",
    "store_locked",
    "schema_unsupported",
    "key_unavailable",
    "key_mismatch",
    "state_corrupt",
    "stale_generation",
    "store_reset_detected",
    "migration_failed",
    "key_policy_invalid",
  ];

  it("isSelfHealableOpaqueCompactStateFailure: 只有 not_found/expired/missing 为真", () => {
    const expectedTrue = new Set(["not_found", "expired", "missing"]);
    for (const reason of ALL_REASONS) {
      expect(isSelfHealableOpaqueCompactStateFailure(reason)).toBe(expectedTrue.has(reason));
    }
  });

  it("isUnparseableOpaqueCompactMarker: 只有 invalid_marker 为真（tampered 仍是完整性信号，不算）", () => {
    for (const reason of ALL_REASONS) {
      expect(isUnparseableOpaqueCompactMarker(reason)).toBe(reason === "invalid_marker");
    }
  });

  it("良性自愈族与压根不是 marker 族互斥：任何 reason 不会同时命中两者", () => {
    for (const reason of ALL_REASONS) {
      const selfHealable = isSelfHealableOpaqueCompactStateFailure(reason);
      const unparseable = isUnparseableOpaqueCompactMarker(reason);
      expect(selfHealable && unparseable).toBe(false);
    }
  });
});
