/**
 * Shared E2E test setup — declares all vi.mock() calls for the external boundary.
 *
 * Usage: import this file BEFORE any @src/ imports in your e2e test.
 *
 *   import { ... } from "@helpers/e2e-setup.js";
 *   // then import @src/ modules
 *
 * Mocked modules (external boundary):
 *   - @src/tls/transport.js — controllable transport via setTransportPost()
 *   - @src/tls/curl-binary.js — no-op
 *   - @src/config.js — returns createMockConfig()/createMockFingerprint()
 *   - @src/paths.js — returns /tmp/codex-e2e/ paths
 *   - fs — intercepts readFileSync for models.yaml, desktop-context.md, index.html;
 *          models.yaml content is loaded from tests/_fixtures/models.yaml via importOriginal
 *   - @src/update-checker.js, @src/self-update.js, @src/models/model-fetcher.js — no-op
 *   - @hono/node-server/serve-static — passthrough middleware
 *
 * Real modules (run unmodified):
 *   AccountPool, CookieJar, ProxyPool, CodexApi, withRetry,
 *   all translation layers, all middleware, all routes, fingerprint manager, model store
 */

import { vi } from "vitest";
import { resolve } from "path";
import type { TlsTransportResponse, TlsTransport } from "@src/tls/transport.js";
import { createMockConfig, createMockFingerprint } from "@helpers/config.js";

const mockConfig = createMockConfig();
const mockFingerprint = createMockFingerprint();

// ── Transport mock ───────────────────────────────────────────────────

export type TransportPostFn = (
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
  timeoutSec?: number,
  proxyUrl?: string | null,
) => Promise<TlsTransportResponse>;

let _transportPost: TransportPostFn;
let _lastTransportBody: string | null = null;

/** Override the transport.post behavior for the current test. */
export function setTransportPost(fn: TransportPostFn): void {
  _transportPost = fn;
}

/** Get the last request body sent to transport.post (or null). */
export function getLastTransportBody(): string | null {
  return _lastTransportBody;
}

/** Reset transport capture state. Call in beforeEach. */
export function resetTransportState(): void {
  _lastTransportBody = null;
  mockConfig.model.claude_code_opaque_compact_experimental = false;
  mockConfig.model.compact_protocol = "auto";
  mockConfig.model.system_prompt_strategy = "instructions";
}

/**
 * 切换 system prompt 注入策略。inline 两种模式下用户 system prompt 不在顶层
 * instructions 里，而是被 unshift 成 input 最前面的 developer/system item——
 * opaque 恢复路径能不能保住它，只有在这两种模式下才验得出来。
 */
export function setSystemPromptStrategy(
  strategy: "instructions" | "developer_inline" | "system_inline",
): void {
  mockConfig.model.system_prompt_strategy = strategy;
}

/**
 * 切换 compact 协议开关（`auto` = 纯 v2 无回落，`v1` = 直接走 legacy 端点）。
 * 记得在 resetTransportState 里会被重置回 auto。
 */
export function setCompactProtocol(protocol: "auto" | "v1" | "v2"): void {
  mockConfig.model.compact_protocol = protocol;
}

/** Toggle the experimental opaque compact state bridge for route-level E2E tests. */
export function setClaudeCodeOpaqueCompactExperimental(enabled: boolean): void {
  mockConfig.model.claude_code_opaque_compact_experimental = enabled;
}

const mockTransport: TlsTransport = {
  post: vi.fn((...args: Parameters<TlsTransport["post"]>) => {
    _lastTransportBody = args[2];
    return _transportPost(args[0], args[1], args[2], args[3], args[4], args[5]);
  }),
  get: vi.fn(async () => ({ status: 200, body: "{}" })),
  simplePost: vi.fn(async () => ({ status: 200, body: "{}" })),
  isImpersonate: () => false,
};

/** Get the mock transport instance (for mockClear etc.). */
export function getMockTransport(): TlsTransport {
  return mockTransport;
}

// ── Transport response builders ──────────────────────────────────────

