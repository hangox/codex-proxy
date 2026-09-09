/**
 * 上游正则引擎兼容性：Claude Code 内置 Artifact 工具的 JSON Schema 含
 * RE2 / 多数厂商校验器编译不了的正则，上游在收到请求那一刻就拒收整个请求
 * （不是参数不合法，是 schema 本身过不了校验）。
 *
 * 清洗逻辑见 `src/translation/shared-utils.ts` 的
 * `UNSUPPORTED_UPSTREAM_REGEX_TOKENS` / `sanitizeSchemaPatterns`。
 */

import { describe, it, expect } from "vitest";
import {
  injectAdditionalProperties,
  isUnsupportedUpstreamPattern,
  prepareSchema,
  sanitizeSchemaPatterns,
} from "@src/translation/shared-utils.js";
import {
  anthropicToolsToCodex,
  geminiToolsToCodex,
  openAIToolsToCodex,
} from "@src/translation/tool-format.js";

// ── 真实 Artifact 工具的 pattern 原文 ───────────────────────────
//
// 取自 Claude Code 2.1.266 二进制里 Artifact 工具三个参数的 `.regex(...)`
// 定义（`collection` / `doc_id` / `field`）：
//
//   collection → /^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}){0,14}$/
//   doc_id     → /^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}$/
//   field      → /^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$/u
//
// 生产环境拒收报文引用的正是 field 那条：
//   Invalid schema for function 'Artifact':
//     '^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$' is not a 'regex'.
const ARTIFACT_FIELD_PATTERN = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;
const ARTIFACT_DOC_ID_PATTERN = String.raw`^(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}$`;
const ARTIFACT_COLLECTION_PATTERN = String.raw`^(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}(?:/(?!\.\.?(?:/|$))[A-Za-z0-9_\-.~:@+]{1,200}){0,14}$`;

/** 上游引擎完全能编译的合法正则，用来验证"只删编译不了的"策略。 */
const SAFE_PATTERN = "^[a-z0-9_-]+$";

/** 工具级 description 是摘录改写（二进制里是按能力拼装的），不是原文。 */
const ARTIFACT_DESCRIPTION =
  "Create, update, read, and query Artifacts (self-contained HTML pages and their declared data).";

/**
 * Artifact 工具 `input_schema` 中涉及正则的那几个参数——`pattern` 与
 * `description` 均按 2.1.266 二进制原文照抄，另保留 maxLength / enum 等非正则
 * 字段，用来验证"只删 pattern"。整体结构是简化复刻（真实的 Artifact schema
 * 参数更多、条件拼装）。
 */
function artifactInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "list", "query", "set", "update", "delete", "str_replace"],
      },
      collection: {
        type: "string",
        maxLength: 1000,
        pattern: ARTIFACT_COLLECTION_PATTERN,
        description:
          'Database collection path: an odd number (1-15) of "/"-separated segments (letters, digits, _ - . ~ : @ + per segment). Paths alternate collection/document, so "boards/b1/columns" is a collection and, with `doc_id` "c2", names the document "boards/b1/columns/c2". Per-user data: "data/users/<id>" (3 segments) is the collection holding that user\'s documents, "data/users/<id>/decks" is one document in it, and "data/users/<id>/decks/cards" a collection under that; "me" as the <id> means the current user. Required for read_db and write_db.',
      },
      doc_id: {
        type: "string",
        pattern: ARTIFACT_DOC_ID_PATTERN,
        description:
          "Document id (one path segment). Required for db_op 'get', 'set', 'update', 'str_replace' and 'delete'; not accepted with 'list' or 'query'.",
      },
      field: {
        type: "string",
        pattern: ARTIFACT_FIELD_PATTERN,
        description:
          'write_db with db_op \'str_replace\' only: the top-level string field of the document to edit (one plain key, e.g. "html").',
      },
      query: {
        type: "object",
        properties: {
          where: {
            type: "array",
            items: {
              type: "array",
              prefixItems: [{ type: "string", pattern: ARTIFACT_FIELD_PATTERN }, { type: "string" }],
            },
          },
        },
      },
    },
    required: ["action"],
  };
}

