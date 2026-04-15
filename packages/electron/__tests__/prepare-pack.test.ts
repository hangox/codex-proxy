/**
 * electron/prepare-pack.mjs 测试。
 *
 * 验证根目录运行时资源（config/、public/ 等）会在 electron-builder
 * 执行前复制到 packages/electron/，并能在结束后被清理。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { withPreparePackLock } from "./prepare-pack-lock";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");
const SCRIPT = resolve(PKG_DIR, "electron", "prepare-pack.mjs");

// prepare-pack 从根目录复制到 packages/electron/ 的目录。
const DIRS = ["config", "public", "bin"];

describe("prepare-pack.mjs", () => {
  function cleanCopies(): void {
    for (const dir of DIRS) {
      const dest = resolve(PKG_DIR, dir);
      // 只清理 packages/electron/ 下的副本，不碰根目录原始资源。
      if (existsSync(dest) && resolve(dest) !== resolve(ROOT_DIR, dir)) {
        rmSync(dest, { recursive: true });
      }
    }
  }

  beforeEach(() => withPreparePackLock(cleanCopies));
  afterEach(() => withPreparePackLock(cleanCopies));

  it("copies root directories into packages/electron/", () => {
    withPreparePackLock(() => {
      execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

      for (const dir of DIRS) {
        const rootDir = resolve(ROOT_DIR, dir);
        const copyDir = resolve(PKG_DIR, dir);
        if (existsSync(rootDir)) {
          expect(existsSync(copyDir)).toBe(true);
        }
      }
    });
  });

  it("copies config/ with correct content", () => {
    withPreparePackLock(() => {
      execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

      const rootConfig = resolve(ROOT_DIR, "config", "default.yaml");
      const copyConfig = resolve(PKG_DIR, "config", "default.yaml");

      if (existsSync(rootConfig)) {
        expect(existsSync(copyConfig)).toBe(true);
        expect(readFileSync(copyConfig, "utf-8")).toBe(
          readFileSync(rootConfig, "utf-8"),
        );
      }
    });
  });

  it("--clean removes copied directories", () => {
    withPreparePackLock(() => {
      // 先执行复制。
      execFileSync("node", [SCRIPT], { cwd: PKG_DIR });

      // 至少确认 config 已经存在，避免清理测试误报。
      const copyConfig = resolve(PKG_DIR, "config");
      expect(existsSync(copyConfig)).toBe(true);

      // 再执行清理。
      execFileSync("node", [SCRIPT, "--clean"], { cwd: PKG_DIR });

      for (const dir of DIRS) {
        expect(existsSync(resolve(PKG_DIR, dir))).toBe(false);
      }
    });
  });

  it("skips missing root directories without error", () => {
    withPreparePackLock(() => {
      // 脚本遇到缺失目录时应只告警，不应抛错。
      const result = execFileSync("node", [SCRIPT], {
        cwd: PKG_DIR,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      expect(result).toBeDefined();
    });
  });

  it("--clean is idempotent (no error when dirs already absent)", () => {
    withPreparePackLock(() => {
      // 未复制过时直接清理也应该成功。
      expect(() => {
        execFileSync("node", [SCRIPT, "--clean"], { cwd: PKG_DIR });
      }).not.toThrow();
    });
  });
});
