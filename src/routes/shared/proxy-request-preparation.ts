import type { ProxyRequest } from "./proxy-handler-types.js";

export interface ApplyProxyRequestForwardingDefaultsOptions {
  request: ProxyRequest;
  promptCacheKey: string;
}

export function ensureProxyRequestInputArray(request: ProxyRequest): void {
  if (!Array.isArray(request.codexRequest.input)) {
    request.codexRequest.input = [];
  }
}

export function isolateHardBoundOpaqueState(request: ProxyRequest): boolean {
  if (request.requiredAccountEntryId === undefined) return false;
  request.codexRequest.previous_response_id = undefined;
  request.codexRequest.turnState = undefined;
  request.codexRequest.useWebSocket = false;
  return true;
}

export function applyProxyRequestForwardingDefaults(
  options: ApplyProxyRequestForwardingDefaultsOptions,
): void {
  const { request, promptCacheKey } = options;

  if (!request.suppressDerivedPromptCacheKey || request.codexRequest.prompt_cache_key) {
    request.codexRequest.prompt_cache_key = promptCacheKey;
  }

  if (request.codexRequest.reasoning && !request.codexRequest.include?.length) {
    request.codexRequest.include = ["reasoning.encrypted_content"];
  }
}
