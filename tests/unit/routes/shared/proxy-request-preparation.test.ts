import { describe, expect, it } from "vitest";
import {
  applyProxyRequestForwardingDefaults,
  ensureProxyRequestInputArray,
  isolateHardBoundOpaqueState,
} from "@src/routes/shared/proxy-request-preparation.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";

function makeProxyRequest(): ProxyRequest {
  return {
    model: "gpt-5.4",
    isStreaming: true,
    codexRequest: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      stream: true,
      store: false,
    },
  };
}

describe("proxy request preparation", () => {
  it("preserves a valid input array reference", () => {
    const request = makeProxyRequest();
    const originalInput = request.codexRequest.input;

    ensureProxyRequestInputArray(request);

    expect(request.codexRequest.input).toBe(originalInput);
  });

  it("normalizes invalid input to an empty array before later request snapshots", () => {
    const request = makeProxyRequest();
    request.codexRequest.input = "not-array" as unknown as ProxyRequest["codexRequest"]["input"];

    ensureProxyRequestInputArray(request);

    expect(request.codexRequest.input).toEqual([]);
  });

  it("isolates hard-bound opaque state from previous response and turn state", () => {
    const request = makeProxyRequest();
    request.requiredAccountEntryId = "entry-opaque";
    request.codexRequest.previous_response_id = "resp-stale";
    request.codexRequest.turnState = "turn-stale";
    request.codexRequest.useWebSocket = true;

    expect(isolateHardBoundOpaqueState(request)).toBe(true);
    expect(request.codexRequest.previous_response_id).toBeUndefined();
    expect(request.codexRequest.turnState).toBeUndefined();
    expect(request.codexRequest.useWebSocket).toBe(false);

    const ordinary = makeProxyRequest();
    expect(isolateHardBoundOpaqueState(ordinary)).toBe(false);
  });

  it("applies the prompt cache key without synthesizing cross-turn state", () => {
    const request = makeProxyRequest();

    applyProxyRequestForwardingDefaults({
      request,
      promptCacheKey: "cache-key-1",
    });

    expect(request.codexRequest.prompt_cache_key).toBe("cache-key-1");
    expect(request.codexRequest.turnState).toBeUndefined();
  });

  it("does not clear an existing turn state when no explicit turn state is available", () => {
    const request = makeProxyRequest();
    request.codexRequest.turnState = "turn-existing";

    applyProxyRequestForwardingDefaults({
      request,
      promptCacheKey: "cache-key-1",
    });

    expect(request.codexRequest.turnState).toBe("turn-existing");
  });

  it("adds reasoning encrypted content include only when reasoning has no include list", () => {
    const request = makeProxyRequest();
    request.codexRequest.reasoning = { effort: "high" };

    applyProxyRequestForwardingDefaults({
      request,
      promptCacheKey: "cache-key-1",
    });

    expect(request.codexRequest.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("preserves an existing include list for reasoning requests", () => {
    const request = makeProxyRequest();
    request.codexRequest.reasoning = { effort: "high" };
    request.codexRequest.include = ["custom.include"];

    applyProxyRequestForwardingDefaults({
      request,
      promptCacheKey: "cache-key-1",
    });

    expect(request.codexRequest.include).toEqual(["custom.include"]);
  });
});
