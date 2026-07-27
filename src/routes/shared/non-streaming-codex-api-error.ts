import type { CodexApiError } from "../../proxy/codex-api.js";
import { stripCodexErrorPrefix } from "./proxy-handler-utils.js";
import { formatAccount } from "./opaque-compact-audit.js";

export interface RethrowNonStreamingCodexApiErrorDuringCollectOptions {
  err: CodexApiError;
  tag: string;
  entryId: string;
  /** true 表示本请求受 opaque 隐私合同约束，日志不得含明文账号。 */
  sensitive?: boolean;
}

export function rethrowNonStreamingCodexApiErrorDuringCollect(
  options: RethrowNonStreamingCodexApiErrorDuringCollectOptions,
): never {
  const { err, tag, entryId, sensitive } = options;

  console.warn(
    `[${tag}] ${formatAccount(entryId, sensitive)} | upstream ${err.status} during collect: ${stripCodexErrorPrefix(err.message).slice(0, 200)}`,
  );
  throw err;
}
