# CLAUDE.md

面向在本仓库工作的 Claude Code / AI agent 的强约束提醒。使用说明请看 `README.md`，贡献流程看 `.claude/skills/pr-push`。

## ★ 总纲：当「没做」和「做了且成功」看起来一样，你的检查就没有区分力

**下面这份事故目录里的绝大多数条目，是同一件事在不同位置的复发。** 形状永远是：某个观测看起来是在确认某件事，但它对「那件事根本没发生」这种情况**产出完全相同的输出**——于是它一直是绿的，而它承诺保证的东西早就不成立了。已经反复出现过的位置：翻译层替身、tsconfig 不覆盖 `tests/`、测试文件不在 runner 范围、`release.yml` 并发组只做字面量匹配、YAML 嵌套写错被 Zod 静默丢弃、可选链把清 cookie 变成 no-op 而日志照打。

**唯一通用的判据，在动手验证之前先问自己：**

> **「如果这件事根本没做 / 我的改动根本没生效，我现在会看到什么？」**
> **如果答案和「做了且成功」看到的一样，这个观测就没有区分力，必须换一个。**

下面六条是这条判据在具体位置上的落法。**它们不是六件事，是同一件事的六个入口**——遇到没列到的新位置，回到上面那个问题即可。

**1. 写完必须自己证伪一次：把被测实现整段删掉/改坏，测试必须有反应。**
2026-08-13 的 E2E 替身：改一行制造回归，原测试只红 4 条（其中 2 条还是既存 flake），拆掉替身后红 **45 条、跨 8 个文件**——替身压掉了 45 个信号里的 43 个，而它一直是全绿的。**「测试通过」不构成「测试有约束力」的证据，只有「实现坏掉时它会红」才是。** 同理：先写实现再补的测试证明的是「代码现在这样」，不是「代码必须这样」——写作顺序不是判据（先写代码后补的测试也可能完全站得住），但它是**该优先证伪哪条**的可靠指标。

**2. 变异实验之前，先独立证明「我改的那一下真的改到了」。**
同一天两次 patch 静默失效：一次锚点字符串不匹配、报 `12 passed`；一次替换串是 LF 而目标区段是 CRLF（本仓库 git 跟踪的 `.ts` 里有 42 个含 CRLF，口径见下方命令）、报 `75 passed`。**最危险的变体是失败方向恰好指向你期待的结论**——期待「废掉 A 之后 B 仍然绿」，而 patch 没生效同样产出全绿，两者不可区分。另外 Python `read_text()` 会把 CRLF 静默转成 LF，写回即全文件改行尾，从「没匹配上」升级成「匹配上了但改错了东西」。**做法：脚本里 `assert 内容确实变了`，或先 `git diff` 确认，再跑测试。**

```bash
# 本仓库有多少个 git 跟踪的 .ts 含 CRLF（写这条时实测 42）
git ls-files '*.ts' | while read f; do grep -qU $'\r' "$f" && echo "$f"; done | wc -l
```

**3. 声称「已经改了 / 写了 / 加了」时，必须附真实命令输出。**
2026-08-13～14 一天之内四个角色各撞一次：产品代码里 `cookieJar?.clear()` 被可选链变成 no-op 而「cleared cookies」日志照打；开发者的 patch 两次静默失效；qa 报「已写进清单」而文件里没有；team-lead 说了五次「记为待办」而没有任何落盘。**没有一条是能力或态度问题**——**人对自己刚说过的话有天然确信，而「说了」和「做了」在对话记录里完全同形**。把「我记住了 / 我记为待办」换成一个**有产物的动作**（写文件、贴输出）：声称记住了和真记住了在对话里长得一样，文件存在与否不会说谎。

**4. 对外部系统行为的断言，必须附可复现出处（`file:line` + 版本号）。**
2026-08-13 一句「官方客户端每次请求都带 `x-codex-beta-features`」从口头转述进入 CHANGELOG、差点随版本发布；**经手三人，只有一人去查了源码**。实际是「feature 启用时才带、且 header 在 session 创建时预计算」——机制错了但默认行为的观测结果恰好是对的，所以没人觉得可疑。**「口头转述」这个动作本身不携带证据**，而转述链上每一环都会因为上一环「看起来有依据」而放弃独立核对。**危害不在当下**：写错的 release note 会让将来排查的人去找一段并不存在的逻辑。

**5. 单臂检查没有区分力，必须配对照臂。**
「带 key 能通过」无法区分「key 有效」和「这个端点压根不要 key」，必须同时验「不带 key 应当失败」。同族的落法：变异测试不仅要看**该红的红了**，还要看**该绿的仍然绿**（否则可能是误伤而非命中）；修一条断言时要两头卡——只验「该放行的放行了」，一个什么都不检查的空实现同样能通过（本轮实测：把断言换成空实现后，端到端用例仍然 2 passed，只有断言自身的回归测试红了 3 条）。

**6. 绿灯不代表断言钉在正确的位置上。**
2026-08-14 实测：一条被 86 次证伪支撑过的断言，在产品的合法输出形状变化之后开始**误判正确结果**——它当时抓得住那个缺陷，不等于它现在钉的位置仍然正确。这类错位没有任何机制会自动暴露，**只能靠给断言本身写回归测试**。撞见「产品是对的、断言是错的」时最危险的走向是顺手把断言放松掉，或反过来怀疑那个正确的修复。**判据是产品行为，不是断言现状。**

---

