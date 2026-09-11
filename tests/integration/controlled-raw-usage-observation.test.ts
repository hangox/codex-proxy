import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockConfig, createMockFingerprint } from "@helpers/config.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

const ADMIN_KEY = "qa-admin-only-fixture-key";
const mockConfig = createMockConfig();
const mockFingerprint = createMockFingerprint();
const ioState: {
  dataDir: string;
  post: (url: string, headers: Record<string, string>, body: string, signal?: AbortSignal, timeoutSec?: number, proxyUrl?: string | null) => Promise<{
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
    setCookieHeaders: string[];
  }>;
} = {
  dataDir: join(tmpdir(), "codex-controlled-raw-usage-unset"),
  post: async () => { throw new Error("transport post not configured"); },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  getFingerprint: vi.fn(() => mockFingerprint),
  loadConfig: vi.fn(() => mockConfig),
  loadFingerprint: vi.fn(() => mockFingerprint),
  reloadConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(() => mockConfig),
  getLocalConfigPath: vi.fn(() => `${ioState.dataDir}/local.yaml`),
}));
vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => ioState.dataDir),
  getConfigDir: vi.fn(() => `${process.cwd()}/config`),
  getPublicDir: vi.fn(() => `${ioState.dataDir}/public`),
  getBinDir: vi.fn(() => `${ioState.dataDir}/bin`),
  getDefaultOpaqueCompactKeyringFile: vi.fn(() => `${ioState.dataDir}/opaque.key`),
  isEmbedded: vi.fn(() => false),
}));
vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: (...args: Parameters<typeof ioState.post>) => ioState.post(...args),
    get: vi.fn(async () => ({ status: 200, body: "{}" })),
    simplePost: vi.fn(async () => ({ status: 200, body: "{}" })),
    isImpersonate: vi.fn(() => false),
  })),
}));
vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
  buildHeadersWithContentType: vi.fn(() => ({ "Content-Type": "application/json" })),
}));
vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: vi.fn(async () => { throw new Error("WS disabled in this fixture"); }),
}));
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { requestId } from "@src/middleware/request-id.js";
import { dashboardAuth } from "@src/middleware/dashboard-auth.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";
import { createValidJwt } from "@helpers/jwt.js";
import { summarize as summarizePromptCache, type Config, type RequestRecord } from "../../scripts/experiments/prompt-cache-driver.ts";
import {
  getRawUsageObservationSink,
  getRawUsageObservationSnapshot,
  stopRawUsageObservation,
} from "@src/proxy/raw-usage-observer.js";

type FixtureMode = "success" | "empty" | "no-terminal" | "server-error" | "transport-error";

function fixtureResponse(mode: FixtureMode = "success"): {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  setCookieHeaders: string[];
} {
  if (mode === "server-error") {
    const bytes = new TextEncoder().encode(JSON.stringify({ error: { message: "fixture upstream 502" } }));
    return {
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      setCookieHeaders: [],
    };
  }
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_real_file_fixture" } })}\n\n`,
    ...(mode === "success" ? [`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "real file fixture answer" })}\n\n`] : []),
    ...(mode === "no-terminal" ? [] : [`event: response.completed\ndata: ${JSON.stringify({ response: {
      id: "resp_real_file_fixture",
      status: "completed",
      usage: { input_tokens: 1000, output_tokens: mode === "empty" ? 0 : 7, input_tokens_details: { cached_tokens: 800 } },
    } })}\n\n`]),
  ];
  const bytes = new TextEncoder().encode(events.join(""));
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    setCookieHeaders: [],
  };
}

