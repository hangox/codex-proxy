/**
 * Unit tests for the single last-resort fallback upstream store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FallbackUpstreamStore } from "../../../src/auth/fallback-upstream.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fallback-upstream-test-"));
  file = join(dir, "fallback-upstream.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FallbackUpstreamStore", () => {
  it("starts unconfigured", () => {
    const store = new FallbackUpstreamStore(file);
    expect(store.get()).toBeNull();
    expect(store.isConfigured()).toBe(false);
    expect(store.getPublic()).toBeNull();
  });

  it("set() persists to disk and is reloadable", () => {
    const store = new FallbackUpstreamStore(file);
    const result = store.set("https://api.example.com/v1", "sk-test-123456");
    expect(result.ok).toBe(true);
    expect(store.isConfigured()).toBe(true);
    expect(store.get()).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test-123456" });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-123456",
    });

    // A fresh store reads the persisted config
    const reloaded = new FallbackUpstreamStore(file);
    expect(reloaded.get()).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test-123456" });
  });

  it("allows only one fallback upstream", () => {
    const store = new FallbackUpstreamStore(file);
    expect(store.set("https://a.example.com/v1", "key-a").ok).toBe(true);
    const second = store.set("https://b.example.com/v1", "key-b");
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already configured/i);
    // Original config unchanged
    expect(store.get()).toEqual({ baseUrl: "https://a.example.com/v1", apiKey: "key-a" });
  });

  it("rejects missing baseUrl or apiKey", () => {
    const store = new FallbackUpstreamStore(file);
    expect(store.set("", "key").ok).toBe(false);
    expect(store.set("https://a.example.com", "").ok).toBe(false);
    expect(store.isConfigured()).toBe(false);
  });

  it("update() changes baseUrl and keeps key when apiKey is blank", () => {
    const store = new FallbackUpstreamStore(file);
    store.set("https://a.example.com/v1", "sk-secret-1234");
    expect(store.update("https://b.example.com/v1", "").ok).toBe(true);
    expect(store.get()).toEqual({ baseUrl: "https://b.example.com/v1", apiKey: "sk-secret-1234" });
    expect(store.update("https://c.example.com/v1", "sk-new-5678").ok).toBe(true);
    expect(store.get()).toEqual({ baseUrl: "https://c.example.com/v1", apiKey: "sk-new-5678" });
  });

  it("update() on an unconfigured store fails", () => {
    const store = new FallbackUpstreamStore(file);
    expect(store.update("https://a.example.com/v1", "key").ok).toBe(false);
  });

  it("clear() removes the config and the persisted file", () => {
    const store = new FallbackUpstreamStore(file);
    store.set("https://a.example.com/v1", "sk-secret-1234");
    store.clear();
    expect(store.get()).toBeNull();
    expect(store.isConfigured()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("getPublic() masks the api key", () => {
    const store = new FallbackUpstreamStore(file);
    store.set("https://a.example.com/v1", "sk-abcdefghijklmnop");
    const pub = store.getPublic();
    expect(pub).toEqual({ baseUrl: "https://a.example.com/v1", apiKeyMasked: "sk-a****mnop" });
    expect(pub!.apiKeyMasked).not.toContain("abcdefghijkl");
  });

  it("treats an unparseable persisted file as unconfigured", () => {
    const { writeFileSync } = require("fs") as typeof import("fs");
    writeFileSync(file, "{ not json", "utf-8");
    const store = new FallbackUpstreamStore(file);
    expect(store.get()).toBeNull();
  });

  it("ignores stale .bak files", () => {
    const { writeFileSync } = require("fs") as typeof import("fs");
    const store = new FallbackUpstreamStore(file);
    store.set("https://a.example.com/v1", "sk-secret-1234");
    store.clear();
    // clear() renamed the file to .bak; a new store must not load it
    const fresh = new FallbackUpstreamStore(file);
    expect(fresh.get()).toBeNull();
  });
});
