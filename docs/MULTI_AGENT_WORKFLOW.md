# 多 Agent 工作流

本文定义 Codex Proxy 项目在用户明确授权多 Agent，或任务明确要求该工作流时的协调、成本、权限和验收规则。普通任务不得默认加载本文，以免长期增加上下文成本。本文补充而不替代根 `AGENTS.md`、用户要求、版本化合同、开发/安全规则和 Git 纪律；发生冲突时采用更高权威或更严格的安全边界。

## 1. 目标与权威顺序

第一优化目标是在达到当前任务所需安全与验收阈值的前提下，减少整个任务的 token、产品 credits 和可归因费用。调度优先级为：

```text
最小不可妥协安全边界
→ 达到当前任务所需的验收阈值
→ 最小化全任务 token、credits 和可归因费用
→ 减少重复阅读、返工和上下文搬运
→ 缩短墙钟时间
```

质量以达到任务所需阈值为目标，不无限增加 Reviewer、Verifier 或高性能执行体。成本必须汇总 Coordinator、Explorer、Task Lead、Worker、Reviewer、Verifier、grader、重试、fallback、失败运行、上下文重读、冷启动和 Join，不能只比较最后一次成功调用。

权威顺序固定为：

```text
当前用户要求
→ 项目 AGENTS.md 和活跃状态/票据文档
→ 当前源码、版本化合同和真实工件
→ 架构与历史设计文档
→ Agent 摘要和聊天记忆
```

## 2. 项目开工审计

Coordinator 在分派前必须：

1. 读取根 `AGENTS.md`、存在的 `CLAUDE.md`、当前状态/票据、架构/开发文档及任务直接依赖。缺失文件要记录为缺失，不得虚构其约束。
2. 若根目录存在 `.codegraph/`，理解或定位代码时先用 CodeGraph；不存在时使用 `rg`/`rg --files` 和最小范围源码读取。
3. 检查 Git 分支、revision、暂存区、未提交和未跟踪文件，并识别当前唯一有界任务及停止条件。
4. 区分用户修改、其他任务修改和本任务允许修改；范围外修改不得回退、覆盖、格式化、暂存、提交或吸收。
5. 禁止 `git add -A`。未经用户明确要求，不 commit、不 push、不发布。
6. 能由权威文档确定的事项直接执行；只有缺失信息会实质改变结果时才询问用户。
7. 没有当前任务文档时，在会话中冻结 Task Capsule；除非用户要求，不为每个任务创建新票据。

本仓库共享工作树默认单写者。常用确定性门禁是聚焦 Vitest、必要时 `npm run build`、`git diff --check` 和目标路由的本地 mock/fixture 测试。`test:real`、供应商端点、用户提供的凭据、网络访问、桌面应用部署和其他外部副作用均需独立授权；成功构建不等于真实上游兼容性已验证。

## 3. Task Capsule

普通或复杂任务在调用实现 Agent 前冻结以下最小合同；不适用或不可观测项写 `NONE`、`unknown` 或 `false`，不得伪造为零：

```yaml
task_id: ""
objective: ""
non_goals: []

authority:
  instruction_files: []
  task_files: []
  source_revision: ""
  confirmed_facts: []
  hypothesis_to_falsify: ""

classification:
  semantic_difficulty: "LOW | MEDIUM | HIGH"
  change_breadth: "LOCAL | BOUNDED | CROSS_CUTTING"
  verifiability: "STRONG | PARTIAL | WEAK"
  failure_impact: "LOW | MEDIUM | HIGH"
  context_load: "SMALL | MEDIUM | LARGE"
  task_class: "S | M | L"

routing:
  coordinator_tier: "ECONOMY | BALANCED | STRONG"
  explorer_tier: "NONE | ECONOMY | BALANCED"
  task_lead_tier: "NONE | BALANCED | STRONG"
  worker_tier: "NONE | ECONOMY | BALANCED | STRONG"
  reviewer_tier: "NONE | ECONOMY | BALANCED | STRONG"
  verifier_tier: "NONE | ECONOMY | BALANCED | STRONG"
  critical_quality_node: ""
  routing_reason: ""
  strong_stage_budget: 0

ownership:
  owned_files: []
  read_only_files: []
  forbidden_files: []
  single_writer: true

permissions:
  may_write: false
  may_run_build: false
  may_use_network: false
  may_use_real_api: false
  may_commit: false
  may_push: false
  external_side_effects: []

cost_and_context_budget:
  max_concurrent_agents: 4
  max_agent_starts: 0
  max_retries: 1
  max_model_turns: ""
  max_cost_usd: 0
  native_credit_budget: "unknown"
  context_mode: "ephemeral | persistent | mixed"
  stable_context: []
  role_context: []
  forbidden_context: []
  expected_reuse: []
  delegation_reason: ""
  stop_on_budget: ""

acceptance:
  commands: []
  expected_results: []
  artifacts: []
  semantic_checks: []

stop_conditions: []
rollback: ""
```

