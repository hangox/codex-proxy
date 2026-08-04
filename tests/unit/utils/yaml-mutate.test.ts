/**
 * Tests for mutateYaml — atomic YAML file mutation.
 *
 * The lock (`utils/file-lock.js`) is mocked out here — it has its own test
 * file (`file-lock.test.ts`) and a separate cross-process concurrency test
 * (`yaml-mutate-concurrency.test.ts`). Mixing lock-acquisition assertions
 * into this file would blur the boundary between "does the read-mutate-
 * write-rename logic work" and "does the lock work", and — more concretely
 * — file-lock.ts calls the same mocked `fs.writeFileSync` this file already
 * mocks for the data write, so without isolating it, assertions like
 * `mockWrite.mock.calls[0]` would be reading whichever of the two writes
 * (lock acquire vs. data write) happened to run first, not deterministically
 * the one the test means to check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/utils/file-lock.js", () => ({
  tryAcquireFileLock: vi.fn(() => true),
  releaseFileLock: vi.fn(),
}));

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { mutateYaml } from "@src/utils/yaml-mutate.js";

const mockRead = readFileSync as Mock;
const mockWrite = writeFileSync as Mock;
const mockRename = renameSync as Mock;
const mockExists = existsSync as Mock;
const mockMkdir = mkdirSync as Mock;

beforeEach(() => {
  vi.resetAllMocks();
  mockExists.mockReturnValue(true); // default: file exists
});

/** The tmp path is now `${filePath}.tmp.${pid}.${randomHex}`, not a fixed
 *  `${filePath}.tmp` — assert the pattern, not an exact string. */
function tmpPathPattern(filePath: string): RegExp {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.tmp\\.\\d+\\.[0-9a-f]{8}$`);
}

describe("mutateYaml", () => {
  it("reads file, applies mutator, writes a unique .tmp file, then atomic renames", async () => {
    mockRead.mockReturnValue("port: 8080\n");

    await mutateYaml("/config/default.yaml", (data) => {
      data.port = 9090;
    });

    expect(mockRead).toHaveBeenCalledWith("/config/default.yaml", "utf-8");
    expect(mockWrite).toHaveBeenCalledOnce();
    expect(mockWrite.mock.calls[0][0]).toMatch(tmpPathPattern("/config/default.yaml"));
    expect(mockRename).toHaveBeenCalledWith(mockWrite.mock.calls[0][0], "/config/default.yaml");

    // Verify ordering: write before rename
    const writeOrder = mockWrite.mock.invocationCallOrder[0];
    const renameOrder = mockRename.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it("mutator receives the parsed YAML object", async () => {
    mockRead.mockReturnValue("host: localhost\nport: 3000\n");
    const mutator = vi.fn();

    await mutateYaml("/app/config.yaml", mutator);

    expect(mutator).toHaveBeenCalledOnce();
    expect(mutator).toHaveBeenCalledWith({ host: "localhost", port: 3000 });
  });

  it("preserves fields not modified by the mutator", async () => {
    mockRead.mockReturnValue("name: proxy\nversion: 1\nenabled: true\n");

    await mutateYaml("/app/config.yaml", (data) => {
      data.version = 2;
    });

    const written = mockWrite.mock.calls[0][1] as string;
    expect(written).toContain("name:");
    expect(written).toContain("proxy");
    expect(written).toContain("version:");
    expect(written).toContain("2");
    expect(written).toContain("enabled:");
    expect(written).toContain("true");
  });

  it("creates file and parent directories when file does not exist", async () => {
    mockExists.mockReturnValue(false);

    await mutateYaml("/data/local.yaml", (data) => {
      data.server = { proxy_api_key: "my-key" };
    });

    expect(mockMkdir).toHaveBeenCalledWith("/data", { recursive: true });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledOnce();
    const written = mockWrite.mock.calls[0][1] as string;
    expect(written).toContain("proxy_api_key");
    expect(written).toContain("my-key");
  });

  it("does not call renameSync when writeFileSync throws, and still releases the lock", async () => {
    const { releaseFileLock } = await import("@src/utils/file-lock.js");
    mockRead.mockReturnValue("key: value\n");
    mockWrite.mockImplementation(() => {
      throw new Error("ENOSPC: no space left");
    });

    await expect(
      mutateYaml("/config.yaml", (data) => {
        data.key = "new";
      }),
    ).rejects.toThrow("ENOSPC");
    expect(mockRename).not.toHaveBeenCalled();
    // The lock must be released even on failure — a leaked lock would wedge
    // every subsequent write to this file for LOCK_STALE_MS.
    expect(releaseFileLock).toHaveBeenCalledOnce();
  });

  it("uses correct yaml.dump options (lineWidth: -1, quotingType: double-quote)", async () => {
    const longValue = "a".repeat(200);
    mockRead.mockReturnValue(`key: value\n`);

    await mutateYaml("/config.yaml", (data) => {
      data.long = longValue;
      // Value with special chars forces quoting — verify double quotes (not single)
      data.special = "yes";
    });

    const written = mockWrite.mock.calls[0][1] as string;

    // lineWidth: -1 means no wrapping — the long value should appear on a single line
    const longLine = written.split("\n").find((l) => l.startsWith("long:"));
    expect(longLine).toBeDefined();
    expect(longLine!.length).toBeGreaterThan(200);

    // quotingType: '"' means when quoting is needed, double quotes are used (not single)
    // "yes" is a YAML boolean keyword and must be quoted
    expect(written).toContain('"yes"');
    expect(written).not.toContain("'yes'");

    // Encoding should be utf-8
    expect(mockWrite.mock.calls[0][2]).toBe("utf-8");
  });

  it("throws (without touching the file) when the lock cannot be acquired", async () => {
    // mutateYaml retries for up to ACQUIRE_TIMEOUT_MS (2000ms, 50ms interval)
    // before giving up — fake timers so this test doesn't burn 2 real seconds.
    vi.useFakeTimers();
    try {
      const { tryAcquireFileLock } = await import("@src/utils/file-lock.js");
      (tryAcquireFileLock as Mock).mockReturnValue(false);
      mockRead.mockReturnValue("key: value\n");

      const result = mutateYaml("/config.yaml", (data) => {
        data.key = "new";
      });
      const assertion = expect(result).rejects.toThrow(/Failed to acquire lock/);
      await vi.advanceTimersByTimeAsync(2100);
      await assertion;

      // Never got to the read-mutate-write-rename body at all.
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
