function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 对 JSON 语义值做递归稳定序列化。
 *
 * 对象键按 UTF-16 码元顺序排序，数组顺序保持不变；字符串、数字、布尔值和
 * null 直接沿用 JSON.stringify 的表示。undefined 与 JSON.stringify 一致：
 * 对象属性省略，数组元素写成 null。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareKeys(left, right));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("canonicalJson only supports JSON-compatible values");
  }
  return serialized;
}
