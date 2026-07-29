import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * `docker-publish.yml` 的 `actions/checkout` step 曾经用 `fetch-tags: true`
 * （不带 `fetch-depth: 0`）——这个组合在触发事件本身就是一个 tag（`push:
 * tags` 或 `workflow_dispatch` 手动选中一个 tag）时，会撞上 `actions/checkout`
 * 的已知 bug（upstream `actions/checkout#1467`，`@v4` 未修，官方修复要到
 * `v6.0.2` 才发布）：checkout 内部同时构造"把触发 commit 的 SHA 写进
 * `refs/tags/vX.Y.Z`"和"拉取全部 tags 也会写同一个 `refs/tags/vX.Y.Z`"
 * 两条 refspec，同一次 `git fetch` 里冲突，报
 * `fatal: Cannot fetch both <sha> and refs/tags/vX.Y.Z to refs/tags/vX.Y.Z`，
 * checkout 直接失败，**发布路径（推 release tag 触发的构建）完全跑不起来**。
 * `workflow_dispatch` 手动选中同一个 tag 重跑会撞同一个错误（`github.ref`
 * 同样是 `refs/tags/*`），说明这条兜底路径此前也实际不可用，只是没人真的
 * 靠它跑过发布构建，一直没被发现。
 *
 * 这个 bug 和"版本 tag 被静默覆盖"（`docker-publish-tag-guard.test.ts`）是
 * 两个独立问题——**修复顺序上有依赖**：先修好 `type=raw,value=v...` 缺
 * `enable=` 守卫的那个洞之后，"用 `--ref master` 绕过 checkout bug"这条
 * 历史上一直在用的权宜路径（旧代码无条件打版本 tag，绕开 checkout 用
 * master 也能打出正确的版本号）不再产出版本 tag（`enable=` 判断
 * `github.ref` 不是 tag ref），checkout 这个 bug 才第一次真正挡住整条
 * 发布链路——不是这次 `enable=` 守卫修坏了什么，是它让一个此前被无条件
 * 打 tag「意外掩盖」的老 bug 第一次暴露出来。
 *
 * 修法：`fetch-tags: true` 换成 `fetch-depth: 0` + 显式 `ref: ${{ github.ref }}`：
 * - `fetch-depth: 0` 触发 `actions/checkout` 的"全历史"分支——查过它的
 *   源码（`ref-helper.ts` 的 `getRefSpecForAllHistory`），这条路径无条件
 *   带上 `+refs/tags/*:refs/tags/*`（不看 `fetch-tags` 设不设），且只做
 *   两个通配符 refspec（`refs/heads/*` 和 `refs/tags/*`），不会构造"某个
 *   具体 SHA 写进某个具体 tag ref"这种会跟通配符冲突的 refspec，天然
 *   避开这个 bug；`Read version` 的 `LATEST_STABLE` 需要的"全部 tags"，
 *   `fetch-depth: 0` 天然满足，不依赖 `fetch-tags`。
 * - `ref: ${{ github.ref }}` 是 `release.yml` 里已经在用、且被 upstream
 *   issue #1467 讨论串里多个独立复现者验证过对 tag push 触发场景确实
 *   生效的同款写法（不是本仓库自创、也不是只凭源码推理就假定有效）。
 *
 * 关键回归点：`0f65218`（#430）当初把这里从 `fetch-depth: 0` 换成
 * `fetch-tags: true` 是为了"更轻量的 checkout"——这个理由本身没错，但
 * 在这个仓库的体量下（.git 只有 18M、164 个 tag）全历史 fetch 的耗时相对
 * 后面的多平台 buildx 构建（linux/amd64+arm64，QEMU 模拟）可以忽略不计。
 * 这条测试要防住的场景是：以后有人为了"CI 提速"又把它换回
 * `fetch-tags: true`——这类改动本身不会报错，master 推送照样绿，只有
 * 真正推 release tag 那天才会炸，而且炸的时候人已经不在这次改动的上下文
 * 里了，纯靠人工记忆挡不住。
 */

function readWorkflow(): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", "docker-publish.yml"), "utf-8");
}

/** Pull out the `actions/checkout` step block (from `uses: actions/checkout` to the next `- ` step or `- name:`). */
function extractCheckoutStep(workflow: string): string {
  const idx = workflow.indexOf("uses: actions/checkout");
  expect(idx, "docker-publish.yml must still use actions/checkout").toBeGreaterThanOrEqual(0);
  const after = workflow.slice(idx);
  const lines = after.split("\n");
  const stepLines: string[] = [lines[0]!];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at the next step (a line starting a new `- ` item at the same
    // indentation as `with:`'s sibling keys, i.e. back at 6-space `- `).
    if (/^\s{6}-\s/.test(line)) break;
    stepLines.push(line);
  }
  return stepLines.join("\n");
}

describe("docker-publish.yml checkout does not hit actions/checkout#1467", () => {
  it("does not use the historically-broken `fetch-tags: true` (without fetch-depth: 0) combination", () => {
    const step = extractCheckoutStep(readWorkflow());
    // 硬性要求：这个 step 完全不出现 fetch-tags: true。fetch-depth: 0 本身
    // 已经无条件带全部 tags（见文件头注释的源码依据），fetch-tags 这个
    // 输入在这个组合下是多余的，出现就说明有人往回改了。
    expect(step).not.toMatch(/fetch-tags:\s*true/);
  });

  it("uses fetch-depth: 0 (the combination that avoids the SHA-vs-wildcard tag refspec collision)", () => {
    const step = extractCheckoutStep(readWorkflow());
    expect(step).toMatch(/fetch-depth:\s*0\b/);
  });

  it("explicitly sets ref: to github.ref (the verified-working companion to fetch-depth: 0 for tag-triggered checkouts)", () => {
    const step = extractCheckoutStep(readWorkflow());
    expect(step).toMatch(/ref:\s*\$\{\{\s*github\.ref\s*\}\}/);
  });

  it("regression canary: the historically-broken checkout block does not reappear verbatim", () => {
    const workflow = readWorkflow();
    // 事故复现原文：只有 fetch-tags: true，没有 fetch-depth/ref。
    expect(workflow).not.toMatch(/uses:\s*actions\/checkout@v4\s*\n\s*with:\s*\n\s*fetch-tags:\s*true\s*\n\s*\n/);
  });
});
