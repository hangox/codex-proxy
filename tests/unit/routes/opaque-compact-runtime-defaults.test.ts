/**
 * ★ 8.20（生产事故复盘）：`buildOpaqueCompactRuntimeConfig` 的 `RUNTIME_DEFAULTS`
 * 和 `config-schema.ts` 的 `opaque_compact_state.ttl_minutes` 默认值必须
 * 保持同步（两处各自独立声明，没有共享同一个常量），这次把默认从
 * 720（12h）改成 10080（7 天）时最容易漏改的就是这两处里的一处——单独
 * 锁住这个函数自己的默认值，不依赖 `config-schema.test.ts` 那边间接覆盖
 * （那边测的是 Zod schema 的默认值，这里测的是运行时兜底逻辑，两者理论上
 * 可能各自漂移）。
 */

import { describe, it, expect } from "vitest";
import { buildOpaqueCompactRuntimeConfig } from "@src/routes/shared/opaque-compact-runtime.js";

describe("buildOpaqueCompactRuntimeConfig", () => {
  it("opaque_compact_state 段完全缺失时，ttlMinutes 兜底到 10080（7 天），不是旧的 720", () => {
    const result = buildOpaqueCompactRuntimeConfig({
      model: { claude_code_opaque_compact_experimental: true },
    });
    expect(result.ttlMinutes).toBe(10080);
    expect(result.capacity).toBe(1024);
    expect(result.maxBytes).toBe(64 * 1024 * 1024);
  });

  it("显式配置的 ttl_minutes 优先于默认值", () => {
    const result = buildOpaqueCompactRuntimeConfig({
      model: { claude_code_opaque_compact_experimental: true },
      opaque_compact_state: { ttl_minutes: 720 },
    });
    expect(result.ttlMinutes).toBe(720);
  });
});
