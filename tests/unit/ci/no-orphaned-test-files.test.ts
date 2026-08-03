import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * ★ 排查压缩明细面板"跳转日志页"链接时（team-lead 要求"必须实测，不要
 * 假设"）意外发现：`src/logs/store.test.ts`（189 行，覆盖分页/请求体
 * 脱敏/容量淘汰）和 `src/logs/request-summary.test.ts`（4 条，覆盖
 * Authorization/API key 落盘前脱敏）两个文件**从来没有被任何 `npm test`/
 * CI 执行过**——根 `vitest.config.ts` 的 `include` 只覆盖
 * `shared/**`/`tests/unit/**`/`tests/integration/**`/`tests/e2e/**`/
 * `packages/electron/__tests__/**`，裸的 `src/**` 从来不在范围内，
 * `npx vitest run src/logs/store.test.ts` 直接报 "No test files found"。
 * 这不是覆盖率不够，是这些行为（包括请求体脱敏这种真正要紧的安全相关
 * 逻辑）**完全没有被验证过**，`git status`/CI 全绿看不出来——和这次发布
 * 追查到的另外两个"检查存在但没有约束力"的问题（#83 的 tsconfig 穷尽性
 * 守卫、v2.0.95 的 `ci-quality.yml` 触发不可靠）是同一类。已经把这两个
 * 文件的独有覆盖搬到 `tests/unit/logs/` 并删除孤儿文件（搬的过程中还
 * 发现 `request-summary.test.ts` 用的 `ConfigSchema.parse({})` 早就因为
 * schema 加了必填字段而会真的报错——这个测试文件如果被跑过，从很久以前
 * 就应该是红的，只是从没人跑过所以没人发现）。
 *
 * 这条测试锁住"以后不会再发生同一件事"：扫描仓库里所有 `*.test.ts`
 * 文件（`web/` 除外——那边的 `vitest run` 走 vitest 默认 include，天然
 * 覆盖它自己目录下的所有测试文件，没有这个风险），确认每一个都落在
 * 三个 vitest config（根 `vitest.config.ts`、`tests/vitest.config.ts`——
 * `npm run test:stress`、`tests/real/vitest.config.ts`——`npm run
 * test:real`）任意一个的 `include` 允许范围内——`test:real`/`test:stress`
 * 是刻意用独立 config 把需要真实凭据/耗时长的测试隔开，被其中一个覆盖
 * 就算真的会被执行，不是漏网之鱼。
 */

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "web", "public"]);

function findTestFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findTestFiles(full, out);
    } else if (/\.(test|spec)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
}

// `npm test` (root vitest.config.ts) is not the only real way these files
// get executed — `npm run test:real`/`test:stress` intentionally gate
// credential-requiring/slow tests behind their own separate configs
// (tests/real, tests/stress). A file matched by ANY of these three is a
// real, executed test — only files matched by none of them are orphans.
const VITEST_CONFIG_PATHS = ["vitest.config.ts", "tests/vitest.config.ts", "tests/real/vitest.config.ts"];

/** Extract the string literals inside a vitest config's `include: [...]` array. */
function readVitestIncludeGlobs(configRelPath: string): string[] {
  const content = readFileSync(resolve(ROOT, configRelPath), "utf-8");
  const includeIdx = content.indexOf("include:");
  expect(includeIdx, `${configRelPath} must have an include: array`).toBeGreaterThanOrEqual(0);
  const arrayStart = content.indexOf("[", includeIdx);
  const arrayEnd = content.indexOf("]", arrayStart);
  const arrayBody = content.slice(arrayStart + 1, arrayEnd);
  return [...arrayBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * Turn a glob like `tests/unit/**\/*.{test,spec}.ts` into a RegExp matching
 * relative paths. `**\/` needs its own case (→ zero-or-more path segments,
 * i.e. an OPTIONAL group) — a naive "replace ** then leave the following
 * literal /" makes the slash mandatory, which wrongly rejects files that
 * sit directly in `tests/unit/` with no subdirectory (e.g.
 * `tests/unit/config-schema.test.ts`) even though real glob semantics
 * (and vitest's actual matching) treat `**` as matching nothing.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.]/g, "\\.")
    .replace(/\*\*\//g, "§§GLOBSTAR_SLASH§§")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/§§GLOBSTAR_SLASH§§/g, "(?:.*/)?")
    .replace(/\{test,spec\}/, "(test|spec)");
  return new RegExp(`^${escaped}$`);
}

describe("every *.test.ts file outside web/ is actually covered by vitest.config.ts's include globs", () => {
  it("no orphaned test file exists that no `npm test`/`test:real`/`test:stress` run ever picks up", () => {
    const globs = VITEST_CONFIG_PATHS.flatMap(readVitestIncludeGlobs);
    expect(globs.length).toBeGreaterThan(0);
    const patterns = globs.map(globToRegExp);

    const found: string[] = [];
    findTestFiles(ROOT, found);

    const orphans = found
      .map((f) => relative(ROOT, f))
      .filter((rel) => !patterns.some((re) => re.test(rel)));

    expect(
      orphans,
      `these test files are not matched by any vitest.config.ts include glob and are never executed by \`npm test\`: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("regression canary: the two previously-orphaned files do not reappear at their old dead location", () => {
    const found: string[] = [];
    findTestFiles(ROOT, found);
    const rels = found.map((f) => relative(ROOT, f));
    expect(rels).not.toContain("src/logs/store.test.ts");
    expect(rels).not.toContain("src/logs/request-summary.test.ts");
  });
});
