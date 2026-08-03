import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig, getFingerprint } from "../../config.js";
import { getConfigDir, getDataDir, getBinDir, isEmbedded } from "../../paths.js";
import { getTransportInfo } from "../../tls/transport.js";
import { getProxyUrl } from "../../tls/proxy.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";
import { getOpaqueCompactStateReadiness } from "../shared/opaque-compact-state.js";
import { getProxyInfo } from "../../self-update.js";

export function createHealthRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  // ★ 部署时观察到：`/health` 不带版本号，运维只能看到"服务正常"，判断不了
  // 生产实际跑的是哪个版本——2026-08-03 发 v2.0.96 时真实撞到，team-lead
  // 从 `/health` 完全看不出跑的是 v2.0.95 还是 v2.0.96，只能等部署方口头
  // 报告。版本号不是新暴露面：Dashboard 页脚（登录后）和 GitHub release
  // 本来就公开显示同一个值，这里只是让匿名可读的健康检查端点也能直接
  // 确认，不需要登录 Dashboard 或询问部署方。
  // 只读一次（进程启动时），不是每次请求都读——`getProxyInfo()` 内部会
  // 跑 `git describe`/`git rev-parse` 两个子进程，版本号在进程生命周期内
  // 不会变化，`/health` 又是 Docker/nginx 高频轮询的端点，每次请求都 fork
  // 子进程是不必要的开销。
  const proxyInfo = getProxyInfo();

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const poolSummary = accountPool.getPoolSummary();
    const config = getConfig();
    return c.json({
      status: "ok",
      version: proxyInfo.version,
      authenticated,
      pool: { total: poolSummary.total, active: poolSummary.active },
      // opaque state readiness。reason 与 Admin、路由 409 三处同名同义，
      // 且只含封闭枚举值——不含 session/account/stateId/路径等可识别信息。
      // ★ 8.20（reviewer 复审发现）：容量字段（count/bytes/离上限多远）
      // **不放在这里**——`/health` 在 `dashboard-auth.ts` 的豁免名单里
      // 是刻意的（Docker/nginx 健康检查不能要求登录），生产经 nginx 对外
      // 暴露，这条路径因此是匿名可读的。容量数字不是凭据，但是运营信息
      // （活跃会话规模、离上限多远），理论上能给资源耗尽攻击做侦察，不该
      // 放在免鉴权端点上。挪到了 `GET /admin/compact-outcomes/capacity`
      // （受 `dashboardAuth` 中间件保护，和其它 Dashboard 数据端点同等
      // 待遇），`/health` 只保留原有的 readiness 布尔值。
      // ★ version 字段是这条注释写下之后唯一新增的字段——刻意只加这一个，
      // 不要顺手塞别的运营信息进来，见上面这条注释的教训。
      opaque_compact_state: {
        enabled: config.model.claude_code_opaque_compact_experimental,
        ...getOpaqueCompactStateReadiness(),
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (isProduction && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const config = getConfig();
    const fp = getFingerprint();

    const ua = fp.user_agent_template
      .replace("{version}", config.client.app_version)
      .replace("{platform}", config.client.platform)
      .replace("{arch}", config.client.arch);

    const promptsDir = resolve(getConfigDir(), "prompts");
    const prompts: Record<string, boolean> = {
      "desktop-context.md": existsSync(resolve(promptsDir, "desktop-context.md")),
      "title-generation.md": existsSync(resolve(promptsDir, "title-generation.md")),
      "pr-generation.md": existsSync(resolve(promptsDir, "pr-generation.md")),
      "automation-response.md": existsSync(resolve(promptsDir, "automation-response.md")),
    };

    let updateState = null;
    const statePath = resolve(getDataDir(), "update-state.json");
    if (existsSync(statePath)) {
      try {
        updateState = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    return c.json({
      headers: {
        "User-Agent": ua,
        originator: config.client.originator,
      },
      client: {
        app_version: config.client.app_version,
        build_number: config.client.build_number,
        platform: config.client.platform,
        arch: config.client.arch,
      },
      api: {
        base_url: config.api.base_url,
      },
      model: {
        default: config.model.default,
      },
      codex_fields: {
        developer_instructions: "loaded from config/prompts/desktop-context.md",
        approval_policy: "never",
        sandbox: "workspace-write",
        personality: null,
        ephemeral: null,
      },
      prompts_loaded: prompts,
      update_state: updateState,
    });
  });

  app.get("/debug/diagnostics", (c) => {
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (process.env.NODE_ENV === "production" && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const transport = getTransportInfo();
    const poolSummary = accountPool.getPoolSummary();

    return c.json({
      transport: {
        type: transport.type,
        initialized: transport.initialized,
        impersonate: transport.impersonate,
      },
      proxy: { url: getProxyUrl() },
      accounts: {
        total: poolSummary.total,
        active: poolSummary.active,
        authenticated: accountPool.isAuthenticated(),
      },
      paths: {
        bin: getBinDir(),
        config: getConfigDir(),
        data: getDataDir(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        embedded: isEmbedded(),
      },
    });
  });

  return app;
}