/** 递归收集 schema 里所有 `pattern` 值。 */
function collectPatterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectPatterns(entry, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.pattern === "string") out.push(rec.pattern);
  for (const value of Object.values(rec)) collectPatterns(value, out);
  return out;
}

describe("Artifact 工具真实 schema（Anthropic 路径端到端）", () => {
  it("问题 pattern 全部被移除，schema 其余部分逐字不变", () => {
    const inputSchema = artifactInputSchema();
    const expected = structuredClone(inputSchema) as Record<string, unknown>;
    const expectedProps = expected.properties as Record<string, Record<string, unknown>>;
    delete expectedProps.collection.pattern;
    delete expectedProps.doc_id.pattern;
    delete expectedProps.field.pattern;
    // query.where.items.prefixItems[0].pattern
    const prefixItems = (expectedProps.query.properties as Record<string, Record<string, unknown>>)
      .where.items as Record<string, unknown>;
    delete ((prefixItems.prefixItems as Record<string, unknown>[])[0] as Record<string, unknown>)
      .pattern;

    const tools = anthropicToolsToCodex([
      { name: "Artifact", description: ARTIFACT_DESCRIPTION, input_schema: inputSchema },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "Artifact",
      description: ARTIFACT_DESCRIPTION,
      strict: false,
    });
    // 深度相等即"其余部分的值完全不变"（清洗只做 delete、不重排键序）
    expect(tools[0].parameters).toEqual(expected);
    expect(collectPatterns(tools[0].parameters)).toEqual([]);
    expect(JSON.stringify(tools[0].parameters)).not.toContain("(?!");
    expect(JSON.stringify(tools[0].parameters)).not.toContain("\\p{");
  });

  it("不注入 additionalProperties（这条路径的既有行为不能变）", () => {
    const tools = anthropicToolsToCodex([
      { name: "Artifact", input_schema: artifactInputSchema() },
    ]);
    const params = tools[0].parameters as Record<string, unknown>;
    expect(params).not.toHaveProperty("additionalProperties");
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.query).not.toHaveProperty("additionalProperties");
  });

  it("不修改调用方传入的 schema 对象", () => {
    const inputSchema = artifactInputSchema();
    const props = inputSchema.properties as Record<string, Record<string, unknown>>;
    anthropicToolsToCodex([{ name: "Artifact", input_schema: inputSchema }]);
    expect(props.field.pattern).toBe(ARTIFACT_FIELD_PATTERN);
    expect(props.doc_id.pattern).toBe(ARTIFACT_DOC_ID_PATTERN);
  });

  it("命中生产拒收报文里的那条 pattern", () => {
    expect(isUnsupportedUpstreamPattern(ARTIFACT_FIELD_PATTERN)).toBe(true);
    expect(isUnsupportedUpstreamPattern(ARTIFACT_COLLECTION_PATTERN)).toBe(true);
    expect(isUnsupportedUpstreamPattern(ARTIFACT_DOC_ID_PATTERN)).toBe(true);
  });
});

describe("清洗策略：整键删除编译不了的 pattern，不区分上游模型", () => {
  it("含前瞻 / Unicode 属性转义的 pattern 被删掉，同级其他字段保留", () => {
    const result = sanitizeSchemaPatterns({
      type: "object",
      properties: {
        a: { type: "string", pattern: ARTIFACT_FIELD_PATTERN, description: "d", minLength: 1 },
      },
    });
    const a = (result.properties as Record<string, Record<string, unknown>>).a;
    expect(a).toEqual({ type: "string", description: "d", minLength: 1 });
    expect(a).not.toHaveProperty("pattern");
  });

  it("合法 pattern 原样保留——只删上游引擎编译不了的构造", () => {
    // 取舍：不按上游模型区分（实测 claude-* / qwen / kimi-k3 能通过），因为
    // 清洗发生在路由之前、拿不到最终命中的上游，模型白名单也必然过时。代价
    // 只是"对本来能通过的上游也丢了这个约束"——但只丢编译不了的，能保留的
    // 仍然保留。
    const result = sanitizeSchemaPatterns({
      type: "object",
      properties: { a: { type: "string", pattern: SAFE_PATTERN } },
    });
    const a = (result.properties as Record<string, Record<string, unknown>>).a;
    expect(a.pattern).toBe(SAFE_PATTERN);
  });

  it("没有 pattern 的 schema 原样返回", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(sanitizeSchemaPatterns(schema)).toEqual(schema);
  });
});

