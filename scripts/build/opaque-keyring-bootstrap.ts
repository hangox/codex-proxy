#!/usr/bin/env tsx
/**
 * 一次性引导 opaque compact 的外部主密钥环（`opaque_compact_state.keyring_file`）。
 *
 * ## 为什么这个脚本存在
 *
 * `9b2763a`（安全加固）把 keyring 从应用内部管理的路径移到运维显式配置的
 * 外部路径，并加了 `allowKeyringBootstrap` 这道闸门——`buildOpaqueCompactRuntimeConfig()`
 * （`index.ts`/`admin/settings.ts` 启动路径唯一共用的入口）**从未**把这个字段
 * 设成 `true`，所以正常服务器启动流程在任何真实场景下都不会自动生成 keyring。
 *
 * 这不是遗留的正确性漏洞——`firstInit`（sentinel 是否已经完整初始化过）本身
 * 已经足够防止"悄悄用一把新 key 顶替已有 state 的加密"：sentinel 严格按
 * `lock → sentinel → keyring → DB` 顺序两阶段提交，`firstInit=true` 时 DB 这一步
 * 在时间线上根本还没发生过，不可能有依赖这把 key 的密文已经落盘。`allowKeyringBootstrap`
 * 挡的是另一件事：**生成主密钥是不可逆操作，不该只靠一条今天看起来正确的逻辑
 * 推导就自动执行**——这是纵深防御，不是给 `firstInit` 打补丁。
 *
 * 也就是说，这道闸门本来就设计成"必须由人显式按下"，只是从没配一个真正的
 * 开关——生产环境目前的 keyring 是一次未记录的手动操作产生的。这个脚本就是
 * 那个从来没写出来的开关：**只做这一件事，一次性，不碰运行时配置本身**
 * （`allowKeyringBootstrap` 在真实服务器启动路径上依然、并将继续永远是
 * unreachable——这个脚本不通过那条路径，直接调用同一个底层函数）。
 *
 * ## 安全检查（都不依赖调用方按正确顺序操作）
 *
 * 1. **拒绝以 root 身份运行**：keyring 文件必须归运行服务进程的用户所有——
 *    `assertKeyringFileSafe`（`opaque-compact-keyring.ts`）在每次加载时都会
 *    校验 `stats.uid === process.getuid()`，root 创建的文件在容器 `gosu` 降权
 *    到 `node` 之后会被这条已有校验拒绝（不是本脚本新加的行为，是已有的加载
 *    时校验）——但那样会把发现问题的时间点推迟到下次启动，且报错信息不会
 *    指向"用错了身份"这个真正原因。这里提前到引导时就地拒绝，直接说明原因。
 * 2. **keyring 文件已存在 → 拒绝**：绝不覆盖，需要轮换请用 Admin 的 key
 *    rotation，不是这个脚本的职责。
 * 3. **sentinel 已 `ready` → 拒绝**：说明这个 store 之前已经完整初始化过，
 *    现在引导一把新 key 会让所有既有 state 永久不可解密。这是对"已有 state"
 *    的第二道独立确认，不单纯依赖调用方已经验证过 `firstInit`。
 * 4. **`--yes` 才真正写盘**：不带这个参数只做 dry-run，打印将要发生的事。
 *
 * ## 用法
 *
 *   npm run opaque:bootstrap-keyring -- --yes
 *   npm run opaque:bootstrap-keyring -- --keyring-file /app/opaque-keys/keyring.json --yes
 *
 * Docker 容器内：docker exec -u node <container> npm run opaque:bootstrap-keyring -- --yes
 * （不要用裸 `docker exec`——那默认是 root，会撞上上面第 1 条检查。）
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { getDataDir } from "../../src/paths.js";
import { loadOpaqueCompactKeyring } from "../../src/routes/shared/opaque-compact-keyring.js";
import { loadOpaqueCompactSentinel } from "../../src/routes/shared/opaque-compact-sentinel.js";
import {
  isOpaqueCompactKeyringFileInsideDataDir,
  resolveOpaqueCompactSentinelPath,
} from "../../src/routes/shared/opaque-compact-runtime.js";

const TAG = "opaque-keyring-bootstrap";

export function parseArgs(argv: string[]): { keyringFile: string | null; yes: boolean } {
  const flagIndex = argv.indexOf("--keyring-file");
  const keyringFile = flagIndex !== -1 && argv[flagIndex + 1] !== undefined
    ? argv[flagIndex + 1]!
    : null;
  return { keyringFile, yes: argv.includes("--yes") };
}

class BootstrapAbortError extends Error {}

function abort(message: string): never {
  throw new BootstrapAbortError(message);
}

/**
 * 核心逻辑，拆出来独立于 `main()` 是为了让测试能直接驱动它、断言每一条
 * 检查各自触发，而不必真的跑一次子进程。
 */
export function planBootstrap(options: {
  keyringFileArg: string | null;
  configuredKeyringFile: string | null | undefined;
  isRoot: boolean;
}): { keyringFile: string } {
  if (options.isRoot) {
    abort(
      "refusing to run as root — the keyring file must be owned by the same user the server " +
        "process runs as (assertKeyringFileSafe will reject a keyring not owned by the current " +
        "process uid on every future load). In Docker: `docker exec -u node <container> npm run " +
        "opaque:bootstrap-keyring -- --yes`. Bare metal: run this as whatever user runs `node dist/index.js`.",
    );
  }

  const keyringFile = options.keyringFileArg ?? options.configuredKeyringFile ?? null;
  if (!keyringFile) {
    abort(
      "no keyring file configured. Set opaque_compact_state.keyring_file in config, " +
        "or pass --keyring-file <path>.",
    );
  }

  if (isOpaqueCompactKeyringFileInsideDataDir(keyringFile)) {
    abort(`keyring_file must live outside the data directory (${getDataDir()}), got: ${keyringFile}`);
  }

  if (existsSync(keyringFile)) {
    abort(
      `keyring file already exists at ${keyringFile} — refusing to overwrite. ` +
        "If you intend to rotate keys, use the Admin key-rotation action, not this script.",
    );
  }

  const sentinelPath = resolveOpaqueCompactSentinelPath();
  const sentinel = loadOpaqueCompactSentinel(sentinelPath, { allowCreate: false });
  if (sentinel !== null && sentinel.ready) {
    abort(
      `this store already has persisted state (sentinel ready at ${sentinelPath}) — bootstrapping ` +
        "a fresh keyring now would make all of it permanently undecryptable. If the original keyring " +
        "was genuinely lost, that is a disaster-recovery decision with irreversible consequences, not " +
        "a routine bootstrap — do not proceed via this script.",
    );
  }

  return { keyringFile };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let plan: { keyringFile: string };
  try {
    plan = planBootstrap({
      keyringFileArg: args.keyringFile,
      configuredKeyringFile: config.opaque_compact_state.keyring_file,
      isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    });
  } catch (error) {
    if (error instanceof BootstrapAbortError) {
      console.error(`[${TAG}] ERROR: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  if (!args.yes) {
    console.log(`[${TAG}] Dry run — would create a new opaque compact master keyring at:`);
    console.log(`  ${plan.keyringFile}`);
    console.log(`[${TAG}] Re-run with --yes to actually create it.`);
    return;
  }

  loadOpaqueCompactKeyring({
    keyringFile: plan.keyringFile,
    allowCreate: true,
    stateTtlMs: config.opaque_compact_state.ttl_minutes * 60_000,
  });
  console.log(`[${TAG}] Created ${plan.keyringFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[${TAG}] Fatal:`, error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
