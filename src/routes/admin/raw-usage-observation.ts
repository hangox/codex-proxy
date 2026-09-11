import { Hono } from "hono";
import {
  getRawUsageObservationSnapshot,
  readRawUsageObservationEvents,
  startRawUsageObservation,
  stopRawUsageObservation,
} from "../../proxy/raw-usage-observer.js";

/** 受 dashboardAuth 保护的临时 raw usage 观察控制面；默认关闭且最多 9 条。 */
export function createRawUsageObservationRoutes(): Hono {
  const app = new Hono();
  app.use("/admin/raw-usage-observation", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  app.get("/admin/raw-usage-observation", (c) => {
    const readback = readRawUsageObservationEvents();
    return c.json({
      ...getRawUsageObservationSnapshot(),
      ...readback,
    });
  });

  app.post("/admin/raw-usage-observation", async (c) => {
    const raw = await c.req.text();
    let body: unknown = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        c.status(400);
        return c.json({ error: "invalid_request", message: "request body must be valid JSON" });
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      c.status(400);
      return c.json({ error: "invalid_request", message: "request body must be an object" });
    }
    const options = body as Record<string, unknown>;
    const allowedKeys = new Set(["run_id", "ttl_seconds", "max_events"]);
    const unknownKey = Object.keys(options).find((key) => !allowedKeys.has(key));
    if (unknownKey) {
      c.status(400);
      return c.json({ error: "invalid_request", message: `unknown field: ${unknownKey}` });
    }
    const runId = options.run_id;
    const ttlRaw = options.ttl_seconds;
    const maxEventsRaw = options.max_events;
    const ttlSeconds = typeof ttlRaw === "number" ? ttlRaw : undefined;
    const maxEvents = typeof maxEventsRaw === "number" ? maxEventsRaw : undefined;
    if (runId !== undefined && (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId))) {
      c.status(400);
      return c.json({ error: "invalid_request", message: "run_id is invalid" });
    }
    if (ttlRaw !== undefined && (typeof ttlRaw !== "number" || !Number.isInteger(ttlRaw) || ttlRaw < 1 || ttlRaw > 1800)) {
      c.status(400);
      return c.json({ error: "invalid_request", message: "ttl_seconds must be an integer between 1 and 1800" });
    }
    if (maxEventsRaw !== undefined && (typeof maxEventsRaw !== "number" || maxEventsRaw !== 9)) {
      c.status(400);
      return c.json({ error: "invalid_request", message: "max_events must equal 9" });
    }
    try {
      const started = startRawUsageObservation({
        ...(runId !== undefined ? { runId } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        ...(maxEvents !== undefined ? { maxEvents } : {}),
      });
      const { runToken: dispatchToken, ...snapshot } = started;
      return c.json({ snapshot, dispatch_token: dispatchToken }, 201, { "Cache-Control": "no-store", Pragma: "no-cache" });
    } catch (error) {
      c.status(409);
      return c.json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/admin/raw-usage-observation", (c) => c.json(stopRawUsageObservation()));
  return app;
}
