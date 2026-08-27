/**
 * Session affinity — maps Codex response IDs to account entry IDs.
 *
 * When a request includes `previous_response_id`, the proxy looks up which
 * account created that response and routes to the same account. This enables:
 *   - Server-side conversation history reuse (previous_response_id chain)
 *   - Prompt cache hits (cache is per-account on the backend)
 */

import { createHash } from "crypto";

export interface ChainAdvanceTicket {
  conversationId: string;
  variantHash?: string;
  generation: number;
  expectedParentResponseId: string | null;
}

interface ChainHead {
  conversationId: string;
  variantHash?: string;
  responseId: string | null;
  generation: number;
  updatedAt: number;
}

interface AffinityEntry {
  entryId: string;
  conversationId: string;
  /** SHA-256 hex of the instructions string. Stored as hash to bound memory usage. */
  instructionsHash?: string;
  inputTokens?: number;
  functionCallIds?: string[];
  /** Identifies the (instructions + tools) "shape" of the request that
   *  produced this response. Used by routes that need to keep concurrent
   *  variants of the same conversation (sub-agents, parallel tool calls)
   *  on independent prev_response_id chains. Optional for back-compat with
   *  routes that don't compute it (e.g. [Responses] / [Chat] / [Gemini]). */
  variantHash?: string;
  createdAt: number;
}

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class SessionAffinityMap {
  private map = new Map<string, AffinityEntry>();
  private chainHeads = new Map<string, ChainHead>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Capture the current chain generation before dispatching an upstream request. */
  captureChainAdvance(
    conversationId: string,
    variantHash?: string,
    expectedParentResponseId?: string | null,
  ): ChainAdvanceTicket {
    const head = this.getChainHead(conversationId, variantHash);
    return {
      conversationId,
      variantHash,
      generation: head?.generation ?? 0,
      expectedParentResponseId:
        expectedParentResponseId === undefined
          ? head?.responseId ?? null
          : expectedParentResponseId,
    };
  }

  /** Record response metadata and conditionally advance the implicit chain head. */
  record(
    responseId: string,
    entryId: string,
    conversationId: string,
    turnState?: string,
    instructions?: string | null,
    inputTokens?: number,
    functionCallIds?: string[],
    variantHash?: string,
    chainTicket?: ChainAdvanceTicket,
  ): boolean {
    void turnState;
    const now = Date.now();
    this.map.set(responseId, {
      entryId,
      conversationId,
      instructionsHash: instructions !== undefined
        ? createHash("sha256").update(instructions ?? "").digest("hex")
        : undefined,
      inputTokens,
      functionCallIds: functionCallIds ? [...functionCallIds] : undefined,
      variantHash,
      createdAt: now,
    });

    const key = this.chainKey(conversationId, variantHash);
    const current = this.getChainHead(conversationId, variantHash);
    if (current?.responseId === responseId) return true;

    if (chainTicket) {
      if (
        chainTicket.conversationId !== conversationId ||
        chainTicket.variantHash !== variantHash ||
        (current?.generation ?? 0) !== chainTicket.generation ||
        (current?.responseId ?? null) !== chainTicket.expectedParentResponseId
      ) {
        return false;
      }
    }

    this.chainHeads.set(key, {
      conversationId,
      variantHash,
      responseId,
      generation: (current?.generation ?? 0) + 1,
      updatedAt: now,
    });
    return true;
  }

  /** Look up which account created a given response. */
  lookup(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.entryId ?? null;
  }

  /** Look up the conversation ID for a given response. */
  lookupConversationId(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.conversationId ?? null;
  }

  /** Look up the latest response ID recorded for a conversation.
   *  When `maxAgeMs` is provided, entries older than that are skipped — used
   *  by implicit-resume to avoid handing the upstream a `previous_response_id`
   *  whose prompt cache has likely already been evicted.
   *  When `variantHash` is provided, only entries recorded with that exact
   *  variantHash match — keeps sub-agents and main-thread chains independent. */
  lookupLatestResponseIdByConversationId(
    conversationId: string,
    maxAgeMs?: number,
    variantHash?: string,
  ): string | null {
    const now = Date.now();
    if (variantHash !== undefined) {
      const head = this.getChainHead(conversationId, variantHash);
      if (head) {
        if (!head.responseId) return null;
        const entry = this.getEntry(head.responseId);
        if (!entry) {
          this.invalidateHead(head);
          return null;
        }
        if (maxAgeMs !== undefined && now - entry.createdAt > maxAgeMs) return null;
        return head.responseId;
      }
    }

    let latestResponseId: string | null = null;
    let latestCreatedAt = -1;
    for (const [responseId, entry] of this.map) {
      if (entry.conversationId !== conversationId) continue;
      if (variantHash !== undefined && entry.variantHash !== variantHash) continue;
      const liveEntry = this.getEntry(responseId);
      if (!liveEntry) continue;
      if (maxAgeMs !== undefined && now - liveEntry.createdAt > maxAgeMs) continue;
      if (liveEntry.createdAt >= latestCreatedAt) {
        latestCreatedAt = liveEntry.createdAt;
        latestResponseId = responseId;
      }
    }
    return latestResponseId;
  }

  /**
   * turnState is scoped to a single Codex turn and must never be restored from
   * cross-turn affinity. Kept for compatibility with older callers/tests.
   */
  lookupTurnState(_responseId: string): null {
    return null;
  }

  lookupInstructionsHash(responseId: string): string | null {
    const entry = this.getEntry(responseId);
    return entry?.instructionsHash ?? null;
  }

  lookupLatestInstructionsHashByConversationId(conversationId: string): string | null {
    const responseId = this.lookupLatestResponseIdByConversationId(conversationId);
    if (!responseId) return null;
    return this.lookupInstructionsHash(responseId);
  }

  lookupInputTokens(responseId: string): number | null {
    const entry = this.getEntry(responseId);
    return entry?.inputTokens ?? null;
  }

  lookupFunctionCallIds(responseId: string): string[] {
    const entry = this.getEntry(responseId);
    return entry?.functionCallIds ? [...entry.functionCallIds] : [];
  }

  /** Drop a response ID — called after upstream rejects it as not-found. */
  forget(responseId: string): void {
    this.map.delete(responseId);
    for (const head of this.chainHeads.values()) {
      if (head.responseId === responseId) this.invalidateHead(head);
    }
  }

  /** Drop every response recorded for a conversation, optionally scoped to a
   *  variantHash. Called when a resumed stream dies silently before its
   *  terminal event: once the pooled WS has rotated, every prev id in the
   *  chain is not_found upstream, so forgetting only the latest entry would
   *  just make the next lookup fall back to an equally dead older id.
   *  Returns the number of entries dropped. */
  forgetConversation(conversationId: string, variantHash?: string): number {
    let dropped = 0;
    for (const [responseId, entry] of this.map) {
      if (entry.conversationId !== conversationId) continue;
      if (variantHash !== undefined && entry.variantHash !== variantHash) continue;
      this.map.delete(responseId);
      dropped++;
    }
    for (const head of this.chainHeads.values()) {
      if (head.conversationId !== conversationId) continue;
      if (variantHash !== undefined && head.variantHash !== variantHash) continue;
      this.invalidateHead(head);
    }
    return dropped;
  }


  private chainKey(conversationId: string, variantHash?: string): string {
    return JSON.stringify([conversationId, variantHash ?? null]);
  }

  private getChainHead(conversationId: string, variantHash?: string): ChainHead | null {
    return this.chainHeads.get(this.chainKey(conversationId, variantHash)) ?? null;
  }

  private invalidateHead(head: ChainHead): void {
    head.responseId = null;
    head.generation += 1;
    head.updatedAt = Date.now();
  }

  private getEntry(responseId: string): AffinityEntry | null {
    const entry = this.map.get(responseId);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(responseId);
      return null;
    }
    return entry;
  }

  /** Remove expired entries. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now - entry.createdAt > this.ttlMs) {
        this.map.delete(key);
      }
    }
    for (const [key, head] of this.chainHeads) {
      if (now - head.updatedAt > this.ttlMs) {
        this.chainHeads.delete(key);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.map.clear();
    this.chainHeads.clear();
  }
}

/** Singleton instance. */
let instance: SessionAffinityMap | null = null;

export function getSessionAffinityMap(): SessionAffinityMap {
  if (!instance) {
    instance = new SessionAffinityMap();
  }
  return instance;
}
