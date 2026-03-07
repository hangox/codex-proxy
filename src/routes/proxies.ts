/**
 * Proxy pool management API routes.
 *
 * GET    /api/proxies              — list all proxies + assignments
 * POST   /api/proxies              — add proxy { name, url }
 * PUT    /api/proxies/:id          — update proxy { name?, url? }
 * DELETE /api/proxies/:id          — remove proxy
 * POST   /api/proxies/:id/check    — health check single proxy
 * POST   /api/proxies/:id/enable   — enable proxy
 * POST   /api/proxies/:id/disable  — disable proxy
 * POST   /api/proxies/check-all    — health check all proxies
 * POST   /api/proxies/assign       — assign proxy to account { accountId, proxyId }
 * DELETE /api/proxies/assign/:accountId — unassign proxy from account
 * PUT    /api/proxies/settings     — update settings { healthCheckIntervalMinutes }
 */

import { Hono } from "hono";
import type { ProxyPool } from "../proxy/proxy-pool.js";

export function createProxyRoutes(proxyPool: ProxyPool): Hono {
  const app = new Hono();

  // List all proxies + assignments (credentials masked)
  app.get("/api/proxies", (c) => {
    return c.json({
      proxies: proxyPool.getAllMasked(),
      assignments: proxyPool.getAllAssignments(),
      healthCheckIntervalMinutes: proxyPool.getHealthIntervalMinutes(),
    });
  });

  // Add proxy — accepts { name, url } OR { name, protocol, host, port, username?, password? }
  app.post("/api/proxies", async (c) => {
    const body = await c.req.json<{
      name?: string;
      url?: string;
      protocol?: string;
      host?: string;
      port?: string | number;
      username?: string;
      password?: string;
    }>();

    let url = body.url?.trim();

    // Compose URL from separate fields if raw url not provided
    if (!url && body.host) {
      url = composeProxyUrl(body.protocol, body.host, body.port, body.username, body.password);
    }

    if (!url) {
      c.status(400);
      return c.json({ error: "url or host is required" });
    }

    // URL validation + scheme check
    try {
      const parsed = new URL(url);
      const allowed = ["http:", "https:", "socks5:", "socks5h:"];
      if (!allowed.includes(parsed.protocol)) {
        c.status(400);
        return c.json({ error: `Unsupported protocol "${parsed.protocol}". Use http, https, socks5, or socks5h.` });
      }
    } catch {
      c.status(400);
      return c.json({ error: "Invalid proxy URL format" });
    }

    const name = body.name?.trim() || url;
    const id = proxyPool.add(name, url);
    const proxy = proxyPool.getById(id);

    // Restart health check timer if this is the first proxy
    proxyPool.startHealthCheckTimer();

    return c.json({ success: true, proxy });
  });

  // Update proxy
  app.put("/api/proxies/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ name?: string; url?: string }>();

    if (!proxyPool.update(id, body)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }

    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Remove proxy
  app.delete("/api/proxies/:id", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.remove(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true });
  });

  // Health check single proxy
  app.post("/api/proxies/:id/check", async (c) => {
    const id = c.req.param("id");
    try {
      const health = await proxyPool.healthCheck(id);
      const proxy = proxyPool.getById(id);
      return c.json({ success: true, proxy, health });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      c.status(404);
      return c.json({ error: msg });
    }
  });

  // Enable proxy
  app.post("/api/proxies/:id/enable", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.enable(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Disable proxy
  app.post("/api/proxies/:id/disable", (c) => {
    const id = c.req.param("id");
    if (!proxyPool.disable(id)) {
      c.status(404);
      return c.json({ error: "Proxy not found" });
    }
    return c.json({ success: true, proxy: proxyPool.getById(id) });
  });

  // Health check all (no route conflict — different path structure from /:id/*)
  app.post("/api/proxies/check-all", async (c) => {
    await proxyPool.healthCheckAll();
    return c.json({
      success: true,
      proxies: proxyPool.getAllMasked(),
    });
  });

  // Assign proxy to account
  app.post("/api/proxies/assign", async (c) => {
    const body = await c.req.json<{ accountId?: string; proxyId?: string }>();
    const { accountId, proxyId } = body;

    if (!accountId || !proxyId) {
      c.status(400);
      return c.json({ error: "accountId and proxyId are required" });
    }

    // Validate proxyId is a known value
    const validSpecial = ["global", "direct", "auto"];
    if (!validSpecial.includes(proxyId) && !proxyPool.getById(proxyId)) {
      c.status(400);
      return c.json({ error: "Invalid proxyId. Use 'global', 'direct', 'auto', or a valid proxy ID." });
    }

    proxyPool.assign(accountId, proxyId);
    return c.json({
      success: true,
      assignment: { accountId, proxyId },
      displayName: proxyPool.getAssignmentDisplayName(accountId),
    });
  });

  // Unassign proxy from account
  app.delete("/api/proxies/assign/:accountId", (c) => {
    const accountId = c.req.param("accountId");
    proxyPool.unassign(accountId);
    return c.json({ success: true });
  });

  // Update settings
  app.put("/api/proxies/settings", async (c) => {
    const body = await c.req.json<{ healthCheckIntervalMinutes?: number }>();
    if (typeof body.healthCheckIntervalMinutes === "number") {
      proxyPool.setHealthIntervalMinutes(body.healthCheckIntervalMinutes);
    }
    return c.json({
      success: true,
      healthCheckIntervalMinutes: proxyPool.getHealthIntervalMinutes(),
    });
  });

  return app;
}

/** Compose a proxy URL from separate fields. */
function composeProxyUrl(
  protocol: string | undefined,
  host: string,
  port: string | number | undefined,
  username: string | undefined,
  password: string | undefined,
): string {
  const scheme = protocol || "http";
  const trimmedHost = host.trim();
  let auth = "";
  if (username) {
    auth = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(username)}@`;
  }
  const portSuffix = port ? `:${port}` : "";
  return `${scheme}://${auth}${trimmedHost}${portSuffix}`;
}