**最后一条元规则：以上每一条都是形式性的，没有一条依赖谁更认真、更细心。** 本轮真正拦住问题的全部是形式（「写完必须证伪」「变异前先 assert」「声称必须附输出」「对外断言必须附出处」「发现版本不一致立刻喊」），而**追求「更谨慎」是不可达的目标，不要用它替代上面任何一条**。同理，消息交叉、指令过期这类协作噪音无法根除，能兜住的是「发现不一致立刻说出来」这个动作——本轮三次版本错位全部靠它兜住，没有一次造成实际损失。

## 生产 Docker 发布门禁

镜像能 build 成功 ≠ 能起来。v2.0.80 就是构建全绿、CI 全绿、进生产后每次启动都因 `node:sqlite` 在 Node 20 上不存在而 exit 1，被 `restart: unless-stopped` 拧成崩溃循环。因此**任何要进生产的镜像，必须先在容器里跑通下面这条链，才允许部署**：

1. `node -v` ≥ Dockerfile 声明的最低运行时版本，且镜像内 `node:sqlite` 可 `new DatabaseSync(":memory:")`。
2. Linux native TLS addon（`/app/native/codex-tls.linux-*.node`）可被 `require`——它加载失败同样是启动致命错误。
3. 容器真实启动到 `healthy`，`/health` 返回 200 且 `RestartCount == 0`。
4. 一次普通请求（`/v1/chat/completions`）返回 200 且内容符合预期。
5. opaque compact 全链路：root compact 出 marker → 同 marker 下一轮恢复 → **容器 restart 后同 marker 仍能恢复**。少了最后一步就没有验证持久化。

硬性要求：

- **验证过的 digest 必须等于部署的 digest。** 按 tag 部署时先核对 `RepoDigests`；tag 可以被重推，digest 不会。
- **★ 门禁必须验 CI 用 tag 构建出来的那个镜像，不能自己 build。** 这条比上一条更容易漏——上一条防的是「验的镜像 ≠ 部署的镜像」，这条防的是「**验的源码 ≠ tag 里的源码**」。2026-08-02 发 `v2.0.91` 时真实中招：tag 打完之后 qa 在门禁中发现 bug、developer 在**共享工作区**改好、qa 用**工作区文件本地 build** 了容器和 dmg 来验证，全部通过；而 release 部署的是 CI 按 tag 构建的镜像，里面是**修复前**的代码。整条 digest 核对链（`head_sha`、`RepoDigests`）**完好无损地通过了**，因为镜像确实一致——不一致的是源码。**判据：门禁开始前 `git status` 必须干净；tag 打完之后代码若有任何改动，必须重新提交、重新打 tag、重新构建、拿新 digest 重验，不存在「改动很小可以就地验」这种情况。**
- **禁止复用失败版本的构建产物**当候选，重新在干净上下文构建。
- **部署失败立即回滚**到上一个已知健康的 digest，保留失败镜像、key、state 作为取证，不要先清理再排查。
- 发布前确认唯一真正的 compact 开关（`claude_code_opaque_compact_experimental`）产品默认仍是 `false`；`claude_code_compact_bridge` 是已废弃的死配置键（classic bridge 已移除，不接任何行为，设成 `true` 只会打一条一次性弃用警告），不是需要单独核对的第二个开关。
- **门禁必须在部署之前完成，且不能靠默认。** 门禁方（qa）和部署方（developer）分离时，**派发部署任务时必须显式写明"门禁全绿才放行部署"**——不能假设对方会自己去确认门禁状态，也不能假设"没人喊停就是可以部署"。2026-08-03 发 `v2.0.95` 时真实漏过一次：任务派发时没把部署设成依赖门禁完成，部署在门禁跑完之前就执行了；发现后 qa 对已上线的生产补跑了门禁。**这是流程缺口，不是代码能锁住的东西**——发部署任务的人要对这条负责。
- **验证前端改动时"看到旧界面"不能直接判定部署失败——先排除浏览器缓存。** 2026-08-03 发 `v2.0.96` 时真实撞到：部署完打开 Dashboard 点开要验证的那个链接，文案还是旧的，一度以为前端资源没跟着镜像更新；`cmd+shift+r` 硬刷新后确认是浏览器缓存了旧的 `index.html`，镜像里的资源其实是对的。**后端 API 报的运行时版本号和"你当前这次页面加载用的静态资源是不是最新"是两件完全独立的事**——页脚版本号对了不代表同一次加载里其它资源没有被缓存命中，反过来"看到旧文案"也不代表部署没生效。**验证前端改动（不只是看页脚数字，是真正点开某个具体功能）之前，必须硬刷新或用无痕窗口**，避免把一次成功的部署误判成前端没生效、进而触发不必要的回滚。

前 3 项已固化成代码守卫，不要绕过：Dockerfile 内的 build-time 断言、`.github/workflows/ci-docker.yml` 的 smoke step、`tests/unit/ci/docker-node-runtime.test.ts`。新增任何"只在新版本 Node 存在"的内建模块依赖时，同步更新 `tests/unit/ci/docker-node-runtime.test.ts` 里的 `BUILTIN_MIN_NODE`。