`delegation_reason` 必须说明该 Agent 预计节省 token、重复阅读、返工或墙钟，或提供哪项必要的独立质量判断。无法说明时不启动。

## 4. 任务预分类

分派前从五个维度分类：

| 维度 | 低/局部/强 | 中/有界/部分 | 高/跨域/弱 |
|---|---|---|---|
| `semantic_difficulty` | `LOW`：规则明确、机械操作、简单检索或局部修改 | `MEDIUM`：普通代码理解、调试或有限设计判断 | `HIGH`：复杂根因、跨层语义、架构、身份、并发、状态、成本或合同推理 |
| `change_breadth` | `LOCAL`：单文件或单一局部模块 | `BOUNDED`：少量相关文件，边界明确 | `CROSS_CUTTING`：跨模块、共享合同或公共接口 |
| `verifiability` | `STRONG`：测试/schema/编译/静态检查可充分判断 | `PARTIAL`：机械检查只能证明一部分 | `WEAK`：主要依赖语义审查或缺少完整 oracle |
| `failure_impact` | `LOW`：易回滚且无外部副作用 | `MEDIUM`：可能回归、返工或局部数据问题 | `HIGH`：安全、权限、凭据、计费、生产、迁移、公共合同或不可逆结果 |
| `context_load` | `SMALL`：少量文件 | `MEDIUM`：一个代码族或若干历史决定 | `LARGE`：跨模块、长历史或多个证据域 |

文件多但规则机械不等于语义难度高；优先用低成本只读分区，不自动升级到高性能执行体。

任务等级：

- `S`：通常为 `LOW + LOCAL + STRONG + LOW`。Coordinator 或一个 ECONOMY Worker 完成，确定性验收通过即停止；默认无 Explorer、模型 Reviewer 或 STRONG。
- `M`：普通有界任务。可选 ECONOMY 扫描，BALANCED 单写实现，确定性测试，Coordinator 或 ECONOMY 验证。只有预分类已发现跨抽象层歧义、公共合同、部分验收或较高失败影响时，最多安排一个 STRONG 关键阶段。
- `L`：复杂或高后果任务。互不重叠的 ECONOMY 只读扫描，STRONG 冻结关键决策或 BALANCED Task Lead 承接清晰方案，BALANCED 单写实现，ECONOMY 机械门禁，再按剩余语义风险选择 BALANCED/STRONG Review。

## 5. 执行等级与初始路由

策略不写死模型、供应商或版本。运行时只在环境确实支持且已有能力证据时映射执行等级；不支持显式映射时，报告限制，并以角色范围、最小上下文和推理投入控制成本，不得假装已完成模型级路由。

- `ECONOMY`：目录/源码搜索、日志归纳、schema/fixture/JSON 检查、测试执行、证据整理、局部机械修改、强机械验收。默认 ephemeral 和简短结构化输出。
- `BALANCED`：普通实现、局部根因、少量跨文件修改、已有清晰合同的实现。预计一次实现加一次修复时可保留 persistent Worker，后续仅发送增量证据。
- `STRONG`：高歧义架构/合同、跨层复杂根因、机械测试不足的关键正确性、高后果方案预审或语义审查。只接收最小关键切片，不承担扫描、批量读取、测试运行或机械实现。

推荐路由：

