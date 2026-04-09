/**
 * API key management routes.
 * CRUD + import/export + catalog for third-party provider API keys.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { ApiKeyPool } from "../auth/api-key-pool.js";
import { PROVIDER_CATALOG } from "../auth/api-key-catalog.js";
import type { ApiKeyProvider } from "../auth/api-key-catalog.js";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "custom"] as const;
const ModelsSchema = z.array(z.string().trim().min(1)).min(1).transform((models) => [...new Set(models)]);

const AddKeySchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  models: ModelsSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);

const FetchCustomModelsSchema = z.object({
  provider: z.literal("custom"),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
});

const BulkImportEntrySchema = z.object({
  provider: z.enum(VALID_PROVIDERS),
  models: ModelsSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  label: z.string().max(64).nullable().optional(),
}).refine(
  (d) => d.provider !== "custom" || Boolean(d.baseUrl),
  { message: "baseUrl is required for custom providers" },
);


function addEntries(pool: ApiKeyPool, input: z.infer<typeof AddKeySchema>) {
  const keys = input.models.map((model) => pool.add({
    provider: input.provider,
    model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    label: input.label,
  }));
  return {
    added: keys.length,
    failed: 0,
    keys,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeFetchedModels(payload: unknown): Array<{ id: string; displayName: string }> {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const models: Array<{ id: string; displayName: string }> = [];
  for (const item of payload.data) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const displayName = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : id;
    models.push({ id, displayName });
  }

  const deduped = new Map<string, { id: string; displayName: string }>();
  for (const model of models) deduped.set(model.id, model);
  return [...deduped.values()];
}

function importEntries(pool: ApiKeyPool, items: z.infer<typeof BulkImportSchema>["keys"]) {
  let added = 0;
  const errors: string[] = [];

  for (const item of items) {
    for (const model of item.models) {
      try {
        pool.add({
          provider: item.provider,
          model,
          apiKey: item.apiKey,
          baseUrl: item.baseUrl,
          label: item.label,
        });
        added++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { added, failed: errors.length, errors };
}

function maskExportModels<T extends { model?: string }>(items: T[]): Array<Omit<T, "model"> & { models: string[] }> {
  return items.map(({ model, ...rest }) => ({
    ...rest,
    models: model ? [model] : [],
  }));
}

const BulkImportSchema = z.object({
  keys: z.array(BulkImportEntrySchema).min(1),
});

const LabelSchema = z.object({ label: z.string().max(64).nullable() });
const StatusSchema = z.object({ status: z.enum(["active", "disabled"]) });
const BatchDeleteSchema = z.object({ ids: z.array(z.string()).min(1) });

function parseBody<T>(schema: z.ZodSchema<T>) {
  return async (body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: z.ZodError }> => {
    const result = schema.safeParse(body);
    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, data: result.data };
  };
}

export function createApiKeyRoutes(pool: ApiKeyPool): Hono {
  const app = new Hono();

  // ── Catalog (predefined models) ──────────────────────────────

  app.get("/auth/api-keys/catalog", (c) => {
    return c.json({ catalog: PROVIDER_CATALOG });
  });

  // ── List ──────────────────────────────────────────────────────

  app.get("/auth/api-keys", (c) => {
    return c.json({ keys: pool.exportAll(false) });
  });

  // ── Fetch custom provider models ───────────────────────────────

  app.post("/auth/api-keys/models", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(FetchCustomModelsSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }

    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);

    try {
      const upstream = await fetch(`${baseUrl}/models`, {
        headers: {
          "Authorization": `Bearer ${parsed.data.apiKey}`,
          "Accept": "application/json",
        },
      });

      if (!upstream.ok) {
        if (upstream.status === 401 || upstream.status === 403) {
          c.status(upstream.status);
          return c.json({ error: "Failed to fetch models: unauthorized" });
        }
        c.status(502);
        return c.json({ error: "Failed to fetch models from provider" });
      }

      const payload = await upstream.json().catch(() => null);
      const models = normalizeFetchedModels(payload);
      if (models.length === 0) {
        c.status(502);
        return c.json({ error: "Provider returned no models" });
      }

      return c.json({ models });
    } catch {
      c.status(502);
      return c.json({ error: "Failed to reach provider" });
    }
  });

  // ── Export (full keys for re-import) ──────────────────────────

  // ── Export (full keys for re-import) ──────────────────────────

  app.get("/auth/api-keys/export", (c) => {
    return c.json({ keys: maskExportModels(pool.exportForReimport()) });
  });

  // ── Import (bulk) ─────────────────────────────────────────────

  app.post("/auth/api-keys/import", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(BulkImportSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const result = importEntries(pool, parsed.data.keys);
    return c.json({ success: true, ...result });
  });

  // ── Add single ────────────────────────────────────────────────

  app.post("/auth/api-keys", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(AddKeySchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    const result = addEntries(pool, parsed.data);
    return c.json({
      success: true,
      added: result.added,
      failed: result.failed,
      keys: result.keys.map((entry) => ({ ...entry, apiKey: maskKey(entry.apiKey) })),
    });
  });

  // ── Batch delete ──────────────────────────────────────────────

  app.post("/auth/api-keys/batch-delete", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(BatchDeleteSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    let deleted = 0;
    for (const id of parsed.data.ids) {
      if (pool.remove(id)) deleted++;
    }
    return c.json({ success: true, deleted });
  });

  // ── Per-key routes ────────────────────────────────────────────

  app.delete("/auth/api-keys/:id", (c) => {
    if (!pool.remove(c.req.param("id"))) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/label", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(LabelSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setLabel(c.req.param("id"), parsed.data.label)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  app.patch("/auth/api-keys/:id/status", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { c.status(400); return c.json({ error: "Malformed JSON request body" }); }
    const parsed = await parseBody(StatusSchema)(body);
    if (!parsed.ok) { c.status(400); return c.json({ error: "Invalid request", details: parsed.error.issues }); }
    if (!pool.setStatus(c.req.param("id"), parsed.data.status)) { c.status(404); return c.json({ error: "API key not found" }); }
    return c.json({ success: true });
  });

  return app;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
