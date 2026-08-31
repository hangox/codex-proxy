/**
 * FallbackUpstream — a single optional "upstream apikey" account.
 *
 * Unlike normal OAuth accounts, this is a plain baseUrl + API key pair that
 * routes through the Responses API wire. It is only used as a last-resort
 * fallback when every normal account is unavailable.
 *
 * Only one fallback upstream may be configured at a time.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { getDataDir } from "../paths.js";

/** Fixed wire for the fallback upstream — always the native Responses API. */
export const FALLBACK_UPSTREAM_WIRE = "responses" as const;

export interface FallbackUpstreamConfig {
  baseUrl: string;
  apiKey: string;
}

/** Public view returned to the dashboard (never exposes the full key). */
export interface FallbackUpstreamPublic {
  baseUrl: string;
  apiKeyMasked: string;
}

interface FallbackUpstreamFile {
  baseUrl: string;
  apiKey: string;
}

export interface FallbackUpstreamResult {
  ok: boolean;
  error?: string;
}

function getFallbackUpstreamFile(): string {
  return resolve(getDataDir(), "fallback-upstream.json");
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export class FallbackUpstreamStore {
  private config: FallbackUpstreamConfig | null = null;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getFallbackUpstreamFile();
    this.config = this.load();
  }

  private load(): FallbackUpstreamConfig | null {
    try {
      const file = this.filePath;
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, "utf-8");
      const data = JSON.parse(raw) as FallbackUpstreamFile;
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.baseUrl !== "string" ||
        typeof data.apiKey !== "string" ||
        !data.baseUrl.trim() ||
        !data.apiKey.trim()
      ) {
        return null;
      }
      return { baseUrl: data.baseUrl.trim(), apiKey: data.apiKey };
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      const file = this.filePath;
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: FallbackUpstreamFile = {
        baseUrl: this.config!.baseUrl,
        apiKey: this.config!.apiKey,
      };
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmp, file);
    } catch (err) {
      console.error(
        "[FallbackUpstream] Failed to persist:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  get(): FallbackUpstreamConfig | null {
    return this.config;
  }

  getPublic(): FallbackUpstreamPublic | null {
    if (!this.config) return null;
    return { baseUrl: this.config.baseUrl, apiKeyMasked: maskKey(this.config.apiKey) };
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  /** Create. Fails when one is already configured (only one allowed). */
  set(baseUrl: string, apiKey: string): FallbackUpstreamResult {
    if (this.config) {
      return { ok: false, error: "A fallback upstream is already configured. Only one is allowed." };
    }
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedBaseUrl) return { ok: false, error: "baseUrl is required" };
    if (!trimmedKey) return { ok: false, error: "apiKey is required" };
    this.config = { baseUrl: trimmedBaseUrl, apiKey: trimmedKey };
    this.persist();
    return { ok: true };
  }

  /** Update. Empty apiKey keeps the existing key (edit without re-entering). */
  update(baseUrl: string, apiKey: string): FallbackUpstreamResult {
    if (!this.config) {
      return { ok: false, error: "Fallback upstream is not configured" };
    }
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) return { ok: false, error: "baseUrl is required" };
    this.config = {
      baseUrl: trimmedBaseUrl,
      apiKey: apiKey.trim() ? apiKey.trim() : this.config.apiKey,
    };
    this.persist();
    return { ok: true };
  }

  clear(): void {
    this.config = null;
    try {
      if (existsSync(this.filePath)) renameSync(this.filePath, this.filePath + ".bak");
    } catch (err) {
      console.warn(
        "[FallbackUpstream] Failed to remove persisted file:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
