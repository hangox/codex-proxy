# CLAUDE.md

面向在本仓库工作的 Claude Code / AI agent 的强约束提醒。使用说明请看 `README.md`，贡献流程看 `.claude/skills/pr-push`。

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

前 3 项已固化成代码守卫，不要绕过：Dockerfile 内的 build-time 断言、`.github/workflows/ci-docker.yml` 的 smoke step、`tests/unit/ci/docker-node-runtime.test.ts`。新增任何"只在新版本 Node 存在"的内建模块依赖时，同步更新 `tests/unit/ci/docker-node-runtime.test.ts` 里的 `BUILTIN_MIN_NODE`。

## 发布链路的单点：只有 tag push 能产出「tag 真正指向的那个 commit」的镜像

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

**操作口径（已从「异常处理」提升为标准发布步骤）**：推完 tag **直接手动 dispatch**，不用先等、也不用先确认有没有触发。理由不是「它一定不触发」（`v2.0.95` 就自己触发了），而是**触发与否不可预测、而多触发一次零代价**——等待只是拿 2 分钟去赌一件赌不赢的事。

```bash
git push origin vX.Y.Z
gh workflow run docker-publish.yml --ref vX.Y.Z
gh workflow run release.yml -f tag=vX.Y.Z
```

若哪天 tag push 自己触发了，会出现两组重复 run，`docker-publish.yml` 有 concurrency 组会自动取消先起的那个，`release.yml` 重复跑一次只是浪费 CI 时间，**都不会产出错误结果**——所以无脑手动触发是安全的。

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
