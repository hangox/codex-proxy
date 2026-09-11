import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRawUsageObservationRoutes } from "@src/routes/admin/raw-usage-observation.js";

let previousCwd: string;
let testRoot: string;

beforeEach(() => {
  previousCwd = process.cwd();
  testRoot = mkdtempSync(join(tmpdir(), "codex-raw-route-"));
  process.chdir(testRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
});

function app(): Hono {
  const root = new Hono();
  root.route("/", createRawUsageObservationRoutes());
  return root;
}

describe("raw usage observation admin contract", () => {
  it("rejects malformed JSON and typed/range/path invalid fields with 400", async () => {
    const malformed = await app().request("/admin/raw-usage-observation", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");
    expect((await app().request("/admin/raw-usage-observation", {
      method: "POST", body: JSON.stringify({ ttl_seconds: "60" }),
    })).status).toBe(400);
    expect((await app().request("/admin/raw-usage-observation", {
      method: "POST", body: JSON.stringify({ ttl_seconds: 0 }),
    })).status).toBe(400);
    expect((await app().request("/admin/raw-usage-observation", {
      method: "POST", body: JSON.stringify({ run_id: "../escape" }),
    })).status).toBe(400);
    expect((await app().request("/admin/raw-usage-observation", {
      method: "POST", body: JSON.stringify({ max_events: 8 }),
    })).status).toBe(400);
  });

  it("applies explicit values and reads back effective state before DELETE", async () => {
    const started = await app().request("/admin/raw-usage-observation", {
      method: "POST",
      body: JSON.stringify({ run_id: "route-test", ttl_seconds: 60, max_events: 9 }),
    });
    expect(started.status).toBe(201);
    expect(started.headers.get("Cache-Control")).toBe("no-store");
    const body = await started.json() as { snapshot: { runId: string; maxEvents: number; enabled: boolean }; dispatch_token: string };
    expect(body.snapshot).toMatchObject({ runId: "route-test", maxEvents: 9, enabled: true });
    expect(body.dispatch_token).toMatch(/^[A-Za-z0-9-]{32,}$/);

    const readback = await app().request("/admin/raw-usage-observation");
    expect(readback.status).toBe(200);
    expect(readback.headers.get("Cache-Control")).toBe("no-store");
    const readbackBody = await readback.json() as Record<string, unknown>;
    expect(readbackBody).toMatchObject({ runId: "route-test", maxEvents: 9, enabled: true, events: [], invalidEventCount: 0 });
    expect(readbackBody).not.toHaveProperty("runToken");

    const stopped = await app().request("/admin/raw-usage-observation", { method: "DELETE" });
    expect(stopped.status).toBe(200);
    expect(stopped.headers.get("Cache-Control")).toBe("no-store");
    expect(await stopped.json()).toMatchObject({ runId: "route-test", enabled: false, stopReason: "manual_delete" });
  });
});
