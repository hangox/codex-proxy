import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmptyResponseError,
  preflightContentfulStream,
  type ExtractedEvent,
} from "@src/translation/codex-event-extractor.js";

const originalDumpFlag = process.env.DEBUG_DUMP_EMPTY_RESPONSE;
const originalDumpDir = process.env.DEBUG_DUMP_EMPTY_RESPONSE_DIR;

let dumpRoot: string;

function event(type: string, data: unknown = {}, extra: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    raw: { event: type, data },
    typed: { type, ...(typeof data === "object" && data !== null ? data : {}) } as ExtractedEvent["typed"],
    ...extra,
  };
}

async function* source(events: ExtractedEvent[]): AsyncGenerator<ExtractedEvent> {
  yield* events;
}

function currentDumpDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readDumpFile(): Promise<{ day: string; file: string; lines: Array<Record<string, unknown>> }> {
  const [day] = await readdir(dumpRoot);
  const files = await readdir(join(dumpRoot, day));
  expect(files).toHaveLength(1);
  const content = await readFile(join(dumpRoot, day, files[0]), "utf8");
  return {
    day,
    file: files[0],
    lines: content.trim().split("\n").map((line) => JSON.parse(line)),
  };
}

async function readDumpLines(): Promise<Array<Record<string, unknown>>> {
  return (await readDumpFile()).lines;
}

beforeEach(async () => {
  dumpRoot = await mkdtemp(join(tmpdir(), "codex-empty-dump-"));
  process.env.DEBUG_DUMP_EMPTY_RESPONSE = "1";
  process.env.DEBUG_DUMP_EMPTY_RESPONSE_DIR = dumpRoot;
});

afterEach(async () => {
  process.env.DEBUG_DUMP_EMPTY_RESPONSE = originalDumpFlag;
  process.env.DEBUG_DUMP_EMPTY_RESPONSE_DIR = originalDumpDir;
  await rm(dumpRoot, { recursive: true, force: true });
});

describe("empty response raw upstream dump", () => {
  it("dumps buffered raw events before throwing on terminal event without content", async () => {
    const events = [
      event("response.created", { response: { id: "resp_dump_terminal" } }, { responseId: "resp_dump_terminal" }),
      event(
        "response.completed",
        {
          response: {
            id: "resp_dump_terminal",
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          responseId: "resp_dump_terminal",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      ),
    ];

    await expect(preflightContentfulStream(source(events))).rejects.toBeInstanceOf(EmptyResponseError);

    const dump = await readDumpFile();
    expect(dump.day).toBe(currentDumpDay());
    expect(dump.file).toMatch(/^resp_dump_terminal-\d+\.jsonl$/);
    expect(dump.lines).toMatchObject([
      { kind: "event", event: "response.created", data: { response: { id: "resp_dump_terminal" } } },
      { kind: "terminal_no_content", event: "response.completed", data: { response: { id: "resp_dump_terminal" } } },
    ]);
    expect(dump.lines.every((line) => typeof line.ts === "string")).toBe(true);
  });

  it("dumps iterator_done when the upstream stream reaches EOF without content", async () => {
    await expect(preflightContentfulStream(source([]))).rejects.toBeInstanceOf(EmptyResponseError);

    const lines = await readDumpLines();
    expect(lines).toMatchObject([{ kind: "iterator_done", event: null, data: null }]);
  });

  it("caps each dump file to 200 jsonl rows including the terminal reason", async () => {
    const events = Array.from({ length: 205 }, (_, index) => event(
      "response.in_progress",
      { index },
      { responseId: "resp_dump_cap" },
    ));

    await expect(preflightContentfulStream(source(events))).rejects.toBeInstanceOf(EmptyResponseError);

    const lines = await readDumpLines();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toMatchObject({ kind: "event", data: { index: 6 } });
    expect(lines[199]).toMatchObject({ kind: "iterator_done", event: null, data: null });
  });

  it("does not write dumps when DEBUG_DUMP_EMPTY_RESPONSE is not enabled", async () => {
    delete process.env.DEBUG_DUMP_EMPTY_RESPONSE;

    await expect(preflightContentfulStream(source([]))).rejects.toBeInstanceOf(EmptyResponseError);

    await expect(readdir(dumpRoot)).resolves.toEqual([]);
  });

  it("keeps at most 1000 dumps per day by removing the oldest file before writing", async () => {
    const dayDir = join(dumpRoot, currentDumpDay());
    await mkdir(dayDir, { recursive: true });
    const oldTime = new Date("2024-01-01T00:00:00.000Z");
    for (let index = 0; index < 1000; index += 1) {
      const file = join(dayDir, `old-${index.toString().padStart(4, "0")}.jsonl`);
      await writeFile(file, "{}\n");
      await utimes(file, oldTime, new Date(oldTime.getTime() + index));
    }

    await expect(preflightContentfulStream(source([]))).rejects.toBeInstanceOf(EmptyResponseError);

    const files = await readdir(dayDir);
    expect(files).toHaveLength(1000);
    expect(files).not.toContain("old-0000.jsonl");
    expect(files.some((file) => file.startsWith("unknown-rid-") && file.endsWith(".jsonl"))).toBe(true);
  });
});
