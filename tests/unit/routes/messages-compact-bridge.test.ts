import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicHistoryToLosslessCodexInput,
  buildClaudeCodeCompactRequest,
  buildClaudeCodeRenderRequest,
  extractClaudeCodeCompactPrompt,
} from "@src/routes/shared/codex-compact-service.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

const PREFIX = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
const INTRO = "Your summary should include the following sections:";
const SUFFIX = "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";
const SECTIONS = [
  "1. Primary Request and Intent:",
  "2. Key Technical Concepts:",
  "3. Files and Code Sections:",
  "4. Errors and fixes:",
  "5. Problem Solving:",
  "6. All user messages:",
  "7. Pending Tasks:",
] as const;
const STRUCTURE_SUMMARY = JSON.parse(readFileSync(
  resolve(process.cwd(), "tests/_fixtures/claude-code-compact-structure-summary.json"),
  "utf-8",
)) as {
  schemaVersion: 1;
  source: "local-capture-structure-only";
  variants: Record<"PH_" | "HH_" | "LH_", {
    version: string;
    promptLength: number;
    prefixMatches: boolean;
    suffixMatches: boolean;
    sectionIntroOffset: number;
    sectionOffsets: number[];
    sectionsOrdered: boolean;
    sectionKinds: string[];
    blockShape: {
      kind: "string" | "text_blocks";
      count: number;
      textBlockCount: number;
      nonEmptyTextBlockCount: number;
      promptBlockIndex: number;
    };
  }>;
};

function compactPrompt(options: {
  task?: string;
  additionalInstructions?: string;
  newline?: "\n" | "\r\n";
  omittedSections?: number[];
  sections?: readonly string[];
  includeIntro?: boolean;
} = {}): string {
  const newline = options.newline ?? "\n";
  const task = options.task ?? [
    "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
    "This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.",
    "Before providing your final summary, wrap your analysis in <analysis> tags and double-check for technical accuracy and completeness.",
  ].join("\n");
  const sourceSections = options.sections ?? SECTIONS;
  const sections = sourceSections.filter((_section, index) => !options.omittedSections?.includes(index + 1));
  const parts = [PREFIX, task];
  if (options.includeIntro !== false) parts.push(INTRO);
  parts.push(...sections);
  if (options.additionalInstructions) {
    parts.push("Additional Instructions:", options.additionalInstructions);
  }
  parts.push(SUFFIX);
  return parts.join(newline);
}

function request(content: AnthropicMessagesRequest["messages"][number]["content"]): AnthropicMessagesRequest {
  return {
    model: "gpt-5.5",
    max_tokens: 4096,
    messages: [{ role: "user", content }],
    stream: true,
  };
}

