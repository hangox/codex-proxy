import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");

/**
 * `docker-publish.yml` 曾经有一个静默、无报错的漏洞：`Read version` step
 * 算的是 `max(package.json 版本, 已有最高 stable git tag)`，而 `vX.Y.Z`
 * 这条 raw 版本 tag 规则此前**没有任何 enable 条件**——docker/metadata-action
 * 的 `tags:` 列表里每一条默认都会参与输出，缺 `enable=` 等于"永远产出"。
 * 后果：workflow 的触发条件是 `push: branches:[master]`，所以**每一次
 * 日常 master 推送**都会把"当前最高版本号"这个 tag（比如 `v2.0.82`）
 * 重新指向这次构建的产物——不管 package.json 有没有实际 bump 到新版本。
 * 构建全绿、无任何报错，只有拿生产在跑的镜像 digest 去比对才会发现
 * 已发布版本被静默覆盖（真实事故：`v2.0.82` 从 `sha256:5bab5af3…` 被
 * 改指到了另一个 digest）。
 *
 * 这不是"这次忘了 bump"式的一次性问题，是两次真正发版之间的每一次
 * master 推送都会复发——因此不能只靠人工警觉，得由测试锁死这条 CI
 * 配置本身（沿用 `docker-node-runtime.test.ts` 的先例：CI 配置也是需要
 * 被单测覆盖的产物，不是只有应用代码才需要）。
 *
 * 修法：给这条 tag 规则加 `enable=${{ startsWith(github.ref, 'refs/tags/v') }}`
 * ——只在触发事件本身处于一个 `refs/tags/v*` ref 上时才产出这个 tag。
 * 用 `github.ref` 而不是 `type=ref,event=tag` 判断，是为了同时覆盖两条真实
 * 路径：① push tag 触发的自动发布；② `workflow_dispatch` 手动对着一个
 * 已有 tag 重跑（`release.yml` 里就有同款"手动指定 tag 重跑"的用法，不是
 * 假设出来的场景）——按事件类型（`event=tag`）判断的话，workflow_dispatch
 * 永远不满足"事件本身是 tag push"，会漏掉这条手动重跑路径。
 *
 * `max(package.json, 已有最高 stable tag)` 这套逻辑本身**不是这次要修的
 * 东西**：它是上游 `0f65218`（PR #430）引入的，解决的是另一个独立问题——
 * 某条落后分支的 `package.json` 版本号比已发布的还旧时，直接用它会发出
 * 一个"版本回退"的 tag。这次的 `enable=` 守卫和它完全兼容，不冲突：
 * 推 tag（比如 `v2.0.83`）触发时，`fetch-tags: true` 会把这个刚推的 tag
 * 一起拉下来，`LATEST_STABLE` 立刻就包含它，`max(...)` 算出来天然等于
 * `2.0.83`——和 tag 本身一致，版本回退场景在"推 tag"这条路径上不成立；
 * master 推送时 `enable=` 已经是 false，`max()` 算出什么都不会被用来
 * 打 tag。所以**不要为了修 tag 覆盖而删掉或简化这段 `max()` 逻辑**——那会把
 * 上游已经修过的版本回退问题重新引回来，用一个旧 bug 换一个新 bug。
 * 下面专门留了一条测试锁住这段逻辑还在。
 */

function readWorkflow(): string {
  return readFileSync(resolve(ROOT, ".github", "workflows", "docker-publish.yml"), "utf-8");
}

/** Pull out the `tags: |` block under the docker/metadata-action step. */
function extractTagsBlock(workflow: string): string {
  const metaStepIdx = workflow.indexOf("docker/metadata-action");
  expect(metaStepIdx, "docker-publish.yml must still use docker/metadata-action").toBeGreaterThanOrEqual(0);
  const afterMeta = workflow.slice(metaStepIdx);
  const tagsIdx = afterMeta.indexOf("tags: |");
  expect(tagsIdx, "docker/metadata-action step must have a `tags: |` block").toBeGreaterThanOrEqual(0);
  const afterTags = afterMeta.slice(tagsIdx + "tags: |".length);
  // The block ends at the next top-level (2-space-indented) `key:` line —
  // in this file that's `- uses: docker/build-push-action@v6`.
  const endIdx = afterTags.indexOf("- uses:");
  return endIdx >= 0 ? afterTags.slice(0, endIdx) : afterTags;
}

