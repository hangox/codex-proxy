/**
 * Opaque compact 日志隐私合同 —— 全路径 canary 扫描。
 *
 * 为什么单独一个文件：此前只扫描 `[ClaudeOpaqueCompact]` 自己的日志，
 * 结果漏掉了三条真实泄漏路径——
 *   - `proxy-request-diagnostics.logOpaqueStateDiagnostics()`
 *   - `codex-compact-service.executeCompactOnly()` 的 start/end/retry
 *   - `proxy-error-handler.handleCodexApiError()` 的每个错误分支（safeLog
 *     此前只隐藏 err.message，entryId/email 照旧输出）
 *
 * opaque hard-bound 请求还会流经通用 proxy 链路（usage/ws/重试/错误日志），
 * 所以这里对**所有**相关 logger 逐个断言，而不是只测 bridge。
 */

import { describe, expect, it } from "vitest";
import { auditAccountTag, formatAccount } from "@src/routes/shared/opaque-compact-audit.js";
import { logOpaqueStateDiagnostics } from "@src/routes/shared/proxy-request-diagnostics.js";

const ENTRY_ID = "entry-account-canary-9f31";
const EMAIL = "victim@example.com";

describe("审计标签", () => {
  it("不可逆、同进程内稳定、且不泄漏原值", () => {
    const tag = auditAccountTag(ENTRY_ID);
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    // 同进程内可关联（运维要能判断"是不是同一个账号"）。
    expect(auditAccountTag(ENTRY_ID)).toBe(tag);
    // 不同账号不同标签。
    expect(auditAccountTag("entry-other")).not.toBe(tag);
    // 8 个十六进制字符也不足以承载原值。
    expect(tag).not.toContain(ENTRY_ID);
    expect(ENTRY_ID).not.toContain(tag);
  });

  it("sensitive 时只输出标签，非 sensitive 保留原有可读格式", () => {
    const sensitive = formatAccount(ENTRY_ID, true, EMAIL);
    expect(sensitive).toBe(`acct=${auditAccountTag(ENTRY_ID)}`);
    expect(sensitive).not.toContain(ENTRY_ID);
    expect(sensitive).not.toContain(EMAIL);

    // 普通路径不受影响：运维排障仍然看得到账号。
    expect(formatAccount(ENTRY_ID, false, EMAIL)).toBe(`Account ${ENTRY_ID} (${EMAIL})`);
    expect(formatAccount(ENTRY_ID, undefined)).toBe(`Account ${ENTRY_ID}`);
  });
});

describe("opaque restore 诊断日志", () => {
  it("不包含明文 entryId", () => {
    const lines: string[] = [];
    const diagnostics = logOpaqueStateDiagnostics({
      tag: "Messages",
      entryId: ENTRY_ID,
      requestId: "abcdef1234567890",
      log: (line: string) => lines.push(line),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(ENTRY_ID);
    expect(diagnostics.summary).not.toContain(ENTRY_ID);
    expect(lines[0]).toContain(auditAccountTag(ENTRY_ID));
  });
});

describe("redactJson — 值级第二道防线", () => {
  it("完整 marker 的三段（stateId/compHash/signature）全部零命中", async () => {
    const { redactJson } = await import("@src/logs/redact.js");
    // 必须用**真实长度**的 canary：早期用 4 字符占位时，正则只遮住第一段
    // 也能让断言通过，属于假阴性。真实 marker 是 32/43/43。
    const stateId = "A".repeat(32);
    const compHash = "B".repeat(43);
    const signature = "C".repeat(43);
    const token = `codex-opaque-state:v1:${stateId}:${compHash}:${signature}`;
    const wrapped =
      "<analysis>Opaque compact state retained locally.</analysis>\n" +
      `<summary>${token}</summary>`;

    const cases = [
      redactJson(token),
      redactJson(wrapped),
      redactJson({ messages: [{ role: "assistant", content: wrapped }] }),
      redactJson({ note: `prefix ${token} suffix` }),
      redactJson({ two: `${token} and ${token}` }),
      // 截断/畸形前缀同样不得残留可关联片段。
      redactJson({ truncated: `codex-opaque-state:v1:${stateId}` }),
    ];
    for (const value of cases) {
      const text = JSON.stringify(value);
      expect(text).not.toContain(stateId);
      expect(text).not.toContain(compHash);
      expect(text).not.toContain(signature);
    }
  });

  it("encrypted_content / preservedTail 按 key 名整体脱敏", async () => {
    const { redactJson } = await import("@src/logs/redact.js");
    const redacted = redactJson({
      output: [{ type: "reasoning", encrypted_content: "opaque-secret-canary" }],
      preservedTail: [{ type: "function_call_output", output: "tool-secret-canary" }],
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("opaque-secret-canary");
    expect(text).not.toContain("tool-secret-canary");
  });
});

describe("源码级合同 — 相关模块不得出现明文账号模板", () => {
  it.each([
    "opaque-compact-bridge.ts",
    "opaque-compact-runtime.ts",
    "proxy-request-diagnostics.ts",
    "codex-compact-service.ts",
    "proxy-usage-log.ts",
    "proxy-ws-context.ts",
    "non-streaming-codex-api-error.ts",
    "non-streaming-empty-response-exhausted.ts",
    "non-streaming-premature-close.ts",
    "proxy-retry-recovery.ts",
    "non-streaming-empty-response-retry.ts",
  ])("%s 不含 entry=${entryId} / Account ${entryId} 模板", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../src/routes/shared", file),
      "utf-8",
    );
    // 这些模板会把明文账号直接写进日志。允许的写法是 formatAccount/auditAccountTag。
    expect(source).not.toMatch(/entry=\$\{entryId\}/);
    expect(source).not.toMatch(/entry=\$\{lease\.entryId\}/);
    expect(source).not.toMatch(/Account \$\{entryId\}/);
    // 空响应重试用的是 currentEntryId，此前漏在扫描之外。
    expect(source).not.toMatch(/Account \$\{currentEntryId\}/);
  });

  it("proxy-error-handler 的 safeLog 分支不输出 entryId/email", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../src/routes/shared/proxy-error-handler.ts"),
      "utf-8",
    );
    // 账号呈现必须经由 safeLog 三元收敛到一处，而不是散落在每个分支。
    expect(source).toContain("auditAccountTag(entryId)");
    expect(source).not.toMatch(/\[\$\{tag\}\] Account \$\{entryId\}/);
    // 持久化错误日志的 context 同样不能带明文账号。
    expect(source).toMatch(/safeLog\s*\n?\s*\?\s*\{\s*acct:/);
  });

  it("runtime 就绪日志不输出 durable keyId", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../src/routes/shared/opaque-compact-runtime.ts"),
      "utf-8",
    );
    // keyId 跨进程稳定，可用于长期关联轮换/备份，不属于允许记录的结构量。
    expect(source).not.toMatch(/key=\$\{keyring\.activeKeyId\}/);
  });
});