function translated(): CodexResponsesRequest {
  return {
    model: "gpt-5.5",
    instructions: "system",
    input: [{ role: "user", content: "old" }],
    stream: true,
    store: false,
    reasoning: { effort: "high", summary: "auto" },
    tools: [{ type: "function", name: "Read" }],
    service_tier: "fast",
    prompt_cache_key: "session-key",
    client_metadata: { custom: "metadata" },
    turnState: "turn-state",
    turnMetadata: "turn-metadata",
    betaFeatures: "beta-feature",
    version: "1.2.3",
    includeTimingMetrics: "true",
    codexWindowId: "window-id",
    parentThreadId: "parent-id",
    useWebSocket: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude Code compact bridge fingerprint", () => {
  it.each(["PH_", "HH_", "LH_"] as const)("keeps the public 2.1.219 %s structure summary", (variant) => {
    const summary = STRUCTURE_SUMMARY.variants[variant];
    expect(STRUCTURE_SUMMARY.schemaVersion).toBe(1);
    expect(STRUCTURE_SUMMARY.source).toBe("local-capture-structure-only");
    expect(summary.version).toBe("2.1.219");
    expect(summary.promptLength).toBeGreaterThanOrEqual(600);
    expect(summary.prefixMatches).toBe(true);
    expect(summary.suffixMatches).toBe(true);
    expect(summary.sectionIntroOffset).toBeGreaterThan(0);
    expect(summary.sectionOffsets).toHaveLength(9);
    expect(summary.sectionOffsets.every((offset, index) => (
      offset > (index === 0 ? summary.sectionIntroOffset : summary.sectionOffsets[index - 1]!)
    ))).toBe(true);
    expect(summary.sectionsOrdered).toBe(true);
    expect(summary.blockShape.kind).toBe("text_blocks");
    expect(summary.blockShape.textBlockCount).toBe(summary.blockShape.count);
    expect(summary.blockShape.promptBlockIndex).toBe(summary.blockShape.count - 1);
  });

  it("matches string, one text block, and the QA trailing compact block", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt(request(` \n${prompt}\n `))).toContain(PREFIX);
    expect(extractClaudeCodeCompactPrompt(request([{ type: "text", text: prompt }]))).toBe(prompt);
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "text", text: "复述两个测试标签\n" },
      { type: "text", text: prompt },
    ]))).toBe(prompt);
  });

  it("accepts custom instructions, CRLF, and NFC text", () => {
    const prompt = compactPrompt({
      additionalInstructions: "保留 Café 标签和精确路径。",
      newline: "\r\n",
    });
    expect(extractClaudeCodeCompactPrompt(request(prompt))).toBe(prompt);
  });

  it("requires all seven shared sections but permits a later quoted heading", () => {
    const missingSection = compactPrompt({ omittedSections: [7] });
    const repeatedInAdditionalInstructions = compactPrompt({
      additionalInstructions: `Preserve the wording ${SECTIONS[0]}`,
    });
    expect(extractClaudeCodeCompactPrompt(request(missingSection))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(repeatedInAdditionalInstructions))).toBe(
      repeatedInAdditionalInstructions,
    );
  });

  it("rejects missing intro, reversed or partially reordered sections, and a short skeleton", () => {
    const reversed = compactPrompt({ sections: [...SECTIONS].reverse() });
    const partialReorder = compactPrompt({
      sections: [SECTIONS[1], SECTIONS[0], ...SECTIONS.slice(2)],
    });
    const shortSkeleton = [PREFIX, INTRO, ...SECTIONS, SUFFIX].join("\n");
    expect(extractClaudeCodeCompactPrompt(request(compactPrompt({ includeIntro: false })))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(reversed))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(partialReorder))).toBeNull();
    expect(shortSkeleton.length).toBeLessThan(600);
    expect(extractClaudeCodeCompactPrompt(request(shortSkeleton))).toBeNull();
  });

  it("requires the complete case-sensitive shared suffix", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt(request(prompt.replace("REMINDER:", "Reminder:")))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(prompt.replace("plain text only —", "plain text only -")))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(prompt.replace("an <analysis> block", "an analysis block")))).toBeNull();
  });

  it("uses the last non-empty text block and permits trailing empty text blocks", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "text", text: "preceding user text" },
      { type: "text", text: prompt },
      { type: "text", text: " \n" },
    ]))).toBe(prompt);
  });

  it("accepts a strict trailing prompt alongside preserved non-text blocks", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "text", text: prompt },
    ]))).toBe(prompt);
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "text", text: prompt },
      { type: "tool_result", tool_use_id: "tool-1", content: "preserved result" },
    ]))).toBe(prompt);
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "tool_result", tool_use_id: "tool-1", content: "preserved result" },
      { type: "text", text: prompt },
    ]))).toBe(prompt);
  });

  it("rejects trailing ordinary text and ambiguous strict prompt candidates", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "text", text: prompt },
      { type: "text", text: "ordinary trailing text" },
    ]))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request([
      { type: "text", text: prompt },
      { type: "tool_result", tool_use_id: "tool-1", content: "preserved result" },
      { type: "text", text: prompt },
    ]))).toBeNull();
  });

  it("rejects missing hard anchors, weak section structure, and ordinary quoted wording", () => {
    expect(extractClaudeCodeCompactPrompt(request(compactPrompt().replace(PREFIX, "Quoted compact instructions:")))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(compactPrompt() + " trailing"))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(compactPrompt({ omittedSections: [2, 3] })))).toBeNull();
    expect(extractClaudeCodeCompactPrompt(request(
      `A document quotes '${PREFIX}' and '${SUFFIX}', but it is not the compact template.`,
    ))).toBeNull();
  });

  it("rejects an assistant final message and a non-final compact request", () => {
    const prompt = compactPrompt();
    expect(extractClaudeCodeCompactPrompt({
      ...request(prompt),
      messages: [{ role: "assistant", content: prompt }],
    })).toBeNull();
    expect(extractClaudeCodeCompactPrompt({
      ...request(prompt),
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "not compact" },
      ],
    })).toBeNull();
  });

  it("logs only non-correlating structural metrics for a partial fingerprint", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = "sensitive-history-marker";
    expect(extractClaudeCodeCompactPrompt(request(
      compactPrompt({ omittedSections: [2, 3] }) + secret,
    ))).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const logged = warn.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toMatch(
      /sections=5\/7 chars=\d+ shape=string blocks=1 prompt_block=0 intro=1 missing=[01]{7} duplicate=[01]{7} ordering=[01]{7}/,
    );
    expect(logged).not.toMatch(/(?:^|\s)(?:prompt_hash|hash|sha256|digest)=/i);
    expect(logged).not.toMatch(/(?:^|\s)[0-9a-f]{12}(?:\s|$)/i);
    expect(logged).not.toMatch(/(?:^|\s)[0-9a-f]{64}(?:\s|$)/i);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(PREFIX);
  });
});