function buildApp(): { app: Hono; accountPool: AccountPool; cookieJar: CookieJar; proxyPool: ProxyPool } {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  accountPool.addAccount(createValidJwt({ accountId: "real-file-fixture-account", email: "real-file@test.invalid", planType: "plus" }));
  const app = new Hono();
  app.use("*", requestId);
  app.use("*", dashboardAuth);
  app.onError(errorHandler);
  app.route("/", createMessagesRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createWebRoutes(accountPool, undefined as never));
  return { app, accountPool, cookieJar, proxyPool };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

function runDriver(baseUrl: string, evidencePath: string, outputPath: string, sessionId: string, runId: string, token: string, controlled = true, driverPath?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const repo = resolve(process.cwd());
  const args = [
    resolve(repo, "node_modules/tsx/dist/cli.mjs"),
    driverPath ?? resolve(repo, "scripts/experiments/prompt-cache-driver.ts"),
    "--run", ...(controlled ? ["--controlled-run"] : []), "--run-id", runId,
    "--base-url", baseUrl, "--format", "messages", "--model", "codex",
    "--prompt-cache-key", "qa-real-file-routing-key", "--session-id", sessionId,
    "--prefix-bytes", "64", "--tail-variants", "tail-a,tail-b", "--warmups", "0", "--measurements", "1", "--no-negative-control",
    ...(controlled ? ["--max-requests", "9", "--max-input-tokens", "22500", "--max-observed-input-tokens", "22500"] : ["--max-requests", "4", "--max-input-tokens", "10000"]),
    "--timeout-ms", "10000", "--delay-ms", "0",
    "--upstream-evidence-file", evidencePath, "--output", outputPath,
  ];
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: {
        ...process.env,
        NODE_PATH: resolve(repo, "node_modules"),
        PROXY_API_KEY: ADMIN_KEY,
        ...(controlled ? { CODEX_RAW_USAGE_OBSERVATION_TOKEN: token } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

async function mutateEvidence(sourcePath: string, targetPath: string, mutate: (row: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const rows = (await readFile(sourcePath, "utf8")).split("\n").filter(Boolean)
    .map((line) => mutate(JSON.parse(line) as Record<string, unknown>));
  await writeFile(targetPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function enableObserver(baseUrl: string, runId: string): Promise<{ filePath: string; token: string }> {
  const response = await fetch(`${baseUrl}/admin/raw-usage-observation`, {
    method: "POST",
    headers: {
      "x-forwarded-for": "198.51.100.7",
      Authorization: `Bearer ${ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ run_id: runId, ttl_seconds: 30 }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { snapshot: { filePath: string; runId: string }; dispatch_token: string };
  expect(body.snapshot).toMatchObject({ filePath: expect.any(String), runId });
  expect(body.dispatch_token).toMatch(/^[A-Za-z0-9-]{32,}$/);
  return { filePath: body.snapshot.filePath, token: body.dispatch_token };
}

async function postMessages(baseUrl: string, runId: string, token: string, stream: boolean): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "Content-Type": "application/json",
      "x-claude-code-session-id": "qa-controlled-failure-session",
      "x-request-id": `prompt-cache-${runId}-1`,
      "x-codex-raw-usage-token": token,
      "x-codex-raw-usage-run-id": runId,
    },
    body: JSON.stringify({
      model: "codex",
      max_tokens: 32,
      stream,
      messages: [{ role: "user", content: "controlled failure fixture" }],
    }),
  });
  return { status: response.status, body: await response.text() };
}

async function assertControlledFailure(mode: FixtureMode, stream: boolean, expectedStatus: number, expectedStopReason: "terminal_failure" | "dispatch_uncertain" = "terminal_failure"): Promise<void> {
  const runId = `qa-failure-${mode}-${stream ? "stream" : "nonstream"}-${Date.now()}`;
  const { filePath, token } = await enableObserver(baseUrl, runId);
  upstreamMode = mode;
  const acquireSpy = vi.spyOn(ctx.accountPool, "acquire");
  const result = await postMessages(baseUrl, runId, token, stream);
  expect(result.status).toBe(expectedStatus);
  expect(result.body).not.toContain("end_turn");
  expect(upstreamCallCount).toBe(1);
  expect(acquireSpy).toHaveBeenCalledTimes(1);
  expect(getRawUsageObservationSnapshot()).toMatchObject({ enabled: false, runId, stopReason: expectedStopReason });
  const jsonl = await readFile(filePath, "utf8");
  const rows = jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.every((row) => row.schema_version === 1 && row.run_id === runId && row.request_id_hash && row.attempt === 1)).toBe(true);

  // 使用真实 driver merge/summarize 读取同一 JSONL，但指向一个关闭的本地端口，
  // 避免第二次访问被测 upstream；失败成本与终态仍必须保留，headline 必须不可用。
  const driver = await runDriver(
    "http://127.0.0.1:1",
    filePath,
    join(tempDataDir, `${mode}-${stream ? "stream" : "nonstream"}-failure-driver.jsonl`),
    "qa-failure-cli-session",
    runId,
    token,
    false,
  );
  expect(driver.code).toBe(0);
  const driverJson = parseJsonLines(driver.stdout);
  const summary = driverJson.find((row) => row.type === "summary");
  const records = driverJson.filter((row) => row.type === "request");
  expect(summary).toMatchObject({ evidenceSufficient: false, rawCacheHitRate: null, knownOnlyCacheHitRate: null });
  expect(records).toHaveLength(2);
  expect(records.every((row) => row.ok === false)).toBe(true);
  if (rows.length > 0) {
    expect(Number(summary?.measuredRawInputTokens)).toBeGreaterThan(0);
    expect(records.some((row) => row.usage && row.usage.evidenceSource === "upstream")).toBe(true);
  }
}

let ctx: ReturnType<typeof buildApp>;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let tempDataDir: string;
let upstreamMode: FixtureMode = "success";
let upstreamCallCount = 0;

beforeEach(async () => {
  stopRawUsageObservation();
  tempDataDir = await mkdtemp(join(tmpdir(), "codex-controlled-raw-usage-"));
  ioState.dataDir = tempDataDir;
  await mkdir(join(ioState.dataDir, "raw-usage-observations"), { recursive: true });
  mockConfig.server.proxy_api_key = ADMIN_KEY;
  (mockConfig.server as { trust_proxy?: boolean }).trust_proxy = true;
  mockConfig.model.claude_code_opaque_compact_experimental = false;
  process.env.CODEX_PROXY_DISABLE_WS = "1";
  upstreamMode = "success";
  upstreamCallCount = 0;
  ctx = buildApp();
  ioState.post = async () => {
    upstreamCallCount++;
    if (upstreamMode === "transport-error") throw new Error("fixture transport failure");
    return fixtureResponse(upstreamMode);
  };
  server = serve({ fetch: ctx.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolveListening) => {
    if (server.listening) resolveListening(); else server.once("listening", () => resolveListening());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  stopRawUsageObservation();
  delete process.env.CODEX_PROXY_DISABLE_WS;
  try {
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  } finally {
    ctx.cookieJar.destroy();
    ctx.proxyPool.destroy();
    ctx.accountPool.destroy();
    await rm(tempDataDir, { recursive: true, force: true });
  }
});

describe("真实 observer JSONL → CLI 关联", () => {
  it("POST启用正式sink，CLI读取同一snake文件得到.8，并拒收坏schema/run", async () => {
    const runId = `qa-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = "qa-real-file-session";
    const remoteHeaders = { "x-forwarded-for": "198.51.100.7" };
    const unauthenticated = await fetch(`${baseUrl}/admin/raw-usage-observation`, {
      method: "POST",
      headers: { ...remoteHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, ttl_seconds: 30 }),
    });
    expect(unauthenticated.status).toBe(401);

    const enabled = await fetch(`${baseUrl}/admin/raw-usage-observation`, {
      method: "POST",
      headers: { ...remoteHeaders, Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, ttl_seconds: 30 }),
    });
    expect(enabled.status).toBe(201);
    const enabledBody = await enabled.json() as { snapshot: { filePath: string; runId: string; maxEvents: number; enabled: boolean }; dispatch_token: string };
    const snapshot = enabledBody.snapshot;
    const dispatchToken = enabledBody.dispatch_token;
    expect(snapshot).toMatchObject({ filePath: expect.any(String), runId, maxEvents: 9, enabled: true });
    expect(dispatchToken).toMatch(/^[A-Za-z0-9-]{32,}$/);
    expect(getRawUsageObservationSnapshot()).toMatchObject({ enabled: true, runId, maxEvents: 9 });
    expect(getRawUsageObservationSink()).toBeTypeOf("function");

    const positive = await runDriver(baseUrl, snapshot.filePath, join(tempDataDir, "positive-driver.jsonl"), sessionId, runId, dispatchToken);
    const positiveJson = parseJsonLines(positive.stdout);
    expect(positive.code).toBe(0);
    expect(positiveJson.find((row) => row.type === "summary")).toMatchObject({ evidenceSufficient: true, upstreamEvidenceCount: 6, rawCacheHitRate: 0.8 });
    const rows = (await readFile(snapshot.filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.schema_version === 1 && row.run_id === runId && row.request_id_hash && row.attempt === 1 && row.transport === "http" && row.response_id === "resp_real_file_fixture" && row.terminal_event === "response.completed")).toBe(true);
    expect(rows.every((row) => row.usage_present === true && row.input_tokens_present === true && row.output_tokens_present === true && row.cached_tokens_present === true && row.input_tokens === 1000 && row.cached_tokens === 800)).toBe(true);
    const readbackResponse = await fetch(`${baseUrl}/admin/raw-usage-observation`, { headers: { ...remoteHeaders, Authorization: `Bearer ${ADMIN_KEY}` } });
    expect(readbackResponse.status).toBe(200);
    const getBody = await readbackResponse.json() as { events: Record<string, unknown>[]; eventCount: number; runId: string };
    expect(getBody).toMatchObject({ runId, eventCount: 9 });
    expect(getBody.events).toHaveLength(9);

    const mutations: Array<[string, (row: Record<string, unknown>) => Record<string, unknown>, string]> = [
      ["version", (row) => ({ ...row, schema_version: 2 }), "schema_invalid"],
      ["unknown-key", (row) => ({ ...row, payload: "forbidden" }), "schema_invalid"],
      ["camel", (row) => { const next = { ...row, requestId: row.request_id_hash }; delete next.request_id_hash; return next; }, ""],
      ["presence", (row) => ({ ...row, cached_tokens_present: false }), "schema_invalid"],
      ["run", (row) => ({ ...row, run_id: "other-run" }), "run_id_mismatch"],
    ];
    for (const [name, mutate, reason] of mutations) {
      const evidencePath = join(tempDataDir, `${name}.jsonl`);
      await mutateEvidence(snapshot.filePath, evidencePath, mutate);
      const rerun = await runDriver(baseUrl, evidencePath, join(tempDataDir, `${name}-driver.jsonl`), sessionId, runId, dispatchToken, false);
      const json = parseJsonLines(rerun.stdout);
      const summary = json.find((row) => row.type === "summary");
      const records = json.filter((row) => row.type === "request");
      expect(rerun.code).toBe(0);
      expect(summary).toMatchObject({ evidenceSufficient: false, rawCacheHitRate: null });
      expect(records).toHaveLength(2);
      if (reason) expect(records.every((row) => String(row.upstreamEvidenceRejectReason).includes(reason))).toBe(true);
    }

    const deleted = await fetch(`${baseUrl}/admin/raw-usage-observation`, {
      method: "DELETE",
      headers: { ...remoteHeaders, Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json() as Record<string, unknown>;
    expect(deletedBody).toMatchObject({ enabled: false });
    expect(deletedBody).not.toHaveProperty("dispatch_token");
  }, 30_000);

  it("stops non-stream empty responses after one upstream attempt", async () => {
    await assertControlledFailure("empty", false, 502);
  }, 30_000);

  it("stops stream empty responses without retrying the account", async () => {
    await assertControlledFailure("empty", true, 200);
  }, 30_000);

  it("stops non-stream no-terminal responses after one upstream attempt", async () => {
    await assertControlledFailure("no-terminal", false, 502);
  }, 30_000);

  it("stops stream no-terminal responses without retrying the account", async () => {
    await assertControlledFailure("no-terminal", true, 200);
  }, 30_000);

  it("stops stream upstream 5xx before any fallback attempt", async () => {
    await assertControlledFailure("server-error", true, 200);
  }, 30_000);

  it("stops non-stream transport failure before any fallback attempt", async () => {
    await assertControlledFailure("transport-error", false, 502, "dispatch_uncertain");
  }, 30_000);

  it("turns red when the driver terminal-completed filter is removed", async () => {
    const runId = `qa-filter-mutation-${Date.now()}`;
    const { filePath, token } = await enableObserver(baseUrl, runId);
    upstreamMode = "success";
    const response = await postMessages(baseUrl, runId, token, false);
    expect(response.status).toBe(200);
    const rows = (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).not.toHaveLength(0);
    const row = rows[0];
    const record = {
      type: "request",
      index: 1,
      runId,
      scenario: "fixed-prefix",
      variant: "mutation",
      prefixHash: "fixture",
      prefixChars: 1,
      routingKeyHash: "fixture",
      sessionIdHash: "fixture",
      tailHash: "fixture",
      tailChars: 1,
      inputTokenLowerBound: 1,
      status: 200,
      ok: true,
      elapsedMs: 1,
      usage: {
        evidenceSource: "upstream",
        rawAvailable: true,
        rawInputTokens: Number(row.input_tokens),
        rawCachedTokens: Number(row.cached_tokens),
        rawCachedTokensPresent: true,
        rawUsageValid: true,
        clientAvailable: true,
        upstreamTerminalEvent: "response.incomplete",
      },
    } as RequestRecord;
    const config = {
      format: "messages",
      model: "codex",
      prefix: "fixture",
      prefixHash: "fixture",
      prefixChars: 7,
      prefixTokens: 1,
      maxInputTokens: 22_500,
      controlledRun: false,
    } as Config;
    const baselineSummary = summarizePromptCache(config, [record], 1_000, false, false);
    expect(baselineSummary).toMatchObject({ evidenceSufficient: false, knownOnlyCacheHitRate: null, rawCacheHitRate: null });

    const repo = resolve(process.cwd());
    const driverSourcePath = resolve(repo, "scripts/experiments/prompt-cache-driver.ts");
    const driverSource = await readFile(driverSourcePath, "utf8");
    const terminalFilter = "      && record.usage.upstreamTerminalEvent === \"response.completed\"\n";
    expect(driverSource).toContain(terminalFilter);
    const mutatedDriverPath = join(tempDataDir, "driver-terminal-filter-removed.ts");
    await writeFile(mutatedDriverPath, driverSource.replace(terminalFilter, ""), "utf8");
    const mutatedModule = await import(pathToFileURL(mutatedDriverPath).href);
    const mutatedSummary = mutatedModule.summarize(config, [record], 1_000, false, false) as { knownOnlyCacheHitRate: number | null };
    expect(mutatedSummary.knownOnlyCacheHitRate).toBeGreaterThan(0);
  }, 30_000);
});