describe("递归遍历：嵌套位置的问题 pattern 都会被清掉", () => {
  function schemaWithBadPatternsEverywhere(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        deep: {
          type: "object",
          properties: { leaf: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
        },
        arr: { type: "array", items: { type: "string", pattern: ARTIFACT_DOC_ID_PATTERN } },
        tup: {
          type: "array",
          prefixItems: [{ type: "string", pattern: ARTIFACT_COLLECTION_PATTERN }],
        },
        choice: {
          anyOf: [{ type: "string", pattern: ARTIFACT_FIELD_PATTERN }, { type: "number" }],
        },
        one: { oneOf: [{ type: "string", pattern: ARTIFACT_FIELD_PATTERN }] },
        all: { allOf: [{ type: "string", pattern: ARTIFACT_FIELD_PATTERN }] },
        cond: {
          if: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
          then: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
          else: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
          not: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
        },
        patterned: {
          type: "object",
          patternProperties: { [ARTIFACT_FIELD_PATTERN]: { type: "string" } },
        },
      },
      $defs: { Def: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
      definitions: { Legacy: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
    };
  }

  it("properties 深层 / items / prefixItems / anyOf / oneOf / allOf / if-then-else-not / $defs / definitions", () => {
    const result = sanitizeSchemaPatterns(schemaWithBadPatternsEverywhere());
    expect(collectPatterns(result)).toEqual([]);
  });

  it("保留结构：被清空的 patternProperties 仍在，$defs 条目仍在", () => {
    const result = sanitizeSchemaPatterns(schemaWithBadPatternsEverywhere());
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.patterned).toEqual({ type: "object", patternProperties: {} });
    expect(Object.keys(result.$defs as Record<string, unknown>)).toEqual(["Def"]);
    expect(Object.keys(result.definitions as Record<string, unknown>)).toEqual(["Legacy"]);
    expect(props.choice.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });
});

describe("扩展位置：既有遍历器从不进入、但值同样是 schema 的关键字", () => {
  function schemaWithBadPatternsInExtendedPositions(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        map: {
          type: "object",
          additionalProperties: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
        },
        names: {
          type: "object",
          propertyNames: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
        },
        list: {
          type: "array",
          contains: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
        },
        unevaluated: {
          type: "object",
          unevaluatedProperties: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
          unevaluatedItems: { type: "string", pattern: ARTIFACT_FIELD_PATTERN },
        },
        deps: {
          type: "object",
          dependentSchemas: { foo: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
        },
        tuple: {
          type: "array",
          items: [{ type: "string", pattern: ARTIFACT_FIELD_PATTERN }, { type: "number" }],
        },
      },
    };
  }

  it("additionalProperties / propertyNames / contains / unevaluated* / dependentSchemas / items 数组形式都被清到", () => {
    const result = sanitizeSchemaPatterns(schemaWithBadPatternsInExtendedPositions());
    expect(collectPatterns(result)).toEqual([]);
    // 结构保留：只删 pattern，节点本身还在
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.map.additionalProperties).toEqual({ type: "string" });
    expect(props.names.propertyNames).toEqual({ type: "string" });
    expect(props.list.contains).toEqual({ type: "string" });
    expect(props.tuple.items).toEqual([{ type: "string" }, { type: "number" }]);
    expect((props.deps.dependentSchemas as Record<string, unknown>).foo).toEqual({
      type: "string",
    });
  });

  it("下钻这些位置时只清 pattern，不注入 additionalProperties", () => {
    const result = sanitizeSchemaPatterns({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { inner: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
      },
    });
    const ap = result.additionalProperties as Record<string, unknown>;
    expect(ap).not.toHaveProperty("additionalProperties");
    expect((ap.properties as Record<string, Record<string, unknown>>).inner).toEqual({
      type: "string",
    });
  });

  it("prepareSchema 走扩展位置时同样只清 pattern（结构化输出的既有注入行为不变）", () => {
    const prepared = prepareSchema({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { a: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
      },
    });
    expect(collectPatterns(prepared.schema)).toEqual([]);
    expect(prepared.schema.additionalProperties).not.toHaveProperty("additionalProperties");
  });

  it("同一节点被正常位置与扩展位置共用时，注入行为与既有实现一致", () => {
    // 生产路径的 schema 都来自 JSON.parse（树形、不共用引用），这里防的是
    // 内存里手搓 schema 复用节点的情况：扩展下钻必须排在主遍历之后，否则该节点
    // 会先被 STRIP_PATTERNS_ONLY 访问、因 seen 命中而在正常位置跳过注入。
    const shared = {
      type: "object",
      properties: { z: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
    };
    const prepared = prepareSchema({
      type: "object",
      properties: { y: shared },
      additionalProperties: shared,
    });
    const y = (prepared.schema.properties as Record<string, Record<string, unknown>>).y;
    expect(y.additionalProperties).toBe(false);
    expect(collectPatterns(prepared.schema)).toEqual([]);
  });
});

