import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * `docker-publish.yml` 的 `concurrency.group` 曾经是一个全局单一字符串
 * （`docker-publish`），不区分触发它的 ref 是什么。GitHub Actions 的
 * `cancel-in-progress: true` 语义是"同一个 group 里，新 run 取消旧
 * run"——group 不按 ref 拆分，就意味着**任意 master push（哪怕纯文档
 * 提交）都会取消掉正在跑的 tag 构建**，反过来也一样，两者互相顶。
 *
 * 2026-08-03 发 `v2.0.95` 时真实撞到：`gh workflow run docker-publish.yml
 * --ref v2.0.95` 手动 dispatch 后，一次纯 CLAUDE.md 文档订正的 master
 * push 触发了另一个 docker-publish run，把正在跑的 v2.0.95 tag 构建
 * cancel 掉了——两次触发的 ref 完全不同（`refs/tags/v2.0.95` vs
 * `refs/heads/master`），没有任何理由应该互相排斥。
 *
 * 危害不是"要重跑一次"这么轻——是**没人注意到时版本 tag 的镜像压根没
 * 产出**：cancel 掉的是 tag 构建，而顶掉它的那个 master-push run 会
 * 正常跑完，产出一个 `sha-<commit>` 镜像。如果没人去核对 tag 构建
 * 的最终状态（而是想当然地认为"push 都成功了，镜像应该在"），很容易
 * 把这个 `sha-<commit>` 镜像误当成要发布的版本部署上去——比 `v2.0.88`
 * 那次（tag 被错误地重新指向了另一个 commit，但好歹还指向了*一个*
 * 镜像）更隐蔽，因为这次版本 tag 对应的镜像是**完全不存在**的。
 *
 * 修法：`group: docker-publish` 换成 `group: docker-publish-${{ github.ref }}`
 * ——不同 ref 各自一个隔离的并发组，同一个 ref 重复触发（比如连续两次
 * 手动 dispatch 同一个 tag）仍然会互相 cancel（这是期望行为，没有理由
 * 让同一个 ref 的构建排队），但不同 ref 之间不再互相打断。
 */

function readWorkflow(): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", "docker-publish.yml"), "utf-8");
}

/** Pull out the `concurrency:` block (from `concurrency:` to the next top-level key). */
function extractConcurrencyBlock(workflow: string): string {
  const idx = workflow.indexOf("\nconcurrency:");
  expect(idx, "docker-publish.yml must have a top-level concurrency: block").toBeGreaterThanOrEqual(0);
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

describe("docker-publish.yml concurrency group is scoped per-ref, not global", () => {
  it("the concurrency group includes github.ref (not a bare constant string)", () => {
    const block = extractConcurrencyBlock(readWorkflow());
    expect(block).toMatch(/group:\s*docker-publish-\$\{\{\s*github\.ref\s*\}\}/);
  });

  it("cancel-in-progress stays true (same-ref re-triggers should still cancel each other)", () => {
    const block = extractConcurrencyBlock(readWorkflow());
    expect(block).toMatch(/cancel-in-progress:\s*true/);
  });

  it("regression canary: the historically-global bare group name does not reappear verbatim", () => {
    // 事故复现原文：group 整行只有常量字符串，没有任何 github.ref 插值。
    const workflow = readWorkflow();
    expect(workflow).not.toMatch(/\n\s*group:\s*docker-publish\s*\n/);
  });
});