describe("Claude Code compact bridge requests", () => {
  it("removes the compact prompt from compact history and replays it after opaque output", () => {
    const prompt = compactPrompt();
    const req: AnthropicMessagesRequest = {
      ...request(prompt),
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
        { role: "user", content: prompt },
      ],
    };
    const compact = buildClaudeCodeCompactRequest(req, translated());
    expect(compact.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "world" }] },
    ]);
    expect(JSON.stringify(compact.input)).not.toContain(PREFIX);
    expect(compact).toMatchObject({
      service_tier: "fast",
      prompt_cache_key: "session-key",
      client_metadata: { custom: "metadata" },
      turnState: "turn-state",
      turnMetadata: "turn-metadata",
      betaFeatures: "beta-feature",
      version: "1.2.3",
      includeTimingMetrics: "true",
      codexWindowId: "window-id",
      parentThreadId: "parent-id",
    });

    const opaque = [
      { type: "reasoning", encrypted_content: "opaque-secret", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary" }] },
    ];
    const render = buildClaudeCodeRenderRequest(translated(), opaque, prompt, true);
    expect(render.input.slice(0, 2)).toEqual(opaque);
    expect(render.input.at(-1)).toEqual({
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    });
    expect(render.tools).toBeUndefined();
    expect(render.useWebSocket).toBe(true);
  });

  it("keeps all preceding text blocks and removes only the matched compact block", () => {
    const prompt = compactPrompt();
    const req: AnthropicMessagesRequest = {
      ...request(prompt),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "first preceding text" },
          { type: "text", text: "second preceding text" },
          { type: "text", text: prompt },
          { type: "text", text: " \n" },
        ],
      }],
    };

    const compact = buildClaudeCodeCompactRequest(req, translated());
    expect(compact.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "first preceding text" }] },
      { role: "user", content: [{ type: "input_text", text: "second preceding text" }] },
      { role: "user", content: [{ type: "input_text", text: " \n" }] },
    ]);
    expect(JSON.stringify(compact.input)).not.toContain(PREFIX);
  });

  it("removes only the mixed-message compact prompt and preserves sibling blocks in order", () => {
    const prompt = compactPrompt();
    const req: AnthropicMessagesRequest = {
      ...request(prompt),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "preceding text" },
          { type: "text", text: prompt },
          { type: "tool_result", tool_use_id: "tool-1", content: "preserved result" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        ],
      }],
    };

    const compact = buildClaudeCodeCompactRequest(req, translated());
    expect(compact.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "preceding text" }] },
      {
        type: "function_call_output",
        call_id: "tool-1",
        output: JSON.stringify({
          anthropic_tool_result: {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "preserved result",
          },
        }),
      },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }] },
    ]);
    expect(JSON.stringify(compact.input)).not.toContain(PREFIX);
  });

  it("preserves thinking, redacted thinking, documents, and unknown blocks as JSON", () => {
    const blocks = [
      { type: "thinking", thinking: "private reasoning", signature: "sig" },
      { type: "redacted_thinking", data: "ciphertext" },
      { type: "document", source: { type: "base64", data: "docdata" } },
      { type: "future_block", nested: { value: 42 } },
    ];
    const input = anthropicHistoryToLosslessCodexInput([
      { role: "assistant", content: blocks },
    ] as AnthropicMessagesRequest["messages"]);
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("private reasoning");
    expect(serialized).toContain("ciphertext");
    expect(serialized).toContain("docdata");
    expect(serialized).toContain("future_block");
    expect(serialized).toContain("42");
  });
});
