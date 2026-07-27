import type { AccountPool } from "../../auth/account-pool.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import type { UpstreamPrematureCloseError } from "../../translation/codex-event-extractor.js";
import { releaseAccount } from "./account-acquisition.js";
import type { ProxyRequest } from "./proxy-handler-types.js";
import { annotateImageGenOutcome } from "./proxy-handler-utils.js";
import { formatAccount } from "./opaque-compact-audit.js";

export interface NonStreamingPrematureCloseResponsePlan {
  status: 504;
  message: string;
}

export interface HandleNonStreamingPrematureCloseOptions {
  accountPool: AccountPool;
  entryId: string;
  /** true 表示本请求受 opaque 隐私合同约束，日志不得含明文账号。 */
  sensitive?: boolean;
  err: UpstreamPrematureCloseError;
  req: ProxyRequest;
  tag: string;
  requestId: string;
  released: Set<string>;
  variantHash?: string;
  logWarn?: (message: string) => void;
}

export function handleNonStreamingPrematureClose(
  options: HandleNonStreamingPrematureCloseOptions,
): NonStreamingPrematureCloseResponsePlan {
  const {
    accountPool,
    entryId,
    sensitive,
    err,
    req,
    tag,
    requestId,
    released,
    variantHash,
    logWarn = (message) => console.warn(message),
  } = options;

  const email = accountPool.getEntry(entryId)?.email ?? "?";
  logWarn(
    `[${tag}] ${formatAccount(entryId, sensitive, email)} | upstream premature close (hadReasoning=${err.hadReasoning} events=${err.eventCount}) — failing fast, not retrying`,
  );
  recordStreamCloseEvent({
    kind: "upstream-premature",
    requestId,
    tag,
    model: req.model,
    accountEntryId: entryId,
    variantHash,
    responseId: err.responseId,
    eventCount: err.eventCount,
    hadReasoning: err.hadReasoning,
    detail: err.message,
  });
  releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);

  return {
    status: 504,
    message: err.message,
  };
}
