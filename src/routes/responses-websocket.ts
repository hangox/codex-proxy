/**
 * Client-facing WebSocket support for `/v1/responses` (issue #681).
 *
 * Newer Codex CLI clients (wire_api="responses") probe `ws://host:port/v1/responses`
 * via a WebSocket upgrade (GET + `Upgrade: websocket`) and fall back to HTTPS
 * POST+SSE when the proxy returns 404. This module wires a `ws` WebSocketServer
 * onto the same underlying node `http.Server` that `@hono/node-server` serves, so
 * upgrades against `/v1/responses` are accepted.
 *
 * The socket itself is only a transport: nothing runs until the client sends a
 * `response.create` JSON frame. Each frame is dispatched through the EXACT same
 * POST `/v1/responses` handler (via `app.request()`), which re-runs the shared
 * account-pool rotation / upstream routing / SSE streaming path. The resulting SSE
 * events are then forwarded back to the client as WebSocket text frames — each frame
 * carries the `data:` JSON payload of one event, mirroring what the Codex backend
 * emits over its own WebSocket. The socket stays open for the next `response.create`
 * frame (multi-turn / `previous_response_id` resume support).
 *
 * HTTP POST + SSE remains the fallback and is untouched.
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { getConfig } from "../config.js";
import { parseSSEStream } from "../proxy/codex-sse.js";

/** The only path this server accepts upgrades for. */
const UPGRADE_PATH = "/v1/responses";

const WS_OPEN = 1;

/**
 * Hop-by-hop / handshake-only headers from the upgrade request that must not be
 * forwarded onto the synthetic POST (Fetch would reject or mis-parse them).
 */
const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "host",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

export interface ResponsesWebSocketServerOptions {
  /** The node http.Server that @hono/node-server's serve() returned. */
  server: Server;
  /** The mounted Hono app exposing `/v1/responses` (POST). Frames are re-dispatched here. */
  app: Hono;
  accountPool: AccountPool;
  clientKeyPool?: ClientKeyPool;
}

export class ResponsesWebSocketServer {
  private readonly server: Server;
  private readonly app: Hono;
  private readonly accountPool: AccountPool;
  private readonly clientKeyPool?: ClientKeyPool;
  private readonly wss: WebSocketServer;
  private readonly onUpgradeBound: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closed = false;

  constructor(options: ResponsesWebSocketServerOptions) {
    this.server = options.server;
    this.app = options.app;
    this.accountPool = options.accountPool;
    this.clientKeyPool = options.clientKeyPool;

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => {
      console.error("[responses-ws] WebSocketServer error:", err);
    });

    this.onUpgradeBound = (req, socket, head) => this.handleUpgrade(req, socket, head);
    this.server.on("upgrade", this.onUpgradeBound);
  }

  /**
   * Detach the upgrade listener and close all client sockets. Called from the
   * existing shutdown path in `src/index.ts`.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.off("upgrade", this.onUpgradeBound);
    for (const client of this.wss.clients) {
      try {
        client.close(1000, "server shutdown");
      } catch {
        /* already closing */
      }
    }
    await new Promise<void>((resolve) => {
      try {
        this.wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  // ── Upgrade handling ────────────────────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== UPGRADE_PATH) {
      // Not ours — destroy so the socket doesn't hang (no other upgrade consumer).
      socket.destroy();
      return;
    }

    if (!this.authorize(req)) {
      this.rejectUpgrade(socket, 401, "Unauthorized: invalid proxy API key");
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  /** Same auth semantics as the POST route's `apiKeyAuth` middleware. */
  private authorize(req: IncomingMessage): boolean {
    const key = this.extractBearerKey(req);
    if (key && this.accountPool.validateProxyApiKey(key)) return true;
    if (key && this.clientKeyPool && this.clientKeyPool.getByKey(key) !== undefined) return true;
    // Passthrough / no-auth mode: no master proxy_api_key is configured.
    const config = getConfig();
    if (!config?.server?.proxy_api_key) return true;
    return false;
  }

  private extractBearerKey(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    return match ? match[1].trim() : null;
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    const reason = status === 401 ? "Unauthorized" : "Not Found";
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  }

  // ── Connection handling ─────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let busy = false;
    ws.on("message", (data) => {
      // One in-flight `response.create` per socket at a time.
      if (busy) return;
      busy = true;
      const raw = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      void this.dispatch(ws, req, raw).finally(() => {
        busy = false;
      });
    });
  }

  /**
   * Run one `response.create` JSON frame through the exact POST `/v1/responses`
   * handler and stream the resulting SSE events back as WS text frames.
   */
  private async dispatch(ws: WebSocket, req: IncomingMessage, body: string): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !STRIPPED_HEADERS.has(key)) {
        headers[key.toLowerCase()] = value;
      }
    }

    let response: Response;
    try {
      response = await this.app.request("/v1/responses", {
        method: "POST",
        headers,
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorFrame(ws, message);
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const textBody = await response.text();
      this.sendErrorFrame(ws, textBody);
      return;
    }

    try {
      for await (const event of parseSSEStream(response)) {
        if (ws.readyState !== WS_OPEN) break;
        // Forward the JSON payload of each SSE `data:` line.
        ws.send(JSON.stringify(event.data));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorFrame(ws, message);
    }
  }

  /** Send an error as a JSON WS frame (best-effort; keeps the socket alive). */
  private sendErrorFrame(ws: WebSocket, rawMessage: string): void {
    let payload: unknown = rawMessage;
    try {
      payload = JSON.parse(rawMessage) as unknown;
    } catch {
      /* keep raw string */
    }
    const text =
      typeof payload === "string"
        ? JSON.stringify({
            type: "error",
            error: {
              type: "server_error",
              code: "proxy_error",
              message: payload,
            },
          })
        : JSON.stringify(payload);
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(text);
      } catch {
        /* socket already closed */
      }
    }
  }
}