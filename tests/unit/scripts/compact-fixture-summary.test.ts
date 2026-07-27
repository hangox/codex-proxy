import { describe, expect, it } from "vitest";
import {
  summarizeCompactPrompt,
  validatePromptAgainstSummary,
} from "../../../scripts/build/generate-compact-fixture-summary.js";

const PREFIX = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
const INTRO = "Your summary should include the following sections:";
const SECTIONS = [
  "1. Primary Request and Intent:",
  "2. Key Technical Concepts:",
  "3. Files and Code Sections:",
  "4. Errors and fixes:",
  "5. Problem Solving:",
  "6. All user messages:",
  "7. Pending Tasks:",
  "8. Current Work:",
  "9. Optional Next Step:",
] as const;
const SUFFIX = "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

function publicSyntheticPrompt(): string {
  return [
    PREFIX,
    "Synthetic public test content. ".repeat(20),
    INTRO,
    ...SECTIONS,
    SUFFIX,
  ].join("\n");
}

describe("compact fixture structure summary", () => {
  it("summarizes structure without retaining prompt prose", () => {
    const prompt = publicSyntheticPrompt();
    const summary = summarizeCompactPrompt([{ type: "text", text: prompt }], "test");

    expect(summary.promptLength).toBe(prompt.length);
    expect(summary.prefixMatches).toBe(true);
    expect(summary.suffixMatches).toBe(true);
    expect(summary.sectionsOrdered).toBe(true);
    expect(summary.sectionOffsets).toHaveLength(9);
    expect(JSON.stringify(summary)).not.toContain("Synthetic public test content");
  });

  it("fails reverse validation when an anchor changes by one character", () => {
    const prompt = publicSyntheticPrompt();
    const summary = summarizeCompactPrompt(prompt, "test");
    const mutated = prompt.replace("7. Pending Tasks:", "7. Pending Taskx:");

    expect(validatePromptAgainstSummary(prompt, summary)).toBe(true);
    expect(validatePromptAgainstSummary(mutated, summary)).toBe(false);
  });
});
