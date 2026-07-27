#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
const SECTION_INTRO = "Your summary should include the following sections:";
const SUFFIX = "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";
const SECTION_HEADINGS: ReadonlyArray<readonly string[]> = [
  ["1. Primary Request and Intent:"],
  ["2. Key Technical Concepts:"],
  ["3. Files and Code Sections:"],
  ["4. Errors and fixes:"],
  ["5. Problem Solving:"],
  ["6. All user messages:"],
  ["7. Pending Tasks:"],
  ["8. Current Work:", "8. Work Completed:"],
  ["9. Optional Next Step:", "9. Context for Continuing Work:"],
];

interface TextBlock {
  type: "text";
  text: string;
}

interface FixtureVariant {
  finalMessage: {
    role: string;
    content: unknown;
  };
}

interface LocalFixture {
  source?: string;
  version?: string;
  variants: Record<string, FixtureVariant>;
}

export interface CompactFixtureSummary {
  schemaVersion: 1;
  source: "local-capture-structure-only";
  variants: Record<string, CompactVariantSummary>;
}

export interface CompactVariantSummary {
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
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

function extractPrompt(content: unknown): {
  prompt: string;
  blockShape: CompactVariantSummary["blockShape"];
} {
  if (typeof content === "string") {
    if (content.trim() === "") throw new Error("compact prompt 不能为空");
    return {
      prompt: content,
      blockShape: {
        kind: "string",
        count: 1,
        textBlockCount: 1,
        nonEmptyTextBlockCount: 1,
        promptBlockIndex: 0,
      },
    };
  }
  if (!Array.isArray(content) || !content.every(isTextBlock)) {
    throw new Error("fixture content 必须是字符串或纯 text blocks");
  }
  let promptBlockIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]!.text.trim() !== "") {
      promptBlockIndex = index;
      break;
    }
  }
  if (promptBlockIndex < 0) throw new Error("fixture 不包含非空 text block");
  return {
    prompt: content[promptBlockIndex]!.text,
    blockShape: {
      kind: "text_blocks",
      count: content.length,
      textBlockCount: content.length,
      nonEmptyTextBlockCount: content.filter((block) => block.text.trim() !== "").length,
      promptBlockIndex,
    },
  };
}

function firstHeadingOffset(prompt: string, alternatives: readonly string[]): {
  offset: number;
  kind: string;
} {
  const matches = alternatives
    .map((heading, index) => ({ offset: prompt.indexOf(heading), kind: `option_${index + 1}` }))
    .filter((match) => match.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  return matches[0] ?? { offset: -1, kind: "missing" };
}

export function summarizeCompactPrompt(
  content: unknown,
  version: string,
): CompactVariantSummary {
  const extracted = extractPrompt(content);
  const prompt = normalize(extracted.prompt).trim();
  const headings = SECTION_HEADINGS.map((alternatives) => firstHeadingOffset(prompt, alternatives));
  const sectionOffsets = headings.map((heading) => heading.offset);
  return {
    version,
    promptLength: prompt.length,
    prefixMatches: prompt.startsWith(PREFIX),
    suffixMatches: prompt.endsWith(SUFFIX),
    sectionIntroOffset: prompt.indexOf(SECTION_INTRO),
    sectionOffsets,
    sectionsOrdered: sectionOffsets.every(
      (offset, index) => offset >= 0 && (index === 0 || offset > sectionOffsets[index - 1]!),
    ),
    sectionKinds: headings.map((heading) => heading.kind),
    blockShape: extracted.blockShape,
  };
}

export function summarizeCompactFixture(fixture: LocalFixture): CompactFixtureSummary {
  const version = fixture.version ?? "2.1.219";
  return {
    schemaVersion: 1,
    source: "local-capture-structure-only",
    variants: Object.fromEntries(
      Object.entries(fixture.variants).map(([name, variant]) => [
        name,
        summarizeCompactPrompt(variant.finalMessage.content, version),
      ]),
    ),
  };
}

export function validatePromptAgainstSummary(
  content: unknown,
  expected: CompactVariantSummary,
): boolean {
  return JSON.stringify(summarizeCompactPrompt(content, expected.version)) === JSON.stringify(expected);
}

function main(): void {
  const input = resolve(process.argv[2] ?? "tests/_fixtures/local/claude-code-2.1.219-compact-request.json");
  const output = resolve(process.argv[3] ?? "tests/_fixtures/claude-code-compact-structure-summary.json");
  if (!existsSync(input)) {
    throw new Error(`找不到本地 compact fixture：${input}`);
  }
  const fixture = JSON.parse(readFileSync(input, "utf-8")) as LocalFixture;
  writeFileSync(output, `${JSON.stringify(summarizeCompactFixture(fixture), null, 2)}\n`, "utf-8");
  console.log(`已写入 compact 结构摘要：${output}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