describe("patternProperties 的键名本身就是正则", () => {
  it("键名含不支持构造时整个条目被删除", () => {
    const result = sanitizeSchemaPatterns({
      type: "object",
      patternProperties: {
        [ARTIFACT_FIELD_PATTERN]: { type: "string", description: "keep me?" },
      },
    });
    expect(result.patternProperties).toEqual({});
  });

  it("键名合法时条目保留，且其值仍会被递归遍历", () => {
    const result = sanitizeSchemaPatterns({
      type: "object",
      patternProperties: {
        [SAFE_PATTERN]: {
          type: "object",
          properties: { inner: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
        },
      },
    });
    const entry = (result.patternProperties as Record<string, Record<string, unknown>>)[SAFE_PATTERN];
    expect(entry.type).toBe("object");
    expect(collectPatterns(entry)).toEqual([]);
  });
});

describe("各条路径的接入", () => {
  it("prepareSchema 会清洗（结构化输出 schema 走这条）", () => {
    const prepared = prepareSchema({
      type: "object",
      properties: { a: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
    });
    expect(collectPatterns(prepared.schema)).toEqual([]);
    // 既有行为不变：仍然注入 additionalProperties
    expect(prepared.schema.additionalProperties).toBe(false);
  });

  it("injectAdditionalProperties 保持窄契约：只注入，不清 pattern", () => {
    const result = injectAdditionalProperties({
      type: "object",
      properties: { a: { type: "string", pattern: ARTIFACT_FIELD_PATTERN } },
    });
    expect(result.additionalProperties).toBe(false);
    expect(collectPatterns(result)).toEqual([ARTIFACT_FIELD_PATTERN]);
  });

  it("三条协议的工具参数路径都清洗", () => {
    const bad = { type: "string", pattern: ARTIFACT_FIELD_PATTERN };

    const anthropic = anthropicToolsToCodex([
      { name: "t", input_schema: { type: "object", properties: { a: bad } } },
    ]);
    const openai = openAIToolsToCodex([
      {
        type: "function",
        function: { name: "t", parameters: { type: "object", properties: { a: bad } } },
      },
    ]);
    const gemini = geminiToolsToCodex([
      { functionDeclarations: [{ name: "t", parameters: { type: "object", properties: { a: bad } } }] },
    ]);

    for (const tools of [anthropic, openai, gemini]) {
      expect(collectPatterns(tools[0].parameters)).toEqual([]);
      // 工具参数路径不注入 additionalProperties（既有行为）
      expect(tools[0].parameters).not.toHaveProperty("additionalProperties");
    }
  });
});
