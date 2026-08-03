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
 * `bump-electron.yml` 已经是这个选择，不是本仓库第一次这么做。这条测试
 * 除了锁住"必须有 concurrency 组"，重点锁住"这个值必须是 false，不能
 * 因为想'和 docker-publish.yml 保持风格一致'被改成 true"。
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

describe("release.yml has a per-ref concurrency group with cancel-in-progress: false", () => {
  it("the concurrency group includes github.ref (not a bare constant string)", () => {
    const block = extractConcurrencyBlock(readWorkflow());
    expect(block).toMatch(/group:\s*release-\$\{\{\s*github\.ref\s*\}\}/);
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