**已知但未查明的观测：`docker-publish.yml` 构建耗时偶尔会比基准慢一个数量级。** 2026-08-03 发 `v2.0.96` 时，tag-ref 构建和同批代码的 master-ref 构建分别耗时约 13 分钟和 9 分钟，而历史基准（`v2.0.95` 等历次发布）通常在 1 分钟左右完成；两次构建最终都成功，产物验证也都通过，不是构建卡死或失败。**排查时曾怀疑是这次多构建了 arm64 架构，经核实站不住脚**——`v2.0.95`/`v2.0.96` 两版的 `platforms` 配置一直都是 `linux/amd64,linux/arm64`，双架构不是这次才有的变化。**真实原因没有查出来，如实记为未查明，不写任何未经验证的归因**——下次如果构建速度又出现异常波动，这条不构成"已知原因，不用管"的依据，需要重新排查。

## 版本号 bump：真实路径是手动的，不是 `bump-electron.yml`

仓库里有一条**看起来是官方发布机制、实际上已经被绕开一年多**的自动化：`.github/workflows/bump-electron.yml`——手动 dispatch 后会自动算出下一个 patch 版本号、同步 bump `package.json`/`packages/electron/package.json`/`package-lock.json`（含 `lock.version`、`lock.packages[''].version`、`lock.packages['packages/electron'].version` 三处）、commit、打 tag、push，还会自动 dispatch `release.yml` 和 `docker-publish.yml`。**它最后一次真正跑是 2026-06-30**（`gh run list --workflow=bump-electron.yml` 可查），而 `v2.0.81` 到 `v2.0.95` 这 15 次发布的 commit 全部是手写的 `chore: release X.Y.Z ...`，不是它会生成的 `chore: bump version to X.Y.Z [skip ci]`——**说明这条自动化早就名存实亡，不是这次才绕开的**。

**不建议现在恢复用它**：它不知道这个仓库后来加上的任何门禁要求（五步 Docker 验证链、digest 核对、opaque compact 持久化验证），只会盲目 bump+tag+push+dispatch，重新启用等于把 `v2.0.80` 那次事故的门禁又拆掉。**记录它的存在只是为了防止以后有人以为"发版应该走它"而误用**——真实路径就是手动改 `package.json`（见下）+ 手写 CHANGELOG + 手动 tag + 手动 dispatch，`CLAUDE.md` 前面几节记的所有坑都是针对这条手动路径的。

**手动 bump 版本号时，用 `npm version <x> --no-git-tag-version`，不要用编辑器手改 `package.json` 的 `version` 字段**：`v2.0.95` 发布时手改了 `package.json` 但没同步 `package-lock.json`，导致 `tests/unit/ci/package-boundary.test.ts`「keeps package.json and package-lock.json root metadata in sync」这条断言在 CI 里**真的红了**（`ci-quality.yml` 的 `package-boundary` job，commit `46c3c8e`，2026-08-03）——**这条检查本来就存在、本来就在 CI 里跑、也真的拦住了**，问题不是"没有检查"，是**打 tag 和部署时没人去看 `ci-quality.yml` 的状态，只看了 `docker-publish.yml`/`release.yml`**。已实测验证：npm 10.9.7 下 `npm version <x> --no-git-tag-version` 会**自动**把 `package-lock.json` 的 `version` 和 `packages[''].version` 一起改掉，不需要额外再跑 `npm install --package-lock-only`——用这条命令代替手改，从源头上让这类不同步不可能发生，比事后指望 CI 拦截更可靠。

**发 tag 前必须确认 `ci-quality.yml` 在这次要发布的 commit 上是绿的**——和「门禁必须在部署前完成」是同一类问题（CI 的 quality gate 和部署的 Docker gate 是两条独立的检查，都要看，不能只看其中一条）：`gh run list --workflow=ci-quality.yml --json headSha,conclusion` 核对 `headSha` 等于要发的 commit、`conclusion` 是 `success`。：只有 tag push 能产出「tag 真正指向的那个 commit」的镜像

这条**不是配置问题、无法用代码守卫**，只能靠发布时核对。2026-08-01 发 `v2.0.88` 时第一次暴露：

```
1. push master (6cfa6a7)        → 触发 Publish Docker Image，产出 sha-6cfa6a7
2. Sync CHANGELOG bot (2d16fa6) → 带 [skip ci]，不触发任何 workflow
3. git tag v2.0.88              → 指向 2d16fa6
4. git push origin v2.0.88      → 本该构建 2d16fa6 ← 这一步偶发失灵
```

**步骤 1 构建的永远是 bot 提交之前的版本，步骤 2 被 `[skip ci]` 主动跳过**——所以能产出 tag 对应镜像的，全链路只有步骤 4 这一条路，没有任何冗余。

它失灵时**断得极安静**：master 那个 run 是绿的、tag 是好的、`sha-<commit>` 镜像也确实存在，只是那个镜像对应的是**上一个 commit**。这次是 release 核对了 job 的 `head_sha` 才发现，否则会把 `sha-6cfa6a7` 当成 `v2.0.88` 部署上去，而且事后无从察觉（两者代码只差 README 自动同步，跑起来一模一样）。

**硬性要求：部署前必须核对构建 run 的 `head_sha` 等于 tag 指向的 commit**，不能只看 run 是否 success、镜像是否存在。

## `docker-publish.yml` 的四个历史坑

**坑 1 —— 版本 tag 曾经无条件覆盖**：`type=raw,value=vX.Y.Z` 这条 tag 规则此前没有 `enable=` 守卫，任何一次 `push master`（不只是发版）都会把当前最高版本号 tag 重新指向这次构建产物，真实事故过（`v2.0.82` 的 digest 被静默改指）。已修（`enable=${{ startsWith(github.ref, 'refs/tags/v') }}`），有 `tests/unit/ci/docker-publish-tag-guard.test.ts` 锁住。

