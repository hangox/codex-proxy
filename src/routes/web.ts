import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AccountPool } from "../auth/account-pool.js";
import { getConfig, getFingerprint } from "../config.js";
import { getPublicDir, getDesktopPublicDir, getConfigDir, getDataDir } from "../paths.js";

export function createWebRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  const publicDir = getPublicDir();
  const desktopPublicDir = getDesktopPublicDir();

  // Serve Vite build assets (web)
  app.use("/assets/*", serveStatic({ root: publicDir }));

  app.get("/", (c) => {
    try {
      const html = readFileSync(resolve(publicDir, "index.html"), "utf-8");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read HTML file: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>UI files not found. Run 'npm/pnpm/bun run build:web' first. The API is still available at /v1/chat/completions</p>");
    }
  });

  // Desktop UI — served at /desktop for Electron
  // Vite builds with base: "/desktop/" so request paths are /desktop/assets/...
  // but files live at public-desktop/assets/..., so strip the /desktop prefix
  app.use("/desktop/assets/*", serveStatic({
    root: desktopPublicDir,
    rewriteRequestPath: (path) => path.replace(/^\/desktop/, ""),
  }));

  app.get("/desktop", (c) => {
    try {
      const html = readFileSync(resolve(desktopPublicDir, "index.html"), "utf-8");
      return c.html(html);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Web] Failed to read desktop HTML: ${msg}`);
      return c.html("<h1>Codex Proxy</h1><p>Desktop UI files not found. Run 'npm run build:desktop' first.</p>");
    }
  });

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const poolSummary = accountPool.getPoolSummary();
    return c.json({
      status: "ok",
      authenticated,
      pool: { total: poolSummary.total, active: poolSummary.active },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    // Only allow in development or from localhost
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "";
    const isLocalhost = remoteAddr === "" || remoteAddr === "127.0.0.1" || remoteAddr === "::1";
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

    // Check for update state
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

  return app;
}
