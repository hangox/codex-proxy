/**
 * Direct proxy handler — forwards raw requests to relay accounts
 * without Codex translation. Used for relay accounts with non-codex
 * formats (openai, anthropic, gemini).
 */

import type { Context } from "hono";
import { stream } from "hono/streaming";
import { getTransport } from "../../tls/transport.js";
import type { AccountPool } from "../../auth/account-pool.js";
import type { AcquiredAccount } from "../../auth/types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";

export interface DirectProxyOptions {
  c: Context;
  accountPool: AccountPool;
  acquired: AcquiredAccount;
  rawBody: string;
  /** Path appended to acquired.baseUrl (e.g. "/chat/completions"). */
  upstreamPath: string;
  isStreaming: boolean;
  proxyPool?: ProxyPool;
}

/**
 * Forward a raw request to a relay's upstream URL without translation.
 * Handles streaming (SSE pipe) and non-streaming (collect + return).
 */
export async function handleDirectProxy(opts: DirectProxyOptions): Promise<Response> {
  const { c, accountPool, acquired, rawBody, upstreamPath, isStreaming, proxyPool } = opts;
  const { entryId, token, baseUrl } = acquired;

  if (!baseUrl) {
    accountPool.releaseWithoutCounting(entryId);
    c.status(500);
    return c.json({ error: "Relay account has no baseUrl" });
  }

  const url = baseUrl + upstreamPath;
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  const transport = getTransport();

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const tag = `[DirectProxy]`;
  console.log(`${tag} Account ${entryId} → ${url} (stream=${isStreaming})`);

  try {
    if (isStreaming) {
      headers["Accept"] = "text/event-stream";
      const transportRes = await transport.post(url, headers, rawBody, undefined, undefined, proxyUrl);

      if (transportRes.status === 429) {
        accountPool.markRateLimited(entryId, { countRequest: true });
        c.status(429);
        // Read body for error detail
        const reader = transportRes.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        return c.body(Buffer.concat(chunks), 429);
      }

      if (transportRes.status < 200 || transportRes.status >= 300) {
        accountPool.release(entryId);
        const reader = transportRes.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        c.status(transportRes.status as 400);
        return c.body(Buffer.concat(chunks));
      }

      // Stream response back to client
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (s) => {
        const reader = transportRes.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              await s.write(value);
            } catch {
              // Client disconnected — stop reading upstream
              break;
            }
          }
        } finally {
          reader.releaseLock();
          accountPool.release(entryId);
        }
      });
    } else {
      // Non-streaming: collect full response
      headers["Accept"] = "application/json";
      const result = await transport.simplePost(url, headers, rawBody, 120, proxyUrl);

      if (result.status === 429) {
        accountPool.markRateLimited(entryId, { countRequest: true });
        c.status(429);
        return c.body(result.body);
      }

      accountPool.release(entryId);
      c.status(result.status as 200);
      c.header("Content-Type", "application/json");
      return c.body(result.body);
    }
  } catch (err) {
    accountPool.release(entryId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Error:`, msg);
    c.status(502);
    return c.json({ error: { message: `Direct proxy error: ${msg}`, type: "proxy_error" } });
  }
}