**坑 2 —— checkout 的 `fetch-tags: true` 与 tag ref 冲突**：触发事件本身是一个 `refs/tags/vX.Y.Z` 时（推 release tag、或 `workflow_dispatch` 手动选中一个 tag 重跑），checkout 直接报错 `Cannot fetch both <sha> and refs/tags/vX.Y.Z to refs/tags/vX.Y.Z`，**tag push 这条发布路径完全构建不起来**。这条**此前在本仓库没有任何文档**，是这次 release 推 `v2.0.83` tag 时第一次实测撞到的——不是"忘了记的已知问题"，是这次调查才第一次确认它存在（根因是 `actions/checkout` 的上游已知 bug `actions/checkout#1467`，`@v4` 未修、`v6.0.2` 才修，但这一点本仓库同样此前没查过）。历史上一直靠"手动 `--ref master` 重跑"绕过——旧代码无条件打版本 tag，绕开 checkout 用 master 一样能打出正确版本号，这也正是这个 checkout bug 长期没被发现的原因。**修好坑 1 之后，`--ref master` 不再产出版本 tag（`enable=` 判断 `github.ref` 不是 tag ref），这条绕行路径也失效了**——两个坑叠在一起，一度让发布链路彻底打不出版本 tag。已修（`fetch-tags: true` 换成 `fetch-depth: 0`；**没有**加显式 `ref:`，验证过是冗余的；**没有**升级到 `actions/checkout@v6`，理由是跨大版本行为变化没法在无 runner 环境验证，`fetch-depth: 0` 已经在 `release.yml` 里对同样场景跑通过真实生产发布），有 `tests/unit/ci/docker-publish-checkout.test.ts` 锁住。**2026-08-01 发 `v2.0.88` 时首次在真实 tag ref 上验证了这个修复**：`gh workflow run docker-publish.yml --ref v2.0.88` 与 `release.yml -f tag=v2.0.88` 两条路径的 checkout 都干净通过，没有再报 `Cannot fetch both`。

**坑 3 —— tag push 事件基本不触发任何 workflow（已是常态，不是偶发）**：和前两个坑性质完全不同，**前两个是配置问题（改代码可修、可测试锁住），这个是事件层面的，没有代码守卫能防**。2026-08-01 一天内发 `v2.0.88` / `v2.0.89` / `v2.0.90` **三次，三次全部命中**：`git push origin vX.Y.Z` 返回成功，`git ls-remote --tags` 和 GitHub API 都确认 tag ref 真实存在且指向正确 commit，但 `Publish Docker Image` 和 `Release Electron App` **一个 run 对象都没创建**——不是排队、不是失败，是压根没有。

（这条最初记为「偶发」，是基于 `v2.0.88` 那一次。当天后续两次发布连续复现后改为「常态」——**不要因为它没有已知根因就假设它罕见**。**但 2026-08-03 发 `v2.0.95` 时它又自己触发了**（两条 push 触发的 run 被 concurrency 组自动取消），所以准确说法是**不可靠、时有时无**，既不能指望它触发、也不能断言它不触发。**根因仍未查明**——这正是操作口径必须是「无脑手动 dispatch」而不是「先看看触发没有」的原因：判断它这次会不会触发本身就是不可能的。）

排查排除的：不是 concurrency 吞掉（`release.yml` 没有 concurrency 组，同样没触发）；不是 workflow 被禁用或配置错（`gh workflow list --all` 全 active，触发条件都是 `tags: ["v*"]`）；不是平台整体故障（同一时间 master push 的 run 正常创建并跑完）。**根因未查明**，events API 连历史上成功触发的 tag 事件也查不到（有采样/延迟），证明不了任何事。

**绕行方案（已验证可用）**：手动 `gh workflow run <workflow> --ref vX.Y.Z`（或 `release.yml` 的 `-f tag=vX.Y.Z`），数秒内正常创建 run。注意这条路**依赖坑 2 已修**——`fetch-depth: 0` 之前，手动对 tag ref dispatch 会撞 checkout 报错，那时这条绕行也是死的。

**`workflow_dispatch` 不是可选装饰，是应对"GitHub 触发不可靠"这个已知事实的必需安全阀，任何被列为发布前必看的 workflow 都必须有它**：`ci-quality.yml`（`package-boundary` 门禁）2026-08-03 撞到过同一个形状——它当时没有 `workflow_dispatch`，一次纯文档 commit 的普通 master push（不是 tag，历史上这类 push 一直是秒级触发）迟迟没有触发它，而且**没有任何手段能手动补跑，只能干等或者带着一个没有远端 CI 确认的 commit 继续往前走**。已加上 `workflow_dispatch`，有 `tests/unit/ci/release-workflows-have-manual-dispatch.test.ts` 锁住 `docker-publish.yml`/`release.yml`/`ci-quality.yml` 三条都有这个安全阀——以后新增/修改发布相关 workflow 时别漏掉。

**操作口径（已从「异常处理」提升为标准发布步骤）**：推完 tag **直接手动 dispatch**，不用先等、也不用先确认有没有触发。理由不是「它一定不触发」（`v2.0.95` 就自己触发了），而是**触发与否不可预测、而多触发一次零代价**——等待只是拿 2 分钟去赌一件赌不赢的事。

```bash
git push origin vX.Y.Z
gh workflow run docker-publish.yml --ref vX.Y.Z
gh workflow run release.yml -f tag=vX.Y.Z
```

