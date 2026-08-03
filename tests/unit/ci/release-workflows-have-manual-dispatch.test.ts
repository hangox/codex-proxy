import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * GitHub Actions 触发不可靠是这个仓库的已知事实——最初记录在
 * `docker-publish.yml` 的「三个历史坑」坑 3（tag push 事件不可靠，
 * 「不可靠、时有时无，既不能指望它触发、也不能断言它不触发」），已经靠
 * `workflow_dispatch` 作为标准的手动补跑安全阀解决：`docker-publish.yml`
 * 和 `release.yml` 都能 `gh workflow run <name> --ref <ref>` 手动补跑。
 *
 * 2026-08-03 发 `v2.0.95` 后续修复文档时，这条门禁本身撞到了同一个
 * 形状的问题：`ci-quality.yml`（`package-boundary` 门禁，能真的拦住
 * `package.json`/`package-lock.json` 版本不同步这类问题——这次真的拦住
 * 过一次）当时**没有 `workflow_dispatch`**，一次纯文档 commit push 到
 * master 后迟迟没有触发它（这条 push 不是 tag，历史上这类 push 一直是
 * 秒级触发的），而且没有任何手段能手动补跑——只能干等，或者带着一个没有
 * 远端 CI 确认的 commit 继续往前走。
 *
 * 教训**不是**"这一个 workflow 忘了加"，是**任何被当作发布前必须核对
 * 状态的 workflow，都必须有 `workflow_dispatch` 作为安全阀**——触发不
 * 可靠这件事本身没有代码能修（GitHub 平台侧的问题，本仓库排查过
 * concurrency/权限/平台故障都不是根因，见 docker-publish.yml 坑 3 的
 * 注释），能做的只是保证"触发失败时，人有办法应对"。这条测试锁住这个
 * 属性，防止以后新增/修改发布相关 workflow 时又漏掉这个安全阀。
 */

const RELEASE_CRITICAL_WORKFLOWS = [
  "docker-publish.yml",
  "release.yml",
  "ci-quality.yml",
] as const;

function readWorkflow(name: string): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", name), "utf-8");
}

/** Pull out the `on:` block (from `on:` to the next top-level key). */
function extractOnBlock(workflow: string): string {
  const idx = workflow.indexOf("\non:");
  expect(idx, "workflow must have a top-level on: block").toBeGreaterThanOrEqual(0);
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

describe("release-critical workflows all have a workflow_dispatch manual-rerun safety valve", () => {
  for (const name of RELEASE_CRITICAL_WORKFLOWS) {
    it(`${name} declares workflow_dispatch as a trigger`, () => {
      const onBlock = extractOnBlock(readWorkflow(name));
      expect(onBlock, `${name}'s on: block must include workflow_dispatch`).toMatch(/\n\s*workflow_dispatch:/);
    });
  }
});
