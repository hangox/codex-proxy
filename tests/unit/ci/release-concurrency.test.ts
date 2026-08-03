import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * `release.yml` 此前完全没有 `concurrency` 组——`docker-publish.yml` 有
 * （见 `docker-publish-concurrency.test.ts`），这个仓库一直没有对着
 * `release.yml` 补齐。2026-08-03 发 `v2.0.96` 时真实暴露了后果：tag push
 * 自己触发的一条和手动 `workflow_dispatch` 的一条并发跑，两条抢同一个
 * `gh release create $TAG ... || true`，其中一条（tag-push 触发的那条）
 * 的 macOS arm64 job 在 `gh release upload` 那一步报 `HTTP 404 Not Found`
 * ——release 对象在它读到 ID 和它真正上传之间被另一条并发跑动过（脚本
 * 自己的注释写了"concurrent matrix jobs hit when a peer wins the race"，
 * 但没有真正兜住这个竞态）。
 *
 * 修法特意**不是**照抄 `docker-publish.yml` 的 `cancel-in-progress: true`
 * ——两个 workflow 的"中途被取消是否安全"完全不同：
 *
 * - `docker-publish.yml` 被 cancel 掉的是镜像构建。没构建完 = 没有镜像，
 *   天然幂等，中途取消没有任何可观测的副作用。
 * - `release.yml` 被 cancel 掉的是**正在给一个 `--draft=false` 的公开
 *   GitHub Release 上传资产**。如果在某个平台 job 上传到一半被 cancel，
 *   会留下一个真实存在、对外可见、但资产不全的 release——比"两条都跑
 *   完、其中一条因为竞态失败"更危险：失败的 run 只是浪费一次 CI 资源，
 *   真正 checkout 了 tag ref 的那条会完整上传所有平台的资产，用户看到
 *   的 release 从来没有缺过东西。如果用 `cancel-in-progress: true`，
 *   会把"一条 run 失败，但产物完整"换成"两条 run 都不失败，但产物可能
 *   不全"——用一个更隐蔽的失败模式换掉一个更明显的，是倒退不是修复。
 *
 * 因此这里必须是 `cancel-in-progress: false`（排队，不抢占）——仓库里
 * `bump-electron.yml` 已经是这个选择，不是本仓库第一次这么做。
 *
 * ★ 这条测试的第一版只断言了 `group: release-${{ github.ref }}` 这个
 * 字面量出现在 YAML 里——2026-08-03 发 `v2.0.97` 时（用第一版这条测试
 * 保护的那次改动）实测直接失效：这个仓库调用 `release.yml` 的标准方式是
 * `gh workflow run release.yml -f tag=vX.Y.Z`（**不带** `--ref`），
 * workflow_dispatch 不带 `--ref` 时用默认分支触发，`github.ref` 解析出来
 * 是 `refs/heads/master`；而 tag push 自触发那条的 `github.ref` 是
 * `refs/tags/vX.Y.Z`——**两条路径算出的并发组字符串根本不同，并发控制
 * 形同虚设**，两条 run 真的并发跑了起来。第一版测试对这个 bug**完全没有
 * 反应，因为它测的是"YAML 里有没有我自己写的那行字"，不是"这个表达式
 * 对不对"**——和这次发布另外扫出的四处"检查存在但没有约束力"是同一类
 * 问题（tsconfig 不覆盖 tests/、ci-quality 没人看、测试文件不在 runner
 * 范围、穷尽性 switch 没编译检查），这是第五次。
 *
 * 正确的 key 必须和 job 自己认定"在发哪个版本"用同一个表达式——job 里
 * 每一处 `TAG=` 赋值都是 `"${{ inputs.tag || github.ref_name }}"`，
 * 并发组必须照抄这个表达式，不能自己另外发明一个"看起来也能表示当前
 * 发布目标"的写法。这条测试改成**语义断言**：把并发组里 `release-`
 * 前缀之后的表达式，和 job body 里所有 `TAG=` 赋值的表达式，逐字符
 * 抽出来比较，只要有一处不一致就失败——这样以后任一处改了、另一处没
 * 跟上，直接红，不需要等实测撞见竞态才发现。
 *
 * ★ 这条测试覆盖不到什么，如实写清楚：这里只是静态文本比较，**不会真的
 * 求值 GitHub Actions 表达式**，也不会模拟"tag push 触发"和"手动
 * dispatch"两条真实路径分别算出什么字符串（那需要一个真正的 GitHub
 * Actions 表达式求值器或者真的跑一次 workflow，这个仓库目前没有这样的
 * 测试基础设施）。这条测试能保证的是"两处用的是同一个表达式"，不能
 * 保证"这个表达式在所有触发路径下都算出预期的值"——后者只能靠真实
 * dispatch 之后人工核对 run 的 `head_branch`/`headSha`（发布流程里已有
 * 这一步）。
 */

function readWorkflow(): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", "release.yml"), "utf-8");
}