/** Build a TlsTransportResponse wrapping SSE text. */
export function makeTransportResponse(sseText: string, status = 200): TlsTransportResponse {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

/** Build a TlsTransportResponse for error cases (JSON body). */
export function makeErrorTransportResponse(status: number, body: string): TlsTransportResponse {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

// ── Remote compaction v2 fixtures ────────────────────────────────────
//
// Production speaks Responses compaction v2: the compact request is an ordinary
// streaming POST to /codex/responses whose LAST input item is the sentinel
// `{"type":"compaction_trigger"}`, and the reply is SSE carrying a single
// `compaction` output item plus `response.completed` with usage.
//
// These helpers describe exactly that wire shape so E2E fixtures stay readable
// WITHOUT rewriting what production actually sent. Never translate a v2 request
// back into the legacy /responses/compact JSON call — that makes E2E assert a
// protocol production no longer speaks, and silently voids all v2 coverage.

/**
 * True when `request` is a real remote-compaction-v2 request, i.e. the final
 * `input` item is the `compaction_trigger` sentinel. This is the v2 replacement
 * for the old `url.endsWith("/codex/responses/compact")` check — v2 compacts go
 * to the ordinary /codex/responses endpoint, so the URL no longer distinguishes
 * them; the trailing sentinel is what does.
 *
 * Accepts either the raw request body string (inside a transport fixture) or an
 * already-parsed body object (in assertions over a captured `bodies` array), so
 * there is exactly one definition of "this was a compact request".
 */
export function isCompactV2Request(request: string | unknown): boolean {
  let parsed: unknown = request;
  if (typeof request === "string") {
    try {
      parsed = JSON.parse(request);
    } catch {
      return false;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const input = (parsed as Record<string, unknown>).input;
  if (!Array.isArray(input)) return false;
  const last: unknown = input.at(-1);
  return typeof last === "object"
    && last !== null
    && (last as Record<string, unknown>).type === "compaction_trigger";
}

/** True when `item` is the opaque `compaction` item upstream returns under v2. */
export function isCompactionItem(item: unknown): boolean {
  return typeof item === "object"
    && item !== null
    && (item as Record<string, unknown>).type === "compaction"
    && typeof (item as Record<string, unknown>).encrypted_content === "string";
}

/**
 * Assert the core v2 layout invariant on a restored request `input`, and return
 * the compaction item's index.
 *
 * `buildCompactV2Output` produces `[...保留的 user 消息, compaction]` —— compaction
 * 是**压缩产物段的最后一项**。恢复时该段前置于 preservedTail 和新一轮消息，
 * 所以在整个 replay input 里 compaction **不是**最后一项（最后一项是新消息），
 * 但它前面只允许出现 v2 客户端侧保留的 user 消息。
 *
 * 用 `toContainEqual` 这种「只要数组里有就行」的断言会把这条不变式整个放掉：
 * compaction 跑到哪个位置、前面混进了什么历史，都不会被发现。
 */
export function expectCompactionAtEndOfCompactOutput(input: unknown[]): number {
  const compactions = input.filter(isCompactionItem);
  if (compactions.length !== 1) {
    throw new Error(`expected exactly 1 compaction item, got ${compactions.length}`);
  }
  const index = input.findIndex(isCompactionItem);
  const before = input.slice(0, index);

  // ★ compaction 之前允许出现的东西有两类，顺序固定：
  //   [0, k)  本轮 inline 系统指令（developer/system）——`system_prompt_strategy`
  //           是 developer_inline / system_inline 时，恢复逻辑会把它们保留在
  //           最前（见 opaque-compact-state.ts 的 collectPrefixInstructionItems）。
  //   [k, i)  v2 客户端侧保留的 user 消息。
  //
  // 这段前缀**只在开头连续出现**才放行：一旦越过第一段非指令项，后面再出现
  // developer/system 就说明它混在历史中间，仍然是违规。对历史项的严格程度没变。
  //
  // 为什么要专门写这条：判据原来是「compaction 之前只能是 user」，那是 F11
  // 修复**之前**的形状。F11 修好之后，inline 模式下一个**完全正确**的恢复结果
  // 会被判成违规。今天不发作只是因为用到这个 helper 的用例跑在默认的
  // `instructions` 策略下（前缀里本来就没有指令项）——下一个人给 inline 补一条
  // 用例就会撞上「产品是对的、断言是错的」，而那种失败最危险的走向是有人顺手
  // 把断言放松回 toContainEqual，或者反过来怀疑 F11 的修复有问题。
  const isInlineInstructionItem = (item: unknown): boolean => {
    if (typeof item !== "object" || item === null) return false;
    const role = (item as Record<string, unknown>).role;
    return role === "developer" || role === "system";
  };

  let prefixEnd = 0;
  while (prefixEnd < before.length && isInlineInstructionItem(before[prefixEnd])) prefixEnd += 1;

  // 第二道、**独立锚定**的检查：真正要防的回归是「历史/preservedTail 混进了
  // 压缩产物段」。上面那条白名单（只允许 user）今天已经覆盖它，这里是刻意的
  // 冗余——白名单会随产品形状变（F11 就变过一次），而这条用的是「什么绝对
  // 不该出现在 compaction 之前」，不依赖「什么可以出现」。将来若有人为了让
  // 新形状通过而放松上面那条，这条仍然拦得住历史泄漏。
  const HISTORY_KINDS = ["function_call", "function_call_output"];
  const historyLeaks = before.filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Record<string, unknown>;
    return record.role === "assistant"
      || (typeof record.type === "string" && HISTORY_KINDS.includes(record.type));
  });
  if (historyLeaks.length > 0) {
    throw new Error(
      `压缩产物段被历史污染：compaction 之前出现了 ${historyLeaks.length} 个 `
      + `assistant/function_call/function_call_output 项——它们必须排在 compaction 之后。`
      + JSON.stringify(historyLeaks).slice(0, 300),
    );
  }

  const offenders = before.slice(prefixEnd).filter((item) => (
    typeof item !== "object" || item === null
    || (item as Record<string, unknown>).role !== "user"
  ));
  if (offenders.length > 0) {
    throw new Error(
      `compaction item must be the last item of the compact output segment `
      + `(允许的前缀：开头连续的 developer/system 内联指令，其后只能是保留的 user 消息)；`
      + `found ${offenders.length} offending item(s) before it: `
      + JSON.stringify(offenders).slice(0, 300),
    );
  }
  return index;
}

export interface CompactV2ResponseOptions {
  /** Opaque payload upstream returns inside the single `compaction` item. */
  encryptedContent?: string;
  /** Id of the `compaction` output item. */
  itemId?: string;
  /** Id reported on `response.completed`. */
  responseId?: string;
  /** Raw upstream `usage` object; pass `null` to omit usage entirely. */
  usage?: Record<string, unknown> | null;
  /**
   * Extra `response.output_item.done` items emitted BEFORE the compaction item.
   * Real upstream v2 only returns the compaction item; use this only to test how
   * production reacts to unexpected extra items.
   */
  extraDoneItems?: unknown[];
  /** Emit no `compaction` item at all (upstream contract violation). */
  omitCompactionItem?: boolean;
}

/**
 * Build the real v2 compact SSE reply: `response.output_item.done` carrying the
 * opaque `compaction` item, then `response.completed` carrying usage.
 */
export function makeCompactV2Response(options: CompactV2ResponseOptions = {}): TlsTransportResponse {
  const {
    encryptedContent = "opaque-e2e-compact",
    itemId = "cmp_e2e_v2",
    responseId = "resp_e2e_compact_v2",
    usage = { input_tokens: 10, output_tokens: 2 },
    extraDoneItems = [],
    omitCompactionItem = false,
  } = options;

  const doneItems: unknown[] = [...extraDoneItems];
  if (!omitCompactionItem) {
    doneItems.push({ id: itemId, type: "compaction", encrypted_content: encryptedContent });
  }

  const sse = doneItems
    .map((item) => `event: response.output_item.done\ndata: ${JSON.stringify({ item })}\n\n`)
    .join("")
    + `event: response.completed\ndata: ${JSON.stringify({
      response: { id: responseId, ...(usage === null ? {} : { usage }) },
    })}\n\n`;
  return makeTransportResponse(sse);
}

/**
 * Build a v2 compact SSE reply that terminates with an upstream `error` event
 * instead of `response.completed`.
 */
export function makeCompactV2ErrorResponse(
  error: { type?: string; code?: string; message: string },
  event: "error" | "response.failed" = "error",
): TlsTransportResponse {
  const payload = event === "response.failed" ? { response: { error } } : { error };
  return makeTransportResponse(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ── vi.mock declarations (hoisted by vitest) ─────────────────────────

vi.mock("@src/tls/transport.js", () => ({
  initTransport: vi.fn(async () => mockTransport),
  resetTransport: vi.fn(),
  getTransport: vi.fn(() => mockTransport),
}));

/**
 * 让当前测试用的替身在 WS 请求期间回放一批上游 rate limit 帧。
 *
 * 真实上游会在流里发 `codex.rate_limits`，`ws-transport` 把它变成
 * `onRateLimits(...)` 回调。此前这个 mock 的签名**只有 5 个参数、根本没有
 * onRateLimits 这一档**，于是「回调真的把配额写进账号池」这条缝在路由级完全
 * 测不出来——两端（透传、写入）各自有单测，中间没有。
 */
let _wsRateLimits: unknown[] = [];
export function setUpstreamRateLimits(frames: unknown[]): void {
  _wsRateLimits = frames;
}

vi.mock("@src/proxy/ws-transport.js", () => ({
  createWebSocketResponse: vi.fn(async (
    wsUrl: string,
    headers: Record<string, string>,
    request: unknown,
    signal?: AbortSignal,
    proxyUrl?: string | null,
    onRateLimits?: (rateLimits: unknown) => void,
  ) => {
    const body = JSON.stringify(request);
    _lastTransportBody = body;
    // 顺序刻意和真实传输一致：rate limit 帧先于响应体到达。
    for (const frame of _wsRateLimits) onRateLimits?.(frame);
    const result = await _transportPost(wsUrl, headers, body, signal, undefined, proxyUrl);
    if (result.status < 200 || result.status >= 300) {
      const errorBody = await new Response(result.body as BodyInit).text();
      const { CodexApiError } = await import("@src/proxy/codex-types.js");
      throw new CodexApiError(result.status, errorBody);
    }
    return new Response(result.body as BodyInit, {
      status: result.status,
      headers: result.headers,
    });
  }),
}));

vi.mock("@src/tls/curl-binary.js", () => ({
  initProxy: vi.fn(async () => {}),
  getCurlBinary: vi.fn(() => null),
  isImpersonate: vi.fn(() => false),
  supportsCompressed: vi.fn(() => true),
}));

vi.mock("@src/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
  loadFingerprint: vi.fn(() => mockFingerprint),
  getConfig: vi.fn(() => mockConfig),
  getFingerprint: vi.fn(() => mockFingerprint),
  mutateClientConfig: vi.fn(),
  reloadAllConfigs: vi.fn(),
  reloadConfig: vi.fn(() => mockConfig),
  reloadFingerprint: vi.fn(() => mockFingerprint),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/codex-e2e/config"),
  getDataDir: vi.fn(() => "/tmp/codex-e2e/data"),
  getBinDir: vi.fn(() => "/tmp/codex-e2e/bin"),
  getPublicDir: vi.fn(() => "/tmp/codex-e2e/public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/codex-e2e/public-desktop"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  // Read fixture with real fs before returning the mocked version
  const modelsYaml = actual.readFileSync(
    resolve(process.cwd(), "tests/_fixtures/models.yaml"),
    "utf-8",
  ) as string;

  return {
    ...actual,
    readFileSync: vi.fn((path: string, _enc?: string) => {
      if (typeof path === "string" && path.includes("models.yaml")) return modelsYaml;
      if (typeof path === "string" && path.includes("desktop-context.md")) return "";
      if (typeof path === "string" && path.includes("index.html")) return "<html>test</html>";
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }),
    existsSync: vi.fn((p: string) => typeof p === "string" && p.includes("models.yaml")),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("@src/update-checker.js", () => ({
  startUpdateChecker: vi.fn(),
  stopUpdateChecker: vi.fn(),
  getUpdateState: vi.fn(() => null),
  checkForUpdate: vi.fn(async () => ({
    update_available: false, current_version: "test", latest_version: null,
  })),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/self-update.js", () => ({
  startProxyUpdateChecker: vi.fn(),
  stopProxyUpdateChecker: vi.fn(),
  getProxyInfo: vi.fn(() => ({ version: "test", commit: "abc" })),
  canSelfUpdate: vi.fn(() => false),
  getDeployMode: vi.fn(() => "git"),
  getCachedProxyUpdateResult: vi.fn(() => null),
  checkProxySelfUpdate: vi.fn(async () => ({
    commitsBehind: 0, commits: [], release: null, updateAvailable: false,
    mode: "git", currentCommit: "abc", latestCommit: "abc",
  })),
  applyProxySelfUpdate: vi.fn(async () => ({ started: false })),
  isProxyUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
  triggerImmediateRefresh: vi.fn(),
}));

vi.mock("@src/auth/usage-refresher.js", () => ({
  startQuotaRefresh: vi.fn(),
  stopQuotaRefresh: vi.fn(),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));