若哪天 tag push 自己触发了，会出现两组重复 run：`docker-publish.yml`/`release.yml` 现在都有按 ref 隔离的 concurrency 组，会自动处理掉重复的那个——但两者的处理方式不同，**不要用"都不会出错"这种笼统说法**。`docker-publish.yml` 是 `cancel-in-progress: true`，直接取消先起的那个，安全（被取消的是镜像构建，没构建完 = 没有镜像，天然幂等）。`release.yml` 是 `cancel-in-progress: false`（排队，不抢占），第二个触发要等第一个跑完才开始——这条**在加 concurrency 组之前**，2026-08-03 发 `v2.0.96` 时真实出过错：tag push 自己触发的一条和手动 dispatch 的一条并发跑（没有任何并发控制），两条抢同一个 `gh release create`，其中一条的 macOS arm64 job 在上传资产时报 `HTTP 404`（脚本自己的注释写了这个竞态，但没有真正兜住）。**不影响最终产物**——真正 checkout 了 tag ref 的那条完整上传了所有平台资产，用户看到的 release 没有缺东西，只是多了一条失败的 run 记录。加了 concurrency 组之后这类竞态不会再发生：两条会排队而不是并发抢同一个 release 对象。有 `tests/unit/ci/release-concurrency.test.ts` 锁住这个组必须按 ref 隔离、且 `cancel-in-progress` 必须是 `false` 不是 `true`（原因见该测试文件头部注释：这条 workflow 中途被取消会留下一个资产不全的公开 release，比"两条都跑完、其中一条竞态失败"更危险，不能照抄 `docker-publish.yml` 的配置）。

**不要删 tag 重推**（`v2.0.85` 那次的教训是 tag 拓扑一旦搞乱，收拾起来比原问题麻烦得多）。

**坑 4 —— `concurrency.group` 曾经是全局单一字符串，不同 ref 会互相打断**：`group: docker-publish`（不带任何 `github.ref` 插值）在 `cancel-in-progress: true` 下意味着**任意 master push（哪怕纯文档提交）都会取消掉正在跑的 tag 构建，反过来也一样**——group 不区分触发它的 ref，GitHub 眼里它们是"同一组"。2026-08-03 发 `v2.0.95` 时真实撞到：`gh workflow run docker-publish.yml --ref v2.0.95` 手动 dispatch 后，一次纯 CLAUDE.md 文档订正的 master push 触发了另一个 run，把正在跑的 v2.0.95 tag 构建 cancel 掉了——两次触发的 ref 完全不同（`refs/tags/v2.0.95` vs `refs/heads/master`），本不该互相排斥。

这条容易被误判为"只是要重跑一次"，但**真正的危害是没人注意到时版本 tag 的镜像压根没产出**：cancel 掉的是 tag 构建，顶掉它的那个 master-push run 会正常跑完，产出一个 `sha-<commit>` 镜像——如果没人去核对 tag 构建的最终状态，很容易把这个不相关的 `sha-<commit>` 镜像误当成要发布的版本部署上去，比 `v2.0.88` 那次（tag 被错误地重新指向了另一个 commit，但好歹还指向了*一个*镜像）更隐蔽，因为这次版本 tag 对应的镜像**完全不存在**。

已修（`group: docker-publish` 换成 `group: docker-publish-${{ github.ref }}`——不同 ref 各自隔离，同一 ref 重复触发仍然互相 cancel，这是期望行为），有 `tests/unit/ci/docker-publish-concurrency.test.ts` 锁住。

**这条和坑 3 是两个独立问题，容易混为一谈**：坑 3 说的是"tag push 事件本身触发不触发 workflow"，不可靠、时有时无、无法用代码守卫防；坑 4 说的是"一旦有两个 run 同时在跑（不管各自怎么触发的），它们会不会互相顶掉"，这条**能**用代码守卫防，已经修了。上面坑 3 那句"`v2.0.95` 时它又自己触发了（两条 push 触发的 run 被 concurrency 组自动取消）"记的就是这次坑 4 事故的前半段——tag push 确实触发了，只是触发之后被一个不相关的 master push 顶掉了。

## 部署顺序：镜像和 config 谁先谁后，搞反会停机

生产 `local.yaml` 里那些键**是显式写死的**，不吃代码里的默认值——所以「改了默认值就发版」这件事本身对生产零效果，必须同时改 yaml。但**两者的先后顺序不能随便**：

**新值可能超出旧镜像的 schema 上限。** `v2.0.94` 就是真例：新默认 `ttl_minutes: 10080`，而当时线上 `v2.0.93` 的 schema 是 `.max(24 * 60)` = 1440。先改 yaml 的话，**旧镜像启动时 schema 校验直接失败 → 容器起不来 → 被 `restart: unless-stopped` 拧成崩溃循环**（`v2.0.80` 那次的形状）。

```
部署： 1. 先换新镜像（新镜像能读旧值，正常起，只是没改善）
       2. 再改 yaml
       3. 重启

回滚： 1. 先把 yaml 改回旧镜像能接受的值
       2. 再回滚镜像
```

**判据是「新旧两个镜像的 schema 谁的约束更松」**，不是死记顺序：改配置前先确认目标值在**当前运行的那个镜像**的 schema 里合法，不合法就必须先换镜像。

