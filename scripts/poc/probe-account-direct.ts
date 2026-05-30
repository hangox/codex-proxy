/**
 * 用任意账号 token 直连 chatgpt.com 上游（绕过 47lab 代理），
 * 看 gpt-5.5 / gpt-5.4 / gpt-5.4-mini 是否真的 empty response。
 *
 * 使用：
 *   PROBE_TOKEN="eyJ..." npx tsx scripts/poc/probe-account-direct.ts gpt-5.5
 */

import { loadConfig, loadFingerprint, getConfig } from "../../src/config.js";
import { initTransport, getTransport } from "../../src/tls/transport.js";
import { buildHeadersWithContentType } from "../../src/fingerprint/manager.js";

async function probe(model: string): Promise<void> {
  const transport = getTransport();
  const cfg = getConfig();
  const baseUrl = cfg.api.base_url;
  const token = process.env.PROBE_TOKEN;
  if (!token) throw new Error("Set PROBE_TOKEN env");

  const headers = buildHeadersWithContentType(token, null);
  headers["Accept"] = "text/event-stream";
  headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
  headers["x-openai-internal-codex-residency"] = "us";
  headers["x-client-request-id"] = crypto.randomUUID();
  headers["x-codex-installation-id"] = crypto.randomUUID();

  const body = JSON.stringify({
    model,
    instructions: "Reply 'ok'.",
    input: [{ role: "user", content: "Say ok." }],
    stream: true,
    store: false,
    reasoning: { effort: "low" },
  });

  console.log(`\n=== probe model=${model} via direct upstream ===`);

  const ac = new AbortController();
  const url = `${baseUrl}/codex/responses`;
  let res;
  try {
    res = await transport.post(url, headers, body, ac.signal, undefined, null);
  } catch (err) {
    console.log("transport.post threw:", err instanceof Error ? err.message : err);
    return;
  }

  console.log(`status: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const terminalRe = /^event:\s*(response\.(completed|failed|error|incomplete))/m;
  const startedAt = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    collected += decoder.decode(value, { stream: true });
    if (terminalRe.test(collected)) {
      reader.cancel().catch(() => {});
      break;
    }
    if (Date.now() - startedAt > 30_000) {
      reader.cancel().catch(() => {});
      break;
    }
    if (collected.length > 64 * 1024) {
      reader.cancel().catch(() => {});
      break;
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(`elapsed: ${elapsed}ms, total bytes: ${collected.length}`);

  if (collected.length === 0) {
    console.log("⚠️  EMPTY RESPONSE — 上游对该账号 silent block 或网络层异常");
    return;
  }

  // Print event types in order
  const events: string[] = [];
  for (const line of collected.split("\n")) {
    if (line.startsWith("event: ")) events.push(line.slice(7));
  }
  console.log(`events: ${events.join(" → ")}`);

  // Print terminal block(s)
  const blocks = collected.split(/\n\n/);
  const terminal = blocks.filter((b) =>
    /response\.(failed|error|incomplete|completed)/.test(b),
  );
  for (const t of terminal) console.log(t.slice(0, 800));
}

async function main() {
  loadConfig();
  loadFingerprint();
  await initTransport();
  const model = process.argv[2] ?? "gpt-5.5";
  await probe(model);
}

main().catch((err) => {
  console.error("[probe-direct] failed:", err);
  process.exitCode = 1;
});
