import type { Context, Next } from "hono";
import { enqueueLogEntry } from "../logs/entry.js";

export async function logCapture(c: Context, next: Next): Promise<void> {
  const startMs = Date.now();
  await next();
  enqueueLogEntry({
    requestId: c.get("requestId") ?? "-",
    direction: "ingress",
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latencyMs: Date.now() - startMs,
  });
}
