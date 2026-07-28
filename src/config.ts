import { resolve } from "path";
import { loadStaticModels } from "./models/model-store.js";
import { triggerImmediateRefresh } from "./models/model-fetcher.js";
import { getConfigDir, getDataDir } from "./paths.js";
import { ConfigSchema, FingerprintSchema } from "./config-schema.js";
import { loadYaml, loadMergedConfig, applyEnvOverrides } from "./config-loader.js";
import type { AppConfig, FingerprintConfig } from "./config-schema.js";

// Re-export schema, types, and constants so all existing importers keep working
export { ROTATION_STRATEGIES, ConfigSchema, FingerprintSchema } from "./config-schema.js";
export type { AppConfig, FingerprintConfig } from "./config-schema.js";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _config: AppConfig | null = null;
let _fingerprint: FingerprintConfig | null = null;
let _localOverrides: Record<string, unknown> | null = null;
let _compactBridgeDeprecationWarned = false;

// ---------------------------------------------------------------------------
// Load (first-call initialisation)
// ---------------------------------------------------------------------------

export function loadConfig(configDir?: string): AppConfig {
  if (_config) return _config;
  const { raw, local } = loadMergedConfig(configDir);
  applyEnvOverrides(raw, local);
  _localOverrides = local;
  _config = ConfigSchema.parse(raw);
  warnIfClaudeCodeCompactBridgeEnabled(_config);
  return _config;
}

/**
 * `model.claude_code_compact_bridge`（classic compact bridge）已随 Task #4
 * 移除：`messages.ts` 不再有任何读取点，这个字段现在是纯粹的死配置——不管
 * 设成什么值都不产生任何行为，只是暂时保留在 schema 里做一版兼容弃用，
 * 避免已有配置文件里显式写了这个键的部署直接解析失败。这里在每次真正解析
 * 出新配置（冷启动 `loadConfig` 与热重载 `reloadConfig`，Admin API 改配置
 * 最终也会走到 `reloadConfig`）之后检查一次，读到 `true` 就提示一句——运维
 * 不应该在毫无提示的情况下以为这个开关还在生效。
 *
 * ★ 只警告一次（进程生命周期内）：`loadConfig()` 有 `if (_config) return` 缓存，
 * 本来就只会真正解析一次，但 `reloadConfig()` 没有任何去重——只要这个字段
 * 还是 `true`，Admin API 每保存一次**任意**设置（改端口、改 model alias 都会
 * 触发 `reloadConfig`）都会再打一遍这条弃用警告，而运维目前也没有 UI 入口能
 * 清掉这个残留值（得手改 YAML）。不去重会刷屏，掩盖真正需要关注的新日志。
 */
function warnIfClaudeCodeCompactBridgeEnabled(config: AppConfig): void {
  if (config.model.claude_code_compact_bridge && !_compactBridgeDeprecationWarned) {
    _compactBridgeDeprecationWarned = true;
    console.warn(
      "[Config] model.claude_code_compact_bridge is deprecated and no longer has any effect " +
        "(classic compact bridge was removed; opaque compact is the only remaining compact path). " +
        "This key will be removed in a future release.",
    );
  }
}

export function loadFingerprint(configDir?: string): FingerprintConfig {
  if (_fingerprint) return _fingerprint;
  const dir = configDir ?? getConfigDir();
  const raw = loadYaml(resolve(dir, "fingerprint.yaml"));
  _fingerprint = FingerprintSchema.parse(raw);
  return _fingerprint;
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getConfig(): AppConfig {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}

export function getFingerprint(): FingerprintConfig {
  if (!_fingerprint) throw new Error("Fingerprint not loaded. Call loadFingerprint() first.");
  return _fingerprint;
}

/** Path to the local overlay config file (data/local.yaml). */
export function getLocalConfigPath(): string {
  return resolve(getDataDir(), "local.yaml");
}

/**
 * Check whether a config key was explicitly set in data/local.yaml.
 * Usage: hasLocalOverride("server", "host") → true if local.yaml contains server.host
 */
export function hasLocalOverride(...path: string[]): boolean {
  let obj: unknown = _localOverrides;
  for (const key of path) {
    if (obj === null || obj === undefined || typeof obj !== "object") return false;
    obj = (obj as Record<string, unknown>)[key];
  }
  return obj !== undefined;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export function mutateClientConfig(patch: Partial<AppConfig["client"]>): void {
  if (!_config) throw new Error("Config not loaded");
  Object.assign(_config.client, patch);
}

// ---------------------------------------------------------------------------
// Reload (hot-reload after self-update)
// ---------------------------------------------------------------------------

/** Reload config from disk (hot-reload after full-update).
 *  P1-5: Load to temp first, then swap atomically to avoid null window. */
export function reloadConfig(configDir?: string): AppConfig {
  const { raw, local } = loadMergedConfig(configDir);
  applyEnvOverrides(raw, local);
  _localOverrides = local;
  const fresh = ConfigSchema.parse(raw);
  _config = fresh;
  warnIfClaudeCodeCompactBridgeEnabled(_config);
  return _config;
}

/** Reload fingerprint from disk (hot-reload after full-update).
 *  P1-5: Load to temp first, then swap atomically. */
export function reloadFingerprint(configDir?: string): FingerprintConfig {
  const dir = configDir ?? getConfigDir();
  const raw = loadYaml(resolve(dir, "fingerprint.yaml"));
  const fresh = FingerprintSchema.parse(raw);
  _fingerprint = fresh;
  return _fingerprint;
}

/** Reload both config and fingerprint from disk, plus static models. */
export function reloadAllConfigs(configDir?: string): void {
  reloadConfig(configDir);
  reloadFingerprint(configDir);
  loadStaticModels(configDir);
  console.log("[Config] Hot-reloaded config, fingerprint, and models from disk");
  // Re-merge backend models so hot-reload doesn't wipe them for ~1h
  triggerImmediateRefresh();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test-only: replace the config singleton. Production code MUST NOT call this. */
export function setConfigForTesting(config: AppConfig): void {
  _config = config;
}

/** Test-only: reset config and fingerprint singletons. */
export function resetConfigForTesting(): void {
  _config = null;
  _fingerprint = null;
  _compactBridgeDeprecationWarned = false;
}