**部署后必须验「配置真的生效」，不是「容器起来了」。** 这两件事在这种双写场景下经常不一致——容器可能带着旧配置健康运行。`v2.0.94` 用的硬证据是受鉴权的 `/admin/general-settings` 里的 `opaque_compact_state_capacity`（`capacity` / `maxBytes` 两个数），对不上就说明 yaml 没写对或没重启到位。**没有可读回配置的端点时，先加一个，别靠"应该生效了"。**

## 磁盘耗尽事故（2026-08-03，v2.0.97 部署期间）

**不是这次发版本身的问题**——`v2.0.97` 部署过程中发现 tencent1 主机根盘 100% 满，触发链条：

```
根盘满 → Node 原子写 local.yaml 时命中 ENOSPC → 文件被截断成 0 字节（配置全丢，包括
opaque compact 开关、日志设置等所有本地覆盖）→ 容器仍能用 schema 默认值正常启动、
健康检查仍 200 → 「服务正常」不等于「配置还在」，这两件事在这种场景下会脱钩
```

真实主因：`docker-publish.yml` 每次发布都产出新镜像，**部署流程里没有任何一步负责回收旧镜像**——24 份历史 codex-proxy 镜像堆了约 26.5GB，是这次满盘的主要贡献者。**这条目前是待办，不是已修复**：发布流程仍然只进不出。

恢复时踩到的坑，按发生顺序：

- **恢复配置前必须先确认磁盘有空间**，否则会命中同一个 ENOSPC，把刚写的内容再截断一次——这次是先跑 `docker image prune`（用户扩大授权到 `-a`，全程未碰 `--volumes`/`docker volume` 相关命令）腾出空间之后才写配置。
- **`docker cp` 落地文件是 `root:root`**，和 `local.yaml` 平时的 `node:node` 不一致——必须 `chown node:node`，否则很可能是下一个"看起来写了但读不到"的坑，这次是对比同级文件（`accounts.json` 等）主动发现并修正的，不是被提前告知的。
- **写完必须 `wc -c` 确认非 0 字节**，不能假设写成功——ENOSPC 截断的教训就是"文件存在"不等于"内容完整"。
- **`docker logs --since <T>` 是按 docker 收到日志行的时间过滤，不是按消息体里应用自己打的 `ts` 字段**——排查时如果不确认这一点，容易把上一次启动的残留日志行当成本次启动的证据，产生错误的排查方向。
- **恢复后必须验证`/admin/general-settings`（或同类受鉴权端点）的实际加载值，不能只看容器起来、`/health` 200 就收工**——这次真实发生过"配置文件内容正确、容器健康、但某个开关因为 YAML 嵌套层级写错（该在 `model:` 下的键被误写在顶层）而没有生效"，详见下一节。

### ★ 恢复本身是不完整的，而且不完整了大半天没人发现（2026-08-04）

**上面那份"恢复完成"的记录本身就是错的。** 恢复内容是凭一份 `sed -n '10,25p'` 的**局部切片**口述重建的，当成了全文，结果**漏了 4 个键**，生产就这么带着 schema 默认值跑了大半天：

| 键 | 事故前 | 恢复后（静默走默认） | 后果 |
|---|---|---|---|
| `auth.max_concurrent_per_account` | 30 | 3 | 单账号并发上限骤降，第 4 个并发请求直接 529 |
| `model.default` | `gpt-5.5` | `gpt-5.4`（实际生效 `gpt-5.2-codex`，见下节） | 不指定模型的请求打到一个**实测必然 400** 的模型 |
| `model.default_reasoning_effort` | `high` | `null` | 推理档位静默改变 |
| `model.system_prompt_strategy` | `developer_inline` | `instructions` | **改变发给上游的请求构造方式** |

**4 个里只有 1 个会报错**（529），另外 3 个完全静默。**是用户主动问"是不是你把配置弄丢了"才查出来的**，不是任何检查发现的。

**而事故前的完整备份从头到尾就在盘上，没人去看**：`/var/lib/docker/volumes/codex-proxy_codex_proxy_data/_data/local.yaml.bak-pre-2081`（560 字节，重建出来的只有 470 字节）。

硬性要求：

- **任何配置重建之后，必须拿一份已知良好的来源做「键结构逐条 diff」，不是「服务起来了就算好」。** 先在数据目录里找 `local.yaml.bak-*`（该目录历史上就有多份带时间戳的备份），没有备份再谈重建。
- **口述/转述配置内容时，必须先确认手上那份是全文还是切片。** 切片当全文是这次的直接原因。
- 读备份时注意 `local.yaml` 含 `proxy_api_key`（mode 600）——**只打印键名和缩进结构**（`sed -E "s/^([[:space:]]*[A-Za-z0-9_]+:).*/\1/"`），需要具体值时只 grep 目标那几行，不要整份 cat。

### ★ 配置有三个来源，不是一个；其中一份在持久卷里长期 shadow 镜像默认值

排查"配置为什么不是我以为的值"时，**先确认在看哪一份文件**：

```
/app/config/default.yaml   ← base（具名卷 codex_proxy_config，不是镜像里那份！）
        ↓ deepMerge(raw, loaded)      config-loader.ts:143-163，local 赢
/app/data/local.yaml       ← 覆盖层
```

容器里有**两份** `default.yaml`：`/defaults/default.yaml`（镜像自带，等于仓库 `config/default.yaml`，`Dockerfile:110` 的 `cp -r` 存的）和 `/app/config/default.yaml`（持久卷里的历史快照，**这份才被读**）。

