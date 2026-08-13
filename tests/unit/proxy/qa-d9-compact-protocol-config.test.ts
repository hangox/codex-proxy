/**
 * QA-D9：F14 新增的 compact_protocol 配置键必须「写了就真的生效、且能读回来」。
 *
 * 存在理由是 CLAUDE.md 记的那个坑：ConfigSchema 对未知键**非 strict、静默丢弃**
 * ——文件写了 ✓、容器起来了 ✓、日志打了 "Merged local overrides" ✓、/health 200 ✓，
 * 而那个开关实际是关着的，没有任何报错。这个仓库已经踩过两次
 * （claude_code_opaque_compact_experimental 的 YAML 嵌套、以及配置恢复漏键）。
 *
 * 所以新配置键至少要满足两条：
 *   D9a schema 认识它 —— parse 之后值还在，不是被悄悄吃掉
 *   D9b 受鉴权端点能读回实际生效值 —— 部署后有办法核对，不靠「应该生效了」
 */

import { describe, it, expect } from "vitest";
import { ConfigSchema } from "@src/config-schema.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";

/**
 * ConfigSchema 顶层 api/client/model 等段都是 required，`parse({})` 会因为
 * 缺段而失败 —— 直接拿空对象测会「因为不相干的原因」红/绿，是假证据。
 * （我第一版就踩了：QA-D9a3 一度"通过"，其实是 parse 因缺 api/client 抛的错，
 * 跟 compact_protocol 合不合法毫无关系。这里改成拿仓库真实的 default.yaml
 * 当基底，只覆盖要测的那个键。）
 */
function baseConfig(): Record<string, Record<string, unknown>> {
  return load(
    readFileSync(resolve(process.cwd(), "config/default.yaml"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
}

function parseWithModel(modelOverrides: Record<string, unknown>) {
  const base = baseConfig();
  return ConfigSchema.safeParse({
    ...base,
    model: { ...base.model, ...modelOverrides },
  });
}

describe("QA-D9 compact_protocol 配置键", () => {
  it("QA-D9-sanity 基底本身必须是合法配置（否则下面三条都是假证据）", () => {
    const r = ConfigSchema.safeParse(baseConfig());
    if (!r.success) console.log(`[QA-D9-sanity] 基底解析失败: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    expect(r.success).toBe(true);
  });

  it("QA-D9a ConfigSchema 认识 compact_protocol，parse 之后值不被静默丢弃", () => {
    const r = parseWithModel({ compact_protocol: "v1" });
    expect(r.success).toBe(true);
    const value = r.success
      ? (r.data as Record<string, Record<string, unknown>>).model.compact_protocol
      : undefined;
    console.log(`[QA-D9a] parse 后 model.compact_protocol = ${JSON.stringify(value)}`);
    // undefined = 被 Zod 静默吃掉了（本仓库踩过两次的那个坑）
    expect(value).toBe("v1");
  });

  it("QA-D9a2 默认值是 auto（不配的时候走纯 v2）", () => {
    const base = baseConfig();
    delete (base.model as Record<string, unknown>).compact_protocol;
    const r = ConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    const value = r.success
      ? (r.data as Record<string, Record<string, unknown>>).model.compact_protocol
      : undefined;
    console.log(`[QA-D9a2] 默认 compact_protocol = ${JSON.stringify(value)}`);
    expect(value).toBe("auto");
  });

  it("QA-D9a3 非法值必须被拒绝，且必须是因为 compact_protocol 本身而拒绝", () => {
    const r = parseWithModel({ compact_protocol: "v3" });
    expect(r.success).toBe(false);
    // 关键：确认拒绝的原因确实指向这个键，而不是别的段缺失
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    console.log(`[QA-D9a3] 拒绝原因路径 = ${JSON.stringify(paths)}`);
    expect(paths).toContain("model.compact_protocol");
  });

  it("QA-D9b /admin/general-settings 的 payload 里要带 compact_protocol", () => {
    // 直接读源码断言字段出现在响应体构造里 —— 这条只需要证明「读得回来」，
    // 起整个 app 反而把断言绕远了。
    const src = readFileSync(
      resolve(process.cwd(), "src/routes/admin/settings.ts"),
      "utf-8",
    );
    const getHandler = src.slice(
      src.indexOf('app.get("/admin/general-settings"'),
      src.indexOf('app.post("/admin/general-settings"'),
    );
    console.log(`[QA-D9b] GET handler 里是否出现 compact_protocol = ${getHandler.includes("compact_protocol")}`);
    expect(getHandler).toContain("compact_protocol");
  });
});