/** Find the raw `vX.Y.Z` version-tag rule line specifically (not `latest`, not `sha-*`, not `type=ref`). */
function findRawVersionTagLine(tagsBlock: string): string {
  const lines = tagsBlock.split("\n").map((l) => l.trim()).filter(Boolean);
  const match = lines.find((l) => l.startsWith("type=raw,value=v") && l.includes("steps.version.outputs.version"));
  expect(
    match,
    "docker-publish.yml must have a `type=raw,value=v${{ steps.version.outputs.version }}` tag rule",
  ).toBeDefined();
  return match!;
}

describe("docker-publish.yml version-tag overwrite guard", () => {
  it("the vX.Y.Z raw tag rule is gated by an enable= condition (never unconditional)", () => {
    const line = findRawVersionTagLine(extractTagsBlock(readWorkflow()));
    expect(line, "raw version tag must not be unconditional — every master push would overwrite it").toContain("enable=");
  });

  it("the enable= condition scopes to a real tag ref, not something that stays true on every master push", () => {
    const line = findRawVersionTagLine(extractTagsBlock(readWorkflow()));
    // 必须真正基于 ref 是不是一个 tag 来判断——不能是 `enable=${{ true }}`
    // 或 `is_default_branch` 这类在日常 master 推送时也恒真的条件，那等于
    // 没加守卫。既检查用了 github.ref，也检查匹配的是 refs/tags 前缀。
    expect(line).toMatch(/enable=\$\{\{\s*startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\/v['"]\s*\)\s*\}\}/);
    expect(line).not.toContain("is_default_branch");
  });

  it("the enable= condition would still fire for a manual workflow_dispatch re-run against an existing tag", () => {
    // github.ref 判断（而不是 event=tag）是刻意的：workflow_dispatch 手动
    // 选中一个已有 tag 重跑时，github.ref 会是 refs/tags/v2.0.83 这类值，
    // 但触发事件本身不是 "push a tag"——按事件类型判断会漏掉这条路径。
    // 这里直接断言用的是 github.ref 而不是 github.event_name/event=tag，
    // 防止以后有人"优化"成看起来更直观但会漏掉手动重跑场景的写法。
    const line = findRawVersionTagLine(extractTagsBlock(readWorkflow()));
    expect(line).toContain("github.ref");
    expect(line).not.toMatch(/event=tag.*enable=|enable=.*event=tag/);
  });

  it("regression canary: the historically-vulnerable bare line does not reappear verbatim anywhere in the file", () => {
    // 事故复现原文：完全没有 enable 的这一行。就算上面三条断言的写法以后被
    // 重构，这条钉死"这个字符串不能原样出现"作为最后一道防线。
    const workflow = readWorkflow();
    expect(workflow).not.toContain("type=raw,value=v${{ steps.version.outputs.version }}\n");
  });

  it("push triggers still include both master and tag refs (guard doesn't accidentally narrow the trigger surface)", () => {
    // 这条修复只应该改 tags: 列表里那一行的 enable 条件，不应该动
    // workflow 本身的触发范围——顺手守一下，防止有人把这次修复和"顺便
    // 收紧触发条件"混在一起做。
    const workflow = readWorkflow();
    const onSection = workflow.split("\non:")[1]?.split("\njobs:")[0] ?? "";
    expect(onSection).toMatch(/branches:\s*\[master\]/);
    expect(onSection).toMatch(/tags:\s*\["v\*"\]/);
  });

  it("steps.version.outputs.version has exactly one consumer — the guarded tag line (Read version step is still needed, don't remove it)", () => {
    const workflow = readWorkflow();
    const occurrences = workflow.split("steps.version.outputs.version").length - 1;
    expect(occurrences).toBe(1);
    expect(workflow).toContain("id: version");
  });

  it("the max(package.json, latest stable tag) version-regression guard (upstream #430) is still intact — this fix must not remove or simplify it", () => {
    // 这段逻辑解决的是另一个独立问题（落后分支的 package.json 版本号
    // 比已发布的还旧时不能直接采信），和这次的 enable= 守卫兼容、不冲突
    // （推 tag 时 fetch-tags 会把新 tag 一起拉下来，max() 天然等于新 tag
    // 本身）。这里只锁"这套比较逻辑还在"，不锁具体实现细节。
    const workflow = readWorkflow();
    expect(workflow).toContain("PKG_VERSION");
    expect(workflow).toContain("LATEST_STABLE");
    expect(workflow).toMatch(/git tag --sort=-v:refname/);
    expect(workflow).toContain("fetch-tags: true");
    // 真的做了"取较大值"的比较，不是随手留了同名变量但逻辑被简化成
    // 只读 package.json。
    expect(workflow).toMatch(/cmp\(a,\s*b\)\s*>=\s*0\s*\?\s*a\s*:\s*b/);
  });
});