**后果：仓库 `config/default.yaml` 里改的任何 schema 默认值，只要这台机器的卷不清空就永远不生效。** 2026-08-04 实测该卷里 `model.default` 还是 `gpt-5.2-codex`（仓库当时是 `gpt-5.4`），而这个模型在生产账号上**实测返回 400** `not supported when using Codex with a ChatGPT account`——一直被 `local.yaml` 的显式值压着才没暴露，事故把 `local.yaml` 抹了它才浮上来。

**不能简单删卷重建**：`update-checker.ts:100-111` 的 `syncDefaultConfigVersion` 会往这份文件里写 `client.app_version`/`build_number`/`chromium_version`。连带推论——**这个文件的 mtime 不能当作"有人手改过某个业务键"的证据**，很可能只是自动更新写版本号留下的（排查时差点因此把一个陈值误判成"比备份更晚的正确状态"）。

全量 diff 这个卷、确认还有多少字段卡在历史时间点，是未完成的待办。

### `mutateYaml` 无跨进程锁（潜在缺陷，单进程下不触发）

`src/utils/yaml-mutate.ts` 全文 29 行，读-改-写-rename **无任何锁**，且 `.tmp` 用固定名（`local.yaml.tmp`）所有调用方共用（7 个调用点：`settings.ts` 4 处、`ollama.ts`、`logs.ts`、`update-checker.ts`）。

单进程内是安全的（Node 同步 fs 不交错，实测复现不出丢数据），**跨进程/多副本才会出问题**。已知还有一个**绕过者**：compose 启动脚本用 js-yaml 直接重写 `proxy_api_key`/`trust_proxy`，它不会去拿任何锁。

**实测的失败模式和预期不一样，记实测的那个**：原本预期是"两份 tmp 互相覆盖 → 内容被搅拌成混合体"（静默损坏）。用 `child_process.fork` 起两个真进程跑红测，**第一轮就崩**，报的是 `ENOENT: rename '.../local.yaml.tmp' -> '.../local.yaml'`——一个进程 rename 走了共享的 tmp，另一个 rename 时目标已不存在。**是响亮的崩溃，不是静默损坏**，而且跨进程下极易复现。内容混合在理论上仍可能，但不是实际观测到的形态。

**这条修复的动机是代码审查发现的潜在缺陷，不是已确认复现的生产事故——不要在文档或 commit message 里把它写成"修复了配置丢失"。**

### 附：一次自造的假故障，以及戳破它的判据（2026-08-04）

排查上面那个锁问题的起因，是一次**被误报的"配置键自己消失了"**：PATCH 返回 `success:true`、复核显示 `developer_inline`，稍后却观察到该键从 `local.yaml` 里没了，容器 `RestartCount=0`。据此推断出"并发写入互相覆盖"，还写成了任务描述里的既定结论。

**三条独立证据把这个机制推翻了**：生产是单进程（`ps`/`/proc` 确认无 cluster worker）；`mutateYaml` 函数体内没有任何 `await`，Node run-to-completion 保证同进程两次调用不会交错（**写脚本真跑了一遍，复现不出来**）；访问日志显示事故窗口内只有一次写请求，其余 5 个写路径 90 分钟内零调用。

**真正戳破它的是一个物理矛盾**：报告同时声称「mtime 停在 00:47:04 没再变过」和「该键后来消失了」，而 00:47:04 那次写**正是把这个键加进去的那次**——同文件、同 mtime、内容不可能不同。顺着这个矛盾排查（`md5sum` + `docker inspect` 确认 `/app/data` 只有一个卷挂载、不存在第二条路径），结论是**这次压根没发生过键消失**，是把 PATCH 自己的响应体误当成了一次独立的复核、又把两次检查的先后顺序拼错了。

**留下来的判据，比这个假故障本身有用：**

- **PATCH 的响应体不是复核证据**——它是同一次请求的产物。要复核就另发一次 GET，或者直接读磁盘。
- **GET `/admin/*` 读的是内存 config，不是磁盘。** 想确认"真的落盘了"只能 `cat` 文件。
- **每次 Bash 调用是独立会话、SSH 远端也不留命令历史**，靠回忆重建"我当时按什么顺序跑了什么"极不可靠。**排查中的关键观测要当场记下命令和输出**，不要事后凭印象拼时间线。
- **遇到自相矛盾的证据链，先怀疑观测口径，不要先编机制。** 这次的教训是双向的：报告方拼错了时间线，而收到报告的一方（team-lead）没有核对矛盾就把推测写成了任务描述里的既定结论。

## 未知配置键被 Zod 静默丢弃

2026-08-03 磁盘事故恢复 `local.yaml` 时，`claude_code_opaque_compact_experimental`（及另外两个应属于 `model:` 的键）被误写在 YAML 顶层。`ConfigSchema`（`src/config-schema.ts`）对未知顶层键是**非 strict、静默丢弃**——后果是：

```
文件写了                          ✓
容器正常启动                      ✓
日志打印 "Merged local overrides" ✓
/health 返回 200                  ✓
——而该开关实际是关着的，没有任何报错或警告
```

**这类"看起来配置好了、实际没有、而且全绿"的失败模式本次已反复出现**（tsconfig 不覆盖 `tests/`、`ci-quality.yml` 长期没人看、测试文件不在 runner 范围、`release.yml` 并发组字面量匹配不检查语义、这次的 YAML 嵌套），根本原因都是"某处检查存在，但对真实错误没有约束力"——**这正是开头「总纲」那条判据要防的形状**。

