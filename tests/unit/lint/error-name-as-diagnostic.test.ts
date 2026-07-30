/**
 * lint 式回归守卫：禁止「把 `Error.name` 当诊断内容用，丢掉 `.message`」
 * 这个写法在生产代码里重新出现。
 *
 * 背景（这个模式在本仓库已经真实出现过三次，不是假设性风险）：
 *
 *   1. `opaque-compact-runtime.ts` 的 `fail()` 调用点——`detail` 曾经取
 *      `error instanceof Error ? error.name : "UnknownError"`。这批自定义
 *      Error 子类（`OpaqueCompactRepositoryError` 等）的 `.name` 在构造函数
 *      里硬编码成固定类名字符串，真正描述"具体出了什么错"的文本在
 *      `.message` 里——这个诊断字段因此从写下的第一天起就从未真正生效过，
 *      直到排查一起生产事故（`OpaqueCompactDenied x94`）时才被发现（已修，
 *      见 `7c807cc`）。
 *   2. `opaque-compact-quarantine.ts` 里 `quarantined.error` 也是同一个
 *      写法——`fs.mkdirSync`/`renameSync` 失败时 `.name` 对 Node 的
 *      `fs` 错误恒为常量 `"Error"`，真正含路径的描述在 `.message` 里，
 *      "刚好因为是常量所以不会泄漏路径"，但诊断价值同样是零。
 *   3. 更早还有一条"空转测试"——测一个被测函数根本不读的字段，从第一天起
 *      不可能失败。
 *
 * 共同形状：**代码在，行为不在**——不会报错、不会让测试变红，只有真出事
 * 去查日志时才发现手里什么都没有。这条测试就是防住这个形状本身重新出现，
 * 而不是重新描述某一次具体事故。
 *
 * 规则的精确边界（团队明确要求"不能误伤合法用法"）：只挡住
 * `X instanceof Error ? X.name : <fallback>` 这个三元表达式形状——**且**
 * 同一个 catch 子句作用域内，`X.message` 没有在任何地方被访问过。
 * `.name` 本身不是坏东西：
 *   - 用来做分类判断（`error.name === "XxxError"`）不会被挡；
 *   - 和 `.message` 拼在同一个模板字符串/表达式里（`` `${error.name}: ${error.message}` ``）
 *     不会被挡——真值分支不是"纯 `.name`"，规则天然不匹配；
 *   - 同一个 catch 块里分别捕获 `.name` 和 `.message`（哪怕存进两个不同
 *     变量）不会被挡——本仓库 `messages.ts`/`codex-compact-service.ts`
 *     里就有这种合法写法，规则必须放行它们。
 *
 * 这条规则**不是**"禁止一切单独出现的 `.name`"——那种更宽的规则做不到
 * 机械且不误伤（`.name` 用于分类判断、日志分组、错误类型路由都是正当用法，
 * 且分辨"这次访问是不是打算当成诊断内容"需要理解意图，不是语法能穷举的）。
 * 这里只挡已经在本仓库真实复发过两次的这一个具体形状：一个刻意把 Error
 * 归约成"只剩 `.name`、丢掉 `.message`"的三元表达式，且没有任何证据表明
 * 别处已经补上了 `.message`。
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `X instanceof Error` 形状（`X` 必须是裸标识符）命中时返回 `X` 的名字，否则 null。 */
function instanceofErrorIdentifier(node: ts.Expression): string | null {
  const expr = unwrapParens(node);
  if (!ts.isBinaryExpression(expr)) return null;
  if (expr.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return null;
  if (!ts.isIdentifier(expr.left)) return null;
  if (!ts.isIdentifier(expr.right) || expr.right.text !== "Error") return null;
  return expr.left.text;
}

/** `varName.name`（裸属性访问，不是模板字符串/拼接的一部分）命中时返回 true。 */
function isBarePropertyAccess(node: ts.Expression, varName: string, propName: string): boolean {
  const expr = unwrapParens(node);
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== varName) return false;
  return expr.name.text === propName;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/** 找三元表达式所在的最近作用域：优先 catch 子句（本仓库全部真实实例都在
 *  catch 块里），其次外层函数，兜底整个文件——范围越小，"同一个变量在附近
 *  访问过 .message" 这条判断就越准，越不容易被同名但无关的变量污染。 */
function findScopeNode(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCatchClause(current)) return current;
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function scopeAccessesMessage(scope: ts.Node, varName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === varName &&
      node.name.text === "message"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

export interface NameOnlyDiagnosticViolation {
  file: string;
  line: number;
  snippet: string;
}

/** 核心规则：见文件头文档。导出给下面"规则本身精确度"那组用例直接单测。 */
export function findNameOnlyDiagnosticViolations(content: string, filePath: string): NameOnlyDiagnosticViolation[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: NameOnlyDiagnosticViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node)) {
      const varName = instanceofErrorIdentifier(node.condition);
      if (varName !== null && isBarePropertyAccess(node.whenTrue, varName, "name")) {
        const scope = findScopeNode(node);
        if (!scopeAccessesMessage(scope, varName)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          violations.push({
            file: filePath,
            line: line + 1,
            snippet: node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 160),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path?: string }).path
      ?? dir;
    files.push(resolve(parent, entry.name));
  }
  return files;
}

describe("规则本身的精确度（红/绿验证：命中真实 bug 形状，不误伤已知的合法写法）", () => {
  it("命中：三元表达式只用 .name，同一个 catch 块里没有任何地方访问过 .message（第 2 处真实 bug —— opaque-compact-quarantine.ts 的最小复现）", () => {
    const src = `
      function quarantine() {
        try {
          doSomething();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.name : "mkdir failed" };
        }
      }
    `;
    const violations = findNameOnlyDiagnosticViolations(src, "inline.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.snippet).toContain("error.name");
  });

  it("命中：第 1 处真实 bug 的历史写法（已修复，这里锁住修复前的形状仍然会被抓到，防止有人改回去）", () => {
    const src = `
      function fail(reason) {
        try {
          start();
        } catch (error) {
          const detail = error instanceof Error ? error.name : "UnknownError";
          console.warn(detail);
        }
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(1);
  });

  it("不误伤：同一个 catch 块里分别捕获了 .name 和 .message（本仓库 messages.ts/codex-compact-service.ts 的真实合法写法）", () => {
    const src = `
      function handle() {
        try {
          run();
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          const errorMessage = error instanceof Error ? error.message : String(error);
          log(errorName, errorMessage);
        }
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(0);
  });

  it("不误伤：.name 和 .message 拼在同一个模板字符串里（opaque-compact-runtime.ts 修复后的真实写法）", () => {
    const src = `
      function start() {
        try {
          init();
        } catch (error) {
          const detail = error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
          record(detail);
        }
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(0);
  });

  it("不误伤：.name 只用来做分类判断（if 比较），根本不是三元诊断字段", () => {
    const src = `
      function classify(error) {
        if (error instanceof Error && error.name === "OpaqueCompactRepositoryError") {
          return "known";
        }
        return error instanceof Error ? error.constructor.name : "unknown";
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(0);
  });

  it("不误伤：三元表达式判断的是别的类型，不是 instanceof Error", () => {
    const src = `
      function pick(x) {
        return typeof x === "object" ? x.name : "fallback";
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(0);
  });

  it("命中多处：同一个文件里两条独立的 catch 块各自违规，各自单独计数（对应 opaque-compact-quarantine.ts 里 mkdirSync/renameSync 两处独立失败分支）", () => {
    const src = `
      function a() {
        try { x(); } catch (error) { return error instanceof Error ? error.name : "mkdir failed"; }
      }
      function b() {
        try { y(); } catch (error) { return error instanceof Error ? error.name : "rename failed"; }
      }
    `;
    expect(findNameOnlyDiagnosticViolations(src, "inline.ts")).toHaveLength(2);
  });
});

describe("lint 守卫：src/ 全量扫描零命中", () => {
  it("不存在任何「.name 当诊断内容、同一个 catch 块里没有 .message」的写法", () => {
    const files = listTsFiles(resolve(ROOT, "src"));
    expect(files.length).toBeGreaterThan(50); // 扫描本身没有意外扫空目录
    const violations = files.flatMap((file) => findNameOnlyDiagnosticViolations(readFileSync(file, "utf-8"), file));
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file.replace(`${ROOT}/`, "")}:${v.line} — ${v.snippet}`)
        .join("\n");
      throw new Error(
        `发现 ${violations.length} 处"把 Error.name 当诊断内容用、丢掉 .message"的写法，` +
          `这个模式在本仓库已经真实出过 bug（见文件头文档）：\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
