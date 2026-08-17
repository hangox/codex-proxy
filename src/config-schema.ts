import { z } from "zod";

export const ROTATION_STRATEGIES = ["least_used", "round_robin", "sticky"] as const;

// Note: discriminatedUnion does not accept ZodEffects branches, so the
// presence-of-secret-material checks are applied at the union level via
// superRefine rather than per-branch.
const OfficialAgentAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("capability_token"),
    token: z.string().trim().min(1).optional(),
    token_file: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("signed_bearer_token"),
    shared_secret: z.string().trim().min(1).optional(),
    shared_secret_file: z.string().trim().min(1).optional(),
    issuer: z.string().trim().min(1).default("codex-proxy"),
    audience: z.string().trim().min(1).default("codex-app-server"),
    subject: z.string().trim().min(1).default("codex-proxy"),
    ttl_seconds: z.number().int().min(30).max(3600).default(300),
  }),
]).superRefine((value, ctx) => {
  if (value.type === "capability_token" && !value.token && !value.token_file) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capability_token auth requires token or token_file",
      path: ["token"],
    });
  }
  if (value.type === "signed_bearer_token" && !value.shared_secret && !value.shared_secret_file) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "signed_bearer_token auth requires shared_secret or shared_secret_file",
      path: ["shared_secret"],
    });
  }
});

const CustomModelSchema = z.union([
  z.string().trim().min(1),
  z.object({
    id: z.string().trim().min(1),
    display_name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    supported_reasoning_efforts: z.array(z.string().trim().min(1)).optional(),
    default_reasoning_effort: z.string().trim().min(1).optional(),
    input_modalities: z.array(z.string().trim().min(1)).optional(),
    output_modalities: z.array(z.string().trim().min(1)).optional(),
    supports_personality: z.boolean().optional(),
    context_window: z.number().int().positive().optional(),
    max_context_window: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    truncation_policy_limit: z.number().int().positive().optional(),
  }),
]);

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

