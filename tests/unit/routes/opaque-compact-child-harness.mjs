/**
 * 真实子进程 harness —— 供持久化故障测试使用。
 *
 * 为什么需要独立进程：kill -9、OS advisory lock、WAL 崩溃恢复这三件事在
 * 同进程内**无法真实模拟**。把 store 置 null 只是丢引用，DB 连接和内核锁
 * 都还在，测出来的东西和线上崩溃没有关系。
 *
 * 用法：node harness.mjs <command> <dir> [payloadJson]
 * 各命令通过 stdout 输出单行 JSON 结果，便于父进程解析。
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// 注意：TypeScript 源码由父进程通过 `node --import tsx` 启动来加载，
// 与 vitest 使用同一份实现。

const ROOT = resolve(import.meta.dirname, "../../..");
const SRC = resolve(ROOT, "src/routes/shared");

const [command, dir, payloadJson] = process.argv.slice(2);
const payload = payloadJson ? JSON.parse(payloadJson) : {};

const runtime = await import(pathToFileURL(resolve(SRC, "opaque-compact-runtime.ts")).href);
const state = await import(pathToFileURL(resolve(SRC, "opaque-compact-state.ts")).href);
const keyringMod = await import(pathToFileURL(resolve(SRC, "opaque-compact-keyring.ts")).href);

// 密钥环位于 store 目录之外（生产硬性要求）；测试用 fixture 允许 bootstrap。
const KEYRING_FILE = payload.keyringFile ?? `${dir}-keys/keyring.json`;

const CONFIG = {
  enabled: true,
  ttlMinutes: payload.ttlMinutes ?? 30,
  capacity: payload.capacity ?? 128,
  maxBytes: payload.maxBytes ?? 64 * 1024 * 1024,
  directory: dir,
  keyringFile: KEYRING_FILE,
  allowKeyringBootstrap: true,
};

const OUTPUT = [
  { type: "reasoning", encrypted_content: "encrypted-content-canary-7a10", summary: [] },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "opaque-output-canary-c93e" }],
  },
];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function saveState(store, overrides = {}) {
  return store.save({
    output: OUTPUT,
    preservedTail: [
      { type: "function_call", call_id: "tool-1", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "tool-1", output: "preserved-tail-canary-2d64" },
    ],
    sessionId: payload.sessionId ?? "session-canary-8f2a",
    model: payload.model ?? "gpt-5.4",
    accountEntryId: payload.accountEntryId ?? "entry-canary-51bd",
    variantHash: payload.variantHash ?? "variant-canary-b7f3",
    expectedGeneration: payload.expectedGeneration ?? 0,
    predecessorStateId: payload.predecessorStateId ?? null,
    ...overrides,
  });
}

switch (command) {
  // 写入一条 state，报告 marker，然后**永远挂着等待被 SIGKILL**。
  // 父进程负责 kill，从而产生真实的崩溃现场（未关闭的 DB + 内核持有的锁）。
  case "save-and-hang": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    if (!handle.ready) {
      emit({ ok: false, reason: handle.reason });
      process.exit(1);
    }
    const saved = saveState(state.getOpaqueCompactStateStore());
    emit({ ok: true, marker: saved.marker, generation: saved.generation, pid: process.pid });
    setInterval(() => {}, 1000);
    break;
  }

  // 仅持有 store（含独占锁）并挂起，用于跨进程锁争用测试。
  case "hold-and-hang": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    emit({ ok: handle.ready, reason: handle.reason, pid: process.pid });
    if (!handle.ready) process.exit(1);
    setInterval(() => {}, 1000);
    break;
  }

  // 启动并尝试解析给定 marker，报告结果后退出。
  case "resolve": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    if (!handle.ready) {
      emit({ ok: false, ready: false, reason: handle.reason });
      process.exit(0);
    }
    try {
      const resolved = state.getOpaqueCompactStateStore().resolve({
        marker: payload.marker,
        sessionId: payload.sessionId ?? "session-canary-8f2a",
        model: payload.model ?? "gpt-5.4",
        variantHash: payload.variantHash ?? "variant-canary-b7f3",
        accountCandidates: payload.accountCandidates ?? ["entry-canary-51bd"],
      });
      emit({
        ok: true,
        ready: true,
        generation: resolved.generation,
        outputJson: JSON.stringify(resolved.output),
        preservedTailJson: JSON.stringify(resolved.preservedTail),
        accountEntryId: resolved.accountEntryId,
      });
    } catch (error) {
      emit({ ok: false, ready: true, reason: error?.reason ?? error?.message ?? "unknown" });
    }
    handle.close();
    break;
  }

  // 只报告 readiness，用于第二实例被拒的断言。
  case "probe-readiness": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    emit({ ok: true, ready: handle.ready, reason: handle.reason });
    handle.close();
    break;
  }

  // 并发 CAS。
  //
  // 注意：单实例锁决定了两个进程**不可能**同时持有同一个 store，所以这里的
  // 并发只能发生在一个进程内部——这也正是线上真实形态（同一实例并发处理两个
  // 请求）。两个竞争者各自先读到同一个 generation（barrier 前），再一起提交，
  // 从而真实竞争同一个 binding 的 CAS 事务。
  case "cas-race": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    if (!handle.ready) {
      emit({ ok: false, reason: handle.reason });
      process.exit(1);
    }
    const store = state.getOpaqueCompactStateStore();
    const common = {
      marker: payload.marker,
      sessionId: payload.sessionId ?? "session-canary-8f2a",
      model: payload.model ?? "gpt-5.4",
      variantHash: payload.variantHash ?? "variant-canary-b7f3",
      accountCandidates: payload.accountCandidates ?? ["entry-canary-51bd"],
    };

    // barrier：两个竞争者都完成读取之后才开始写，确保它们看到同一个 generation。
    const first = store.resolve(common);
    const second = store.resolve(common);
    if (first.generation !== second.generation) {
      emit({ ok: false, reason: "readers disagreed on generation" });
      process.exit(1);
    }
    emit({ ok: true, phase: "at-barrier", generation: first.generation });

    const attempt = (reader) => {
      try {
        const saved = saveState(store, {
          expectedGeneration: reader.generation,
          predecessorStateId: reader.stateId,
        });
        return { phase: "committed", generation: saved.generation, marker: saved.marker };
      } catch (error) {
        return { phase: "rejected", reason: error?.reason ?? error?.message ?? "unknown" };
      }
    };

    const results = [attempt(first), attempt(second)];
    emit({ ok: true, phase: "race-complete", results });
    handle.close();
    process.exit(0);
    break;
  }

  // 轮换 keyring（indexRoot 保持不变），报告新旧 keyId。
  case "rotate": {
    const result = keyringMod.rotateOpaqueCompactKeyring(KEYRING_FILE);
    emit({ ok: true, ...result });
    break;
  }

  // 保存后正常关闭，用于"干净重启"对照组。
  // 保存失败（例如故意用过期 generation 触发 stale_generation）也要以 JSON
  // 报告，而不是让异常冒泡——否则父进程只能看到崩溃栈，读不到失败原因。
  case "save-and-close": {
    const handle = runtime.startOpaqueCompactRuntime(CONFIG);
    if (!handle.ready) {
      emit({ ok: false, reason: handle.reason });
      process.exit(1);
    }
    try {
      const saved = saveState(state.getOpaqueCompactStateStore());
      emit({ ok: true, marker: saved.marker, generation: saved.generation });
    } catch (error) {
      emit({ ok: false, reason: error?.reason ?? error?.message ?? "unknown" });
    }
    handle.close();
    break;
  }

  default:
    emit({ ok: false, reason: `unknown command ${command}` });
    process.exit(1);
}
