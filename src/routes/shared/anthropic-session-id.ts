import { createHash } from "crypto";
import { translateSystemInstructionSegments } from "../../translation/anthropic-to-codex.js";
import type { AnthropicMessagesRequest } from "../../types/anthropic.js";

function parseMetadataSessionId(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown; device_id?: unknown };
    return typeof parsed.session_id === "string" &&
      parsed.session_id &&
      typeof parsed.device_id === "string" &&
      parsed.device_id
      ? parsed.session_id
      : null;
  } catch {
    return null;
  }
}

export function extractAnthropicClientConversationId(
  req: AnthropicMessagesRequest,
  headerSessionId: string | undefined,
): string | null {
  const normalizedHeaderSessionId = headerSessionId?.trim();
  if (normalizedHeaderSessionId) return normalizedHeaderSessionId;
  return parseMetadataSessionId(req.metadata?.user_id);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hasEphemeralCacheControl(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cacheControl = (value as Record<string, unknown>).cache_control;
  return typeof cacheControl === "object" &&
    cacheControl !== null &&
    !Array.isArray(cacheControl) &&
    (cacheControl as Record<string, unknown>).type === "ephemeral";
}

function formatCacheKey(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * 从 Anthropic 请求最后一个显式 cache_control 断点的前缀导出上游 cache key。
 * system 片段直接复用翻译器的规范化结果及原始 block 索引，确保 billing-header
 * 清洗与断点位置共享同一套语义；它仅用于没有 Claude Code session 标识的客户端。
 */
export function deriveAnthropicCacheControlKey(req: AnthropicMessagesRequest): string | null {
  const prefix: unknown[] = [];
  let cacheablePrefix: string | null = null;
  const append = (scope: string, value: unknown): void => {
    prefix.push({ scope, value });
    if (hasEphemeralCacheControl(value)) cacheablePrefix = stableJson(prefix);
  };

  for (const tool of req.tools ?? []) append("tool", tool);

  const translatedSystemSegments = translateSystemInstructionSegments(req.system);
  if (typeof req.system === "string") {
    const segment = translatedSystemSegments[0];
    if (segment) append("system", segment.text);
  } else {
    const segmentsBySourceIndex = new Map(
      translatedSystemSegments.map((segment) => [segment.sourceIndex, segment.text]),
    );
    for (const [sourceIndex, block] of (req.system ?? []).entries()) {
      const text = segmentsBySourceIndex.get(sourceIndex);
      if (text) append("system", { text, cache_control: block.cache_control });
    }
  }

  for (const message of req.messages) {
    if (typeof message.content === "string") {
      append(`message:${message.role}`, message.content);
      continue;
    }
    for (const block of message.content) append(`message:${message.role}`, block);
  }

  if (cacheablePrefix === null) return null;
  const hash = createHash("sha256")
    .update(req.model)
    .update("\0")
    .update(cacheablePrefix)
    .digest("hex");
  return formatCacheKey(hash);
}