/** Pull out the `concurrency:` block (from `concurrency:` to the next top-level key). */
function extractConcurrencyBlock(workflow: string): string {
  const idx = workflow.indexOf("\nconcurrency:");
  expect(idx, "release.yml must have a top-level concurrency: block").toBeGreaterThanOrEqual(0);
  const after = workflow.slice(idx + 1);
  const lines = after.split("\n");
  const blockLines: string[] = [lines[0]!];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at the next top-level (0-indent) key.
    if (/^[A-Za-z]/.test(line)) break;
    blockLines.push(line);
  }
  return blockLines.join("\n");
}

/** Extract the `${{ ... }}` expression that follows `release-` in the concurrency group line. */
function extractGroupExpression(block: string): string {
  const match = /group:\s*release-\$\{\{\s*(.+?)\s*\}\}/.exec(block);
  expect(match, `could not find a 'group: release-\${{ ... }}' line in:\n${block}`).not.toBeNull();
  return match![1]!.trim();
}

/**
 * Extract every `TAG="${{ ... }}"` expression from the job body, resolving
 * the one occurrence that reads `steps.tag.outputs.name` (the final
 * `release` job, which computes the tag once via an `id: tag` step instead
 * of re-evaluating the raw expression) back to whatever that step assigns —
 * so the comparison is against the real underlying expression, not a
 * step-output indirection that would otherwise look like a mismatch.
 */
function extractTagExpressions(workflow: string): string[] {
  const jobsIdx = workflow.indexOf("\njobs:");
  expect(jobsIdx, "release.yml must have a jobs: section").toBeGreaterThanOrEqual(0);
  const jobsBody = workflow.slice(jobsIdx);
  const matches = [...jobsBody.matchAll(/TAG="\$\{\{\s*(.+?)\s*\}\}"/g)];
  expect(matches.length, "expected at least one TAG=\"${{ ... }}\" assignment in the job body").toBeGreaterThan(0);

  const idTagMatch = /id:\s*tag\s*\n\s*run:\s*\|\s*\n\s*TAG="\$\{\{\s*(.+?)\s*\}\}"/.exec(jobsBody);

  return matches.map((m) => {
    const expr = m[1]!.trim();
    if (expr === "steps.tag.outputs.name") {
      expect(
        idTagMatch,
        "found a TAG= assignment reading steps.tag.outputs.name, but no `id: tag` step defining it",
      ).not.toBeNull();
      return idTagMatch![1]!.trim();
    }
    return expr;
  });
}

describe("release.yml concurrency group key matches the job's own TAG= expression (not just 'a string exists')", () => {
  it("the concurrency group's key expression is textually identical to every TAG= expression in the job body", () => {
    const workflow = readWorkflow();
    const groupExpr = extractGroupExpression(extractConcurrencyBlock(workflow));
    const tagExprs = extractTagExpressions(workflow);
    for (const tagExpr of tagExprs) {
      expect(
        groupExpr,
        `concurrency group key ("${groupExpr}") must equal the job's TAG= expression ("${tagExpr}") — a mismatch means tag-push and manual-dispatch runs compute different concurrency groups and never actually queue against each other`,
      ).toBe(tagExpr);
    }
  });

  it("regression canary: the historically-wrong 'github.ref' (not 'inputs.tag || github.ref_name') does not reappear", () => {
    const block = extractConcurrencyBlock(readWorkflow());
    // 事故复现原文：这行本身语法合法、`github.ref` 也确实是一个存在的
    // 上下文变量，纯字符串匹配测不出"表达式选错了"，所以这里专门钉死
    // 曾经出现过的那个错误表达式不能原样出现。
    expect(block).not.toMatch(/group:\s*release-\$\{\{\s*github\.ref\s*\}\}/);
  });

  it("cancel-in-progress is false — NOT true, even though docker-publish.yml uses true", () => {
    const block = extractConcurrencyBlock(readWorkflow());
    // 显式断言不是 true：这条 workflow 中途取消会留下资产不全的公开
    // release，比现在的失败模式更危险，见文件头注释。
    expect(block).toMatch(/cancel-in-progress:\s*false/);
    expect(block).not.toMatch(/cancel-in-progress:\s*true/);
  });

  it("regression canary: the historically-missing concurrency block does not silently disappear again", () => {
    const workflow = readWorkflow();
    const idx = workflow.indexOf("concurrency:");
    expect(idx, "release.yml lost its concurrency: block entirely").toBeGreaterThanOrEqual(0);
    // 必须出现在 on: 之后、permissions: 之前（和当前实现的位置一致），
    // 防止被移到一个和其它 workflow 不一致的地方而没人注意到。
    const onIdx = workflow.indexOf("\non:");
    const permissionsIdx = workflow.indexOf("\npermissions:");
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(permissionsIdx).toBeGreaterThan(idx);
    expect(idx).toBeGreaterThan(onIdx);
  });
});
