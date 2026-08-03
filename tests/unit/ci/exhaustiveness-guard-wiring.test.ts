import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * ★ #83：`recompact-failure-cause-exhaustiveness.test.ts` 里那个穷尽性
 * `switch`（`default: { const x: never = ... }`）本身只是一段普通 TS 代码——
 * 根 `tsconfig.json` 的 `include` 只有 "src/**" 下的 .ts 文件，`tests/` 目录从来不在
 * `npm run build`/`typecheck:scripts` 任何一个现有 tsc 调用的检查范围内，
 * `vitest` 用 esbuild 转译时也只剥类型、不做类型检查。如果没有一条真的会在
 * CI 里跑起来的 `tsc -p tsconfig.test-guards.json`，"新增
 * `OpaqueCompactStateFailure` 字面量却没同步改分类就编译失败"这个承诺就是
 * 假的——esbuild 不报错，vitest 只会在没人往 `KNOWN_CAUSE_VALUES`/
 * `NEVER_REACHES_VALUES` 里添加新字面量时保持沉默地全绿。
 *
 * 这条测试不重新验证穷尽性 switch 本身（那是
 * `recompact-failure-cause-exhaustiveness.test.ts` 自己的职责），只锁住让它
 * 真正具备约束力的两个前提：`package.json` 里的脚本存在、`ci-quality.yml`
 * 里有一步真的调用它——防止以后有人在不知情的情况下把这一步从 CI 移除，
 * 从而让穷尽性检查退化成"只有手动跑才会发现"的摆设。
 */

function readPackageJson(): string {
  return readFileSync(resolve(ROOT, "package.json"), "utf-8");
}

function readCiQualityWorkflow(): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", "ci-quality.yml"), "utf-8");
}

describe("#83 穷尽性守卫测试的 CI 接线没有被悄悄移除", () => {
  it("package.json 里存在 typecheck:test-guards 脚本，且指向 tsconfig.test-guards.json", () => {
    const pkg = JSON.parse(readPackageJson());
    expect(pkg.scripts["typecheck:test-guards"]).toBe("tsc -p tsconfig.test-guards.json");
  });

  it("tsconfig.test-guards.json 存在，且明确只覆盖穷尽性守卫测试文件（不是整个 tests/ 目录）", () => {
    const raw = readFileSync(resolve(ROOT, "tsconfig.test-guards.json"), "utf-8");
    // tsconfig 允许注释风格的自定义字段，但标准 JSON.parse 不接受行内 //
    // 注释——这个文件用的是合法 JSON 里的 "$comment" 字段，不是 // 注释，
    // 因此可以直接 JSON.parse。
    const config = JSON.parse(raw);
    expect(config.include).toContain(
      "tests/unit/routes/recompact-failure-cause-exhaustiveness.test.ts",
    );
    // ★ 不能变成 "tests/**/*.ts" 之类的宽泛 glob——那会把从未被类型检查过的
    // 其余测试文件一次性全部拉进 strict 检查，炸出一大片和这次改动无关的
    // 历史类型问题，不是这条守卫测试该做的事。
    expect(config.include).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/tests\/\*\*/)]),
    );
  });

  it("ci-quality.yml 的 package-boundary job 里有一步调用 npm run typecheck:test-guards", () => {
    const workflow = readCiQualityWorkflow();
    expect(workflow).toContain("npm run typecheck:test-guards");
  });

  it("那一步和既有的 typecheck:scripts 步骤在同一个 job 里（package-boundary），不是被塞进一个从不触发的孤立 job", () => {
    const workflow = readCiQualityWorkflow();
    const scriptsIdx = workflow.indexOf("npm run typecheck:scripts");
    const guardsIdx = workflow.indexOf("npm run typecheck:test-guards");
    expect(scriptsIdx).toBeGreaterThanOrEqual(0);
    expect(guardsIdx).toBeGreaterThan(scriptsIdx);
    // 两步之间不应该出现新的 `  job_name:` 顶层 job 声明——粗略校验它们仍在
    // 同一个 job 里（用两空格缩进的 job key 作为边界特征，和文件里其它 job
    // 声明的缩进风格一致）。
    const between = workflow.slice(scriptsIdx, guardsIdx);
    expect(between).not.toMatch(/\n {2}[a-zA-Z0-9_-]+:\n/);
  });
});