```text
S: Coordinator 或 ECONOMY Worker → 确定性验收 → 停止
M: 可选 ECONOMY CAP_SCAN → BALANCED CAP_IMPLEMENT → 测试 → Coordinator/ECONOMY CAP_VERIFY → 停止
L: ECONOMY 互斥只读 CAP_SCAN → STRONG CAP_REASON 或 BALANCED Task Lead
   → BALANCED CAP_IMPLEMENT 单写者 → ECONOMY 门禁
   → BALANCED/STRONG CAP_REVIEW → Coordinator 放行
```

M 中 STRONG 默认只负责 `CAP_REASON` 或 `CAP_REVIEW` 之一。L 默认只允许一个 STRONG 关键阶段：最大不确定性在实现前时用于 Reason；方案清晰但测试不足时用于 Review。只有安全、权限、计费或不可逆迁移等高后果任务，才可同时使用 STRONG Reason 和 Review。

## 6. STRONG 预算、升级与降级

默认 STRONG 阶段预算：S 为 0；M 默认 0，存在明确关键语义节点时最多 1；L 默认 1；高后果 L 最多 2，分别用于 Decision 和 Review。每阶段只收最小证据包，产出可执行决定/finding 后立即降回 ECONOMY 或 BALANCED。不得让 STRONG 重跑测试、重做扫描、重写已正确且已验收的实现；预算用完后不追加“再看一遍”。

允许升级的新证据：

- 任务跨越未识别模块/合同；
- ECONOMY/BALANCED 结论冲突且无法机械裁决；
- 一次有证据的实现失败并暴露更深语义问题；
- Reviewer 发现阻塞性高严重度 finding；
- 确定性验收不足以判断关键正确性；
- 实际失败后果高于初始分类。

允许降级的新证据：

- STRONG 已冻结清晰方案；
- 根因已由测试/最小复现确定；
- 剩余仅搜索、fixture、测试或证据整理；
- persistent 历史膨胀，最小交接包更便宜；
- 原弱验收语义已转换为确定性测试。

不得仅因 Agent 不自信、仓库大、用户要求质量、任务是 L、更强执行体可用、想增加信心或单次测试失败而全员升级。默认最多一次有新证据的修复或升级；第二次扩大预算前请求用户决定。

## 7. Agent 启动门

每次启动前，Coordinator 必须能简洁回答：

1. Agent 负责哪个独立问题，为什么现有角色不能顺手完成？
2. 它只需读取哪些文件/行和哪些稳定上下文？
3. 输出由谁消费，失败是否仍产生可复用证据？
4. 预计节省 token、重复阅读、返工或墙钟中的哪一项？
5. 是否占用 STRONG 预算？

以下情况不启动：S 级机械任务；必须重读全部 Coordinator 上下文；无法独立分区；无输出消费者；调度/Join 成本高于工作；仅为形式；已有 persistent Worker 可继续；已达验收；预算不足以闭环。

## 8. 并发、所有权与状态

1. 默认并发总数不超过 4（含 Coordinator），递归深度 1。
2. 并发优先用于问题域、目录或证据互不重叠的只读扫描和独立核验。
3. 同一工作树、合同域、共享 schema、价格/策略配置和基准结论保持单写者。默认仅一个 Worker 可写；多 Worker 只在文件完全不重叠、产物隔离且指定唯一集成者时允许。
4. Reviewer/Verifier 默认只读。发现范围外修改返回 `CONFLICT`，不得回退、格式化、提交或吸收。
5. 子 Agent 的 completed 仅表示本次执行结束；只有 Coordinator 能声明最终完成。

Agent 必须用以下状态之一交接：

- `DONE_FOR_REVIEW`：授权工作完成，待审查/验证。
- `BLOCKED_CONTEXT`：缺少权威上下文。
- `TOOL_FAILURE`：工具/环境失败，结论未验证。
- `CONFLICT`：ownership 或工作树冲突。
- `CONTRACT_VIOLATION`：请求违反权限或门禁。
- `BUDGET_EXHAUSTED`：token、时间、费用或调用预算耗尽。
- `UNVERIFIED`：产物存在，但验收未闭合。

Reviewer 判断关键语义是否正确，Verifier 判断验收证据是否真实。低风险且机械门禁充分时，不为形式同时启动两者。

## 9. 上下文与缓存