**修复方向待定，不要在没有明确方案前直接改 schema**——`.strict()` 拒绝未知键最安全但可能让历史遗留的多余键导致生产直接起不来（比静默丢弃更严重的故障模式）；宽松解析 + 启动日志警告代价最小但可能没人看（`ci-quality.yml` 红了没人看是先例）；宽松解析 + 暴露在受鉴权端点供部署后核对，介于两者之间且可以写进发布验证清单。**在这几个方向之间做选择前，必须先搞清楚 Zod 对嵌套对象内部未知键的实际行为，以及能否做到"只在顶层 strict、内部宽松"**，再决定怎么改。

## 镜像内容核对：`.Id` 不能跨机直接比

`RepoDigests` 在 `docker load` 进来的镜像上是空的（那个字段只记录"从哪个 registry 引用拉的"）——**只在走 skopeo→tar→`docker load` 这条路径时才会遇到**，走 `docker pull` 拉的镜像 `RepoDigests` 是正常有值的。所以「按 tag 部署时核对 `RepoDigests`」这条老办法**是否失效取决于拉镜像走的哪条路径**，不是在这台机器上必然失效。

**拉 ghcr.io 镜像走哪条路径，判据是"当前能不能连上"，不是写死哪一条**：tencent1 的 ghcr.io 访问此前记录为必须代理，但**代理链路会变**——2026-08-03 发 `v2.0.95` 时实测 `docker pull` 直接走通了（docker daemon 级配置了 `HTTP_PROXY=http://127.0.0.1:7890`，这次这条链路是通的），没有走 skopeo。**这不代表 skopeo 那条路径过时了**，只代表当时环境是通的——两条路径都要留着，各自标清楚触发条件：

1. **优先尝试 `docker pull`（或 `docker pull --platform linux/amd64 <tag>`）**：如果直接成功，`RepoDigests` 会正常有值，用它核对即可，不需要走下面的 config digest 中立基准流程。
2. **若 `docker pull` 失败**（历史记录的失败模式是 TLS 握手失败/EOF，daemon 级代理当时不通）：回退到 skopeo 经 ai_xray 拉 tar → `docker load` → Portainer `pullImage=false`。这条路径下 `RepoDigests` 是空的，必须走下面的 config digest 中立基准流程核对。

走 skopeo 路径时的替代方案是核对 **config digest**，但 `2026-08-03` 发 `v2.0.94` 时连续踩了三个**同一家族**的坑——都是「表面数字对不上，内容其实一致」：

1. **arm64 vs amd64**：本机 Mac 直接 `docker pull` 拿到的是 arm64 变体，跟生产 amd64 天然不同。
2. **index digest ≠ 平台 manifest digest**：CI 产出和到处传的 `sha256:cca5d028…` 是**多架构 index** 的 digest，不是某个平台的。要比对必须先 `docker buildx imagetools inspect <index> --raw` 取出目标平台的 manifest digest。
3. **`.Id` 在不同存储后端语义不同**：containerd snapshotter 模式下 `.Id` 显示的是拉取用的 manifest digest；经典 overlay2 模式下 `.Id` 是镜像 **config JSON blob 自己的 sha256**。两者是完全不同的哈希，跨机直接比必然不等。

**可靠做法**——用 registry 侧的 config digest 作中立基准，不依赖任何一端的本地 docker：

```bash
# 1. 从 index 取目标平台的 manifest digest
docker buildx imagetools inspect ghcr.io/hangox/codex-proxy@<index-digest> --raw

# 2. 从该 manifest 取 config.digest（这是中立基准）
docker buildx imagetools inspect ghcr.io/hangox/codex-proxy@<amd64-manifest-digest> --raw

# 3. 生产上（overlay2）读 .Id，应与上一步的 config.digest 逐字符相同
ssh -p 10086 root@tencent.hangox.com \
  'docker inspect --format "{{.Id}}" ghcr.io/hangox/codex-proxy:sha-<commit>'
```

config JSON 里含 `rootfs.diff_ids`（全部层的 diff ID），**config digest 相同 = 层内容完全相同**，是内容寻址一路到底——**比 `RepoDigests` 更硬，不是降级替代**。

## 合成测试内容不得污染真实持久化状态

2026-08-02 跑「多代 compact 保真度测试」时真实发生：测试需要先埋几条**编造的**项目事实（内部代号、数据库端口、值班负责人、事故编号……），用 "Please remember these facts" 起手。**Claude Code 的项目记忆子系统把这些虚构数据当成真实项目事实写进了 `~/.claude/projects/<项目>/memory/`**，还更新了 `MEMORY.md` 索引——那是所有在本仓库工作的 agent 都会读的持久化记忆。

没造成后果（发现后 `trash` 删文件 + 摘索引 + `grep` 确认零残留），但**如果没被发现，以后每个会话都会把测试用的假数据当成真实项目知识来用**，而且看不出它是假的。

**硬性要求——任何需要伪造事实/数据的测试：**

1. **明确禁用记忆写入**：给被测会话的指令里写清"不要使用 memory 工具、不要写任何文件"。
2. **换到中立工作目录**跑，不要在本仓库目录内（项目记忆按目录路径分区，在仓库内跑就会写进本仓库的记忆）。
3. **测完 `grep` 验证**：拿伪造事实里最独特的那几个关键词去 `~/.claude/projects/*/memory/` 搜一遍，确认零命中才算收工。

这条对所有 agent 适用，不只是跑测试的那个。**判据是「这次测试会不会产生看起来像真事实的内容」，不是「我有没有主动去写记忆」**——污染是副作用，不是主动行为。
