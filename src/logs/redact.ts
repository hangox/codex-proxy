type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const SECRET_KEY_RE = /(authorization|x-api-key|api_key|apikey|token|refresh_token|access_token|cookie|set-cookie|session|secret)/i;

/**
 * 按 **key 名** 脱敏的字段。opaque compact 的敏感载荷不在原有 SECRET_KEY_RE
 * 里（它只覆盖凭据类字段名），因此这里单独列出。
 */
const OPAQUE_PAYLOAD_KEY_RE = /^(encrypted_content|preservedTail|opaque_output)$/i;

/**
 * 按 **值** 匹配的 opaque marker。
 *
 * 这是第二道防线：日志侧的主防线是路由层判定「这是 opaque 请求 → 不捕获
 * body」，但那依赖一串 if 判定正确。marker 一旦出现在任何字符串值里，
 * 无论它藏在哪个字段、来自哪条路径，这里都直接抹掉。
 */
const OPAQUE_MARKER_VALUE_RE = /codex-opaque-state:v\d+:[A-Za-z0-9_-]+/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactString(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

/** 值级脱敏：无论出现在哪个字段，marker 都不得原样落盘。 */
function redactOpaqueMarkers(value: string): string {
  return value.includes("codex-opaque-state:")
    ? value.replace(OPAQUE_MARKER_VALUE_RE, "codex-opaque-state:***")
    : value;
}

export function redactJson(value: unknown, depth = 0): JsonValue {
  if (depth > 6) return "***";
  if (value === null || value === undefined) return null;
  // 裸字符串此前原样返回，marker 因此可以从任意未知字段落盘。
  if (typeof value === "string") return redactOpaqueMarkers(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value)) {
      if (OPAQUE_PAYLOAD_KEY_RE.test(key)) {
        // opaque 载荷永远不入日志，长度也不暴露。
        out[key] = "***";
      } else if (SECRET_KEY_RE.test(key)) {
        if (typeof v === "string") out[key] = redactString(v);
        else out[key] = "***";
      } else if (key.toLowerCase() === "headers" && isRecord(v)) {
        const headersOut: Record<string, JsonValue> = {};
        for (const [hKey, hVal] of Object.entries(v)) {
          if (SECRET_KEY_RE.test(hKey)) {
            headersOut[hKey] = typeof hVal === "string" ? redactString(hVal) : "***";
          } else {
            headersOut[hKey] = redactJson(hVal, depth + 1);
          }
        }
        out[key] = headersOut;
      } else {
        out[key] = redactJson(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