1. 不默认复制完整聊天历史；支持选择 fork 范围时传最少必要 turns。
2. 扫描、日志、schema/fixture 使用 ephemeral；同一代码族的一次实现与一次修复可用 persistent Worker。
3. persistent 后续仅接收新增 finding、diff、失败日志和变化后的权威事实；历史膨胀后制作短小可核验交接包再新开执行体。
4. 并行 Explorer 的问题、目录或证据域必须互斥。输出只含结论、`file:line`、命令、退出码、工件身份和未决问题；长日志留本地，成功只给摘要，失败只给相关上下文。
5. 不要求冗长思维过程。

若底层支持 Prompt Cache，按以下稳定前缀组织：

```text
稳定公共规则
→ 稳定工具、schema 和输出合同
→ Task Capsule 不变部分
→ 角色专属指令
→ revision、finding、文件和本轮问题等动态内容
```

公共前缀不放时间戳、随机 ID、临时路径、完整 Git 状态或动态问题，并保持必要且精简。不假设缓存跨 Agent、模型、provider、线程或执行形态复用；只有可信 usage 明示 cached token 才报告命中，否则为 `unknown`。

## 10. 用量与费用

环境可观测时，对每个 Agent/attempt 记录：

```text
role, executor_tier, context_mode, attempt_id,
input_tokens, cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
total_tokens, usage_source, usage_completeness, wall_clock,
retry_or_fallback, actual_cost, accepted_contribution
```

规则：

1. 全部角色、重试、fallback、失败运行都计入总成本。
2. `reasoning_tokens` 若是 `output_tokens` 子项，不重复计费；流式只用最终 usage。
3. API 美元与产品 credits 分开；无实测换算不得合并。未知 token/价格/credits/cache 写 `unknown`，不得猜为 0。
4. 历史运行绑定当时价格版本；仅有同配置无缓存基线时才声明缓存净节省。
5. cache hit 高但任务失败、返工或噪声增加不算有效节省。
6. 无精确费用时，只比较可观测 token、轮次、Agent 启动数和重复阅读量，并标为代理指标。
7. 任务未接受时报告已消耗成本，不包装为成功 ROI。

## 11. 权限与不可妥协边界

多 Agent 授权不自动授权网络、真实/付费 API、凭据读取、外部系统写入、发布、push、不可逆迁移或破坏性操作。每项都必须来自用户当前任务的明确授权并记录进 Task Capsule。

不得以节省 token 为由绕过：

- 未授权的破坏性/不可逆操作或外部副作用；
- 未授权的真实 API、网络、发布或付费调用；
- Secret、凭据或受限正文泄露；
- 修改测试/fixture/expected 掩盖错误；
- 未运行验收却声称通过；
- 覆盖或回退用户及其他 Agent 修改；
- 伪造 token、费用、缓存、测试、baseline 或完成状态。

非关键优化、风格争议和额外重构默认延后。允许如实返回 `IMPLEMENTED_ONLY`、`UNVERIFIED` 或带已知限制的结果；预算耗尽即停止，不自动扩权或扩预算。

## 12. 验收、停止与最终报告

达到当前有界任务验收阈值或停止条件后立即停止，不自动进入下一票据。Coordinator 最终状态必须是：

- `ACCEPTED`：达到当前任务验收阈值。
- `IMPLEMENTED_ONLY`：实现存在但完整验收未闭合。
- `UNVERIFIED`：证据不足、工具失败或预算停止。
- `REJECTED`：Review 或关键验收发现阻塞问题。
- `UNRUN`：列出明确未运行的检查。

最终报告简洁区分并包含：

- 预分类五维结果和 S/M/L；
- 各角色初始等级、最低充分能力理由、实际启动/未启动候选；
- STRONG 关键节点、预算和实际阶段数，升级/降级及证据；
- 各角色 context mode、persistent 是否复用、如何避免重复读取；
- 修改文件、命令与退出结果、Review findings、Verify 证据；
- Agent 启动数、总轮次、重试数；
- 可观测 input/cached/cache-write/output/reasoning token；API 美元与 credits 分列；不可观测项为 `unknown`；
- 可比基线是否存在；不存在时不声明节省比例或 ROI；
- 已知限制、遗留风险、回滚方式、commit 状态、范围外文件和停止条件命中情况。

未经用户授权，最终报告必须明确“未提交”“未 push”。