export const ConfigSchema = z.object({
  api: z.object({
    base_url: z.string().default("https://chatgpt.com/backend-api"),
    timeout_seconds: z.number().min(1).default(60),
  }),
  client: z.object({
    originator: z.string().default("Codex Desktop"),
    app_version: z.string().default("260202.0859"),
    build_number: z.string().default("517"),
    platform: z.string().default("darwin"),
    arch: z.string().default("arm64"),
    chromium_version: z.string().default("136"),
  }),
  model: z.object({
    default: z.string().default("gpt-5.6-sol"),
    /** Images generations 使用的 Codex 宿主模型；不能把 gpt-image-2 当作宿主模型。 */
    image_host_model: z.string().trim().min(1)
      .refine((model) => model.toLowerCase() !== "gpt-image-2", {
        message: "model.image_host_model must be a Codex chat model, not gpt-image-2",
      })
      .default("gpt-5.5"),
    default_reasoning_effort: z.string().nullable().default(null),
    default_service_tier: z.string().nullable().default(null),
    aliases: z.record(z.string(), z.string()).default({}),
    custom_models: z.array(CustomModelSchema).default([]),
    inject_desktop_context: z.boolean().default(false),
    suppress_desktop_directives: z.boolean().default(true),
    claude_code_compact_bridge: z.boolean().default(false),
    claude_code_opaque_compact_experimental: z.boolean().default(false),
    /** Opaque compact 每个上游模型的运行时预检预算覆盖。 */
    opaque_compact_token_budget_overrides: z.record(
      z.string().trim().min(1),
      z.number().int().min(1).max(1_000_000),
    ).default({}),
    allow_client_system_prompt_strategy: z.boolean().default(false),
    system_prompt_strategy: z
      .enum(["instructions", "developer_inline", "system_inline"])
      .default("instructions"),
    /**
     * 走哪个 Responses compaction 协议。这是上游回滚 / 出现旧客户端时**唯一
     * 不依赖任何猜测**的逃生舱：改一个配置键即可，不需要发版。
     *
     * - `auto`（默认）：纯 v2（/codex/responses + 末尾 compaction_trigger 哨兵），
     *   **没有任何自动回落**——不再从上游错误文案反推「v2 是不是不被支持」，
     *   那条判据被实测证明会把「请求构造错了」误判成「端点被下掉了」。
     * - `v1`：直接走 legacy 的 JSON /codex/responses/compact，不先试 v2。
     * - `v2`：同 auto。单独保留是为了让「我明确不要回落」可表达，也让 auto
     *   的语义将来可以演进而不破坏显式选择。
     *
     * ★ 不要和响应字段 `compaction_protocol` 搞混——**是两个东西，名字只差一个
     * "ion"，刻意不统一**：
     *
     * - 本键 `compact_protocol`（配置，输入）：**用哪个协议**。跟配置侧既有
     *   命名一致（`claude_code_compact_bridge`、
     *   `claude_code_opaque_compact_experimental` 一律用 `compact`）。
     * - `/v1/responses/compact` 响应里的 `compaction_protocol`（输出）：这份
     *   `output` **产出自哪个协议**，供外部调用方判别形状。跟官方 codex 协议
     *   术语一致（item type 就叫 `compaction`、哨兵叫 `compaction_trigger`）。
     *
     * 两侧各自都跟自己那边的惯例对齐，强行统一必然跟其中一侧冲突，所以保持
     * 现状、把区别写在这里。
     */
    compact_protocol: z.enum(["auto", "v1", "v2"]).default("auto"),
  }),
  auth: z.object({
    jwt_token: z.string().nullable().default(null),
    chatgpt_oauth: z.boolean().default(true),
    refresh_margin_seconds: z.number().min(0).default(300),
    refresh_enabled: z.boolean().default(true),
    refresh_concurrency: z.number().int().min(1).default(2),
    max_concurrent_per_account: z.number().int().min(1).nullable().default(3),
    request_interval_ms: z.number().int().min(0).nullable().default(50),
    rotation_strategy: z.enum(ROTATION_STRATEGIES).default("least_used"),
    /** Preferred plan-type ordering for account selection (e.g. ["plus","team","free"]). */
    tier_priority: z.array(z.string()).nullable().default(null),
    rate_limit_backoff_seconds: z.number().min(1).default(60),
    oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann"),
    oauth_auth_endpoint: z.string().default("https://auth.openai.com/oauth/authorize"),
    oauth_token_endpoint: z.string().default("https://auth.openai.com/oauth/token"),
  }),
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().min(1).max(65535).default(8080),
    proxy_api_key: z.string().nullable().default(null),
    trust_proxy: z.boolean().default(false),
    cors: z.array(z.string().trim().min(1).refine((val) => {
      // Strip scheme if present and validate it's a valid hostname
      const hostname = val.replace(/^https?:\/\//, '').trim();
      if (!hostname) return false;
      // Basic hostname validation - allow hostnames, IP addresses, and localhost
      return /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(hostname) ||
             /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
             hostname === "localhost";
    }, {
      message: "Invalid hostname format. Use bare hostnames like 'example.com' or '192.168.1.1'",
    })).default([]),
  }),
  logs: z.object({
    enabled: z.boolean().default(false),
    capacity: z.number().int().min(1).default(2000),
    capture_body: z.boolean().default(false),
    llm_only: z.boolean().default(true),
  }).default({}),
  // Local observability (no third-party SaaS). v1 ships a local
  // uncaught-error log; future iterations may add remote upload here.
  observability: z.object({
    local_error_log: z.boolean().default(true),
    max_log_bytes: z.number().int().min(1024).default(10 * 1024 * 1024),
    // 8.10：compact 快速压缩成功率统计（data/compact-outcomes.jsonl）用独立
    // 字节上限，不与 error-log.jsonl 共享额度——这个文件"每次尝试都记一条"，
    // 量级比"只记错误"大得多，共享额度会挤占错误日志的留存时间。复用
    // local_error_log 做总开关（同属本地可观测性），只有上限单独给。
    compact_outcomes_max_bytes: z.number().int().min(1024).default(5 * 1024 * 1024),
  }).default({}),
  usage_stats: z.object({
    /** How often to record local usage history snapshots. 0 disables history recording. */
    snapshot_interval_minutes: z.number().int().min(0).default(5),
    /** null means keep usage history forever. */
    history_retention_days: z.number().int().positive().nullable().default(null),
    /** Conversion rate for displaying Codex credits as USD on the dashboard.
     *  Default 25 matches the public rate card (1000 credits = $40 → $0.04/credit).
     *  Set to 0 to suppress USD rendering and only show raw credit numbers. */
    credits_per_usd: z.number().min(0).default(25),
  }).default({}),
  session: z.object({
    ttl_minutes: z.number().min(1).default(1440),
    cleanup_interval_minutes: z.number().min(1).default(5),
  }),
  tls: z.object({
    proxy_url: z.string().nullable().default(null),
    force_http11: z.boolean().default(false),
    health_check_url: z.string().default("https://api.ipify.org?format=json"),
  }).default({}),
  quota: z.object({
    refresh_interval_minutes: z.number().min(0).default(5),
    concurrency: z.number().int().min(1).default(10),
    warning_thresholds: z.object({
      primary: z.array(z.number().min(1).max(100)).default([80, 90]),
      secondary: z.array(z.number().min(1).max(100)).default([80, 90]),
    }).default({}),
    skip_exhausted: z.boolean().default(true),
  }).default({}),
  update: z.object({
    auto_update: z.boolean().default(true),
    auto_download: z.boolean().default(false),
    show_update_dialog: z.boolean().default(false),
    allow_prerelease: z.boolean().default(false),
  }).default({}),
  /** WebSocket connection pool — pins same (entryId, conversationId) to the
   *  same physical WS so the upstream LB keeps prompt cache warm across
   *  turns. See `src/proxy/ws-pool.ts` for the rationale. */
  ws_pool: z.object({
    enabled: z.boolean().default(true),
    /** Hard upper bound per connection. Server enforces a 60-min cap; we
     *  close 5 min early to avoid disrupting in-flight requests. */
    max_age_ms: z.number().int().positive().default(3_300_000),
    /** Cap on concurrent pooled connections per account, to bound memory
     *  when a user opens many parallel conversations. */
    max_per_account: z.number().int().positive().default(8),
  }).default({}),
  ollama: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().min(1).max(65535).default(11434),
    version: z.string().trim().min(1).max(64).default("0.18.3"),
    disable_vision: z.boolean().default(false),
  }).default({}),
  /** Optional bridge to official local `codex app-server` for Codex app plugins,
   * including the official Chrome/browser automation plugin. */
  official_agent: z.object({
    enabled: z.boolean().default(false),
    api_key: z.string().trim().min(1).nullable().default(null),
    app_server_url: z.string().trim().refine(isWebSocketUrl, {
      message: "app_server_url must be a ws:// or wss:// URL",
    }).default("ws://127.0.0.1:4500"),
    request_timeout_ms: z.number().int().min(1000).max(300000).default(30000),
    auth: OfficialAgentAuthSchema.default({ type: "none" }),
  }).default({}),
  /** Third-party API provider keys for multi-backend routing. */
  providers: z.object({
    openai: z.object({
      api_key: z.string(),
      base_url: z.string().default("https://api.openai.com/v1"),
    }).optional(),
    anthropic: z.object({
      api_key: z.string(),
      base_url: z.string().optional(),
    }).optional(),
    gemini: z.object({
      api_key: z.string(),
      base_url: z.string().optional(),
    }).optional(),
    /** OpenAI-compatible third-party providers (Groq, DeepSeek, Together, etc.). */
    custom: z.record(
      z.string(),
      z.object({
        api_key: z.string(),
        base_url: z.string(),
        models: z.array(z.string()).default([]),
      }),
    ).default({}),
  }).default({}),
  /** Explicit model → provider name routing table. */
  model_routing: z.record(z.string(), z.string()).default({}),
  /** Claude Code opaque compact state 的持久化参数。
   *  仅当 `model.claude_code_opaque_compact_experimental` 为 true 时才生效；
   *  功能关闭时不会创建数据库、密钥环或锁文件。 */
  opaque_compact_state: z.object({
    /** state 存活时长。previous 密钥的保留窗口至少覆盖它，
     *  这样密钥轮换不会让仍在有效期内的 marker 失效。
     *
     *  ★ 8.20（生产事故复盘）：默认值曾经是 12 小时（`24 * 60` 分钟）——
     *  真实容量上限由 `capacity`/`max_bytes` 的 LRU 淘汰兜底（见
     *  `opaque-compact-repository.ts` 的 `pruneWithinTransaction`，TTL 本身
     *  从不驱动批量删除，只在读取时做认证后的过期判定），TTL 因此不需要卡
     *  得很短。12 小时对"会话开着过夜、隔天接着干"这种正常使用场景必然
     *  踩中：state 过期后，会话里**每一次普通对话**都会被拒绝（族 A 分类，
     *  只在"这次请求本身就是压缩请求"时才自愈，见 `messages.ts` 的
     *  `treatAsNoMarker` 判定，不是压缩本身失败——★ #96：这条路径 `#91`
     *  之后是 400 而不是 409，客户端不会再静默重试，但语义没变：仍然是
     *  "这次普通对话被拒绝，用户看到报错"）。默认改成 7 天
     *  （`10080` 分钟），上限相应放宽到 30 天，给需要更长留存的部署留出
     *  配置空间；不改变淘汰机制本身。 */
    ttl_minutes: z.number().int().min(1).max(30 * 24 * 60).default(10080),
    /**
     * LRU 淘汰前保留的最大条目数。
     *
     * ★ 8.20（TTL 放长到 7 天之后的连带修正）：默认值曾经是 1024。
     * predecessor state 从不显式删除，只靠 LRU/TTL 自然回收（见
     * `opaque-compact-repository.ts` 文件头注释）——TTL 从 12h 放到 7 天
     * 意味着存量条数理论累积量差不多是原来的 14 倍，1024 在忙碌的多
     * teammate 团队场景下可能在 TTL 窗口内就被填满。
     *
     * 改成 4096，依据是团队给出的使用节奏**估算**（35~50 个并发会话 ×
     * 每天 compact 2~5 次 × 7 天 ≈ 700~1750 条/7天，取其上界 1750 的
     * 2.34 倍留余量）——★ 这个估算本身**没有实测依据**，是按团队描述的
     * 使用模式推算出来的上限，不是真实生产埋点量出来的数字。真实增长
     * 速率已经用 `tests/e2e/opaque-compact-state-capacity-growth.test.ts`
     * 实测过"每次 recompact 净增 1 条、顶到 capacity 后 LRU 优雅收敛、
     * 不会硬失败"这个**机制**，但没有也无法实测"一个真实团队每天到底
     * 产生多少条"——这需要真实生产流量，本次修复完全在本地环境完成。
     * ★ #96（reviewer 交叉审查发现的文档脱节）：暴露真实 count 的字段
     * 已经不在 `/health` 了——`8837b07` 把它挪到了受鉴权保护的
     * `GET /admin/general-settings`（字段名 `opaque_compact_state_capacity`），
     * 理由是 `/health` 匿名可读，容量/用量规模属于运营信息，不该放在
     * 免鉴权端点上。部署后观察几天即可拿到真实增速，届时可按实测数据
     * 再校准这个默认值，不用现在猜准。
     *
     * ★ #96：顶到这个上限的后果**不是**"纯 LRU 优雅收敛"——`#79` 把淘汰
     * 分成了两层（见 `opaque-compact-repository.ts` 的
     * `pruneWithinTransaction`）：优先淘汰结构上已确定是废代的记录（自己
     * 已有 successor），这一层为空时才退化成原来的全局 LRU（淘汰最久未用
     * 的记录）。多数情况下确实是优雅降级，压缩请求本身不受影响，但**不是
     * 恒定不会硬失败**——如果受保护的行数（这次写入 + 它的 predecessor，
     * 至少 2 行）本身就超过 `capacity` 或 `max_bytes` 预算，
     * `pruneWithinTransaction` 找不到可淘汰的 victim，会抛
     * `state_too_large` 让整个 save 事务回滚（见
     * `tests/e2e/opaque-compact-state-capacity-growth.test.ts` 的硬上限
     * 用例）。默认值 4096/`max_bytes` default 量级下这个分支基本不会撞上，
     * 但"淘汰算法本身有硬失败出口"这件事不该被这条注释掩盖成"纯粹优雅"。
     */
    capacity: z.number().int().min(1).max(10_000).default(4096),
    /**
     * 所有 state 密文的总字节预算。
     *
     * ★ 8.20：默认值曾经是 64MiB。和 `capacity` 一起改，理由是"配平"——
     * 单独提高 capacity 而不提高 max_bytes，一旦平均记录字节数超过
     * `max_bytes / capacity`，会变成字节预算先于条数触顶，capacity 那次
     * 改动就白改了。本地实测真实规模（贴近生产观测 postTokens 上限
     * 20646 的摘要文本）单条 `byte_size ≈ 48785` 字节（见
     * `tests/e2e/opaque-compact-state-byte-size.test.ts`）——`4096 ×
     * 48785 ≈ 190.6MB` 是配平要求的下限，真实记录大小会围绕这个均值
     * 波动，不是严格均匀分布，因此再加约 30% 余量 → 248MB，取整到
     * 256MiB（与旧默认值 64MiB 同为 2 的幂，风格一致）。
     */
    max_bytes: z.number().int().min(64 * 1024).default(256 * 1024 * 1024),
    /** 外部密钥环文件的绝对路径。
     *
     *  必须位于 data 目录之外：master key 与 state DB 同卷存放时，拿到数据卷
     *  或备份就同时拿到密文和钥匙，记录级加密提供不了 at-rest 隔离。
     *  未配置时 opaque 功能 fail-closed，且绝不自动生成密钥。 */
    keyring_file: z.string().trim().min(1).nullable().default(null),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const FingerprintSchema = z.object({
  user_agent_template: z.string(),
  auth_domains: z.array(z.string()),
  auth_domain_exclusions: z.array(z.string()),
  header_order: z.array(z.string()),
  default_headers: z.record(z.string()).optional().default({}),
});

export type FingerprintConfig = z.infer<typeof FingerprintSchema>;
