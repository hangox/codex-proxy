/**
 * 生产事故（release 在全新预检环境里踩出的老 bug，opaque compact 上线起
 * 就存在）：`docker-entrypoint.sh` 只 chown 了 `/app/data`/`/app/config`，
 * 漏了 `/app/opaque-keys`。全新 docker 卷默认 `root:root`，`gosu node`
 * 降权后写不进 `keyring.json`，keyring 生成失败——但 `store.sentinel`
 * 建在 `/app/data/opaque-compact/`（node 可写，建成功了），于是运行时
 * 看到"sentinel 在、keyring 不在"，判定成状态损坏，fail-closed，报出
 * `OpaqueCompactKeyringError: opaque compact keyring is missing while
 * persisted state exists`——一个看起来像数据损坏、实际是权限问题的错误。
 *
 * **这个组合精确对应灾难恢复场景**：全新卷 + 降权用户，正是重建生产
 * 时会撞上的组合，而且是在最容易被误判成数据损坏的时间点。
 *
 * 这条测试防的不是这一个具体路径漏了，是"漏了同步"这个形状本身——
 * `docker-compose.yml` 的 `volumes:` 是这个仓库里"哪些 `/app/` 路径是
 * 独立挂载点、运行时需要 node 用户写入"的单一事实来源（Dockerfile 里
 * 没有任何 `VOLUME` 声明，compose 才是实际声明挂载点的地方）；
 * `docker-entrypoint.sh` 的 chown 列表必须覆盖它，且不能靠硬编码一份
 * 副本去对比（硬编码的副本下次同样会忘记更新）——所以这里从 compose
 * 文件本身解析出预期列表，而不是在测试里重新抄一遍路径。
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const ROOT = resolve(__dirname, "..", "..", "..");

function readCompose(): string {
  return readFileSync(resolve(ROOT, "docker-compose.yml"), "utf-8");
}

function readEntrypoint(): string {
  return readFileSync(resolve(ROOT, "docker-entrypoint.sh"), "utf-8");
}

/** 从 compose 的 `codex-proxy` 服务里解析出所有 `/app/` 容器侧挂载路径。
 *  只认字符串形式的 `host:container[:mode]` 短语法——这个仓库目前只用
 *  这种写法，没有长语法 volume 对象，出现了也不该被这条测试悄悄忽略。 */
function composeContainerVolumePaths(compose: string): string[] {
  const doc = yaml.load(compose) as {
    services?: Record<string, { volumes?: unknown[] }>;
  };
  const volumes = doc.services?.["codex-proxy"]?.volumes ?? [];
  const paths: string[] = [];
  for (const entry of volumes) {
    if (typeof entry !== "string") {
      throw new Error(
        `docker-compose.yml 的 codex-proxy.volumes 里出现了非字符串条目（长语法 volume 对象）：` +
          `${JSON.stringify(entry)}——这条测试只认字符串短语法，需要同步更新解析逻辑，不能悄悄跳过。`,
      );
    }
    const parts = entry.split(":");
    // "./opaque-keys:/app/opaque-keys" → ["./opaque-keys", "/app/opaque-keys"]
    // 也兼容 "...:/app/x:ro" 这种带 mode 后缀的写法。
    const containerPath = parts[1];
    if (containerPath?.startsWith("/app/")) paths.push(containerPath);
  }
  return paths;
}

/** 从 entrypoint 里解析 `CHOWN_TARGETS="..."` 声明的路径列表。 */
function entrypointChownTargets(entrypoint: string): string[] {
  const match = /CHOWN_TARGETS="([^"]*)"/.exec(entrypoint);
  expect(match, 'docker-entrypoint.sh 必须声明一个 CHOWN_TARGETS="..." 变量，这条测试依赖它解析出实际 chown 的路径列表').not.toBeNull();
  return match![1]!.split(/\s+/).filter(Boolean);
}

describe("docker-entrypoint.sh chown 覆盖 docker-compose.yml 声明的全部 /app/ 挂载点", () => {
  it("单一事实来源：compose 的 volumes 列表里每一个 /app/ 路径都在 entrypoint 的 chown 列表里", () => {
    const composePaths = composeContainerVolumePaths(readCompose());
    // 防止"意外扫空"——这条断言本身也要能感知到 compose 文件被改坏。
    expect(composePaths.length).toBeGreaterThanOrEqual(3);
    expect(composePaths).toContain("/app/data");
    expect(composePaths).toContain("/app/config");

    const chownTargets = entrypointChownTargets(readEntrypoint());
    for (const path of composePaths) {
      expect(
        chownTargets,
        `docker-entrypoint.sh 的 chown 列表缺少 compose 声明的挂载点 ${path}——` +
          `这正是 /app/opaque-keys 那次事故的形状：新增了卷、忘了同步 chown。`,
      ).toContain(path);
    }
  });

  it("真实事故回归锁：/app/opaque-keys 必须在 chown 列表里（此前从 opaque compact 上线起就一直缺失）", () => {
    expect(entrypointChownTargets(readEntrypoint())).toContain("/app/opaque-keys");
  });

  it("chown 失败不再静默吞掉——历史上问题能存在这么久，一部分原因是 2>/dev/null || true 把失败信号连同错误一起丢了", () => {
    const script = readEntrypoint();
    expect(script).not.toMatch(/chown[^\n]*2>\/dev\/null\s*\|\|\s*true/);
    expect(script).toMatch(/WARNING.*chown/i);
  });

  it("chown 失败仍然不是致命的——只读挂载等合法场景不该被这次改动变成崩容器", () => {
    const script = readEntrypoint();
    const chownIndex = script.indexOf("chown -R");
    const execIndex = script.indexOf("exec gosu");
    expect(chownIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(chownIndex);
    // set -e 开着：chown 失败要么在 if 条件位置（豁免 set -e），要么显式 || true，
    // 不能是一条会被 set -e 直接终止脚本的裸命令。
    expect(script).toMatch(/if\s*!\s*chown\s+-R\s+node:node/);
  });
});
