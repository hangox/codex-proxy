type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const SECRET_KEY_RE = /(authorization|x-api-key|api_key|apikey|token|refresh_token|access_token|cookie|set-cookie|session|secret)/i;

/**
 * 按 **key 名** 脱敏的字段。opaque compact 的敏感载荷不在原有 SECRET_KEY_RE
 * 里（它只覆盖凭据类字段名），因此这里单独列出。
 */
const OPAQUE_PAYLOAD_KEY_RE =
  /^(encrypted_content|preserved_tail|preservedTail|opaque_output|opaqueOutput)$/i;

/**
 * 按 **值** 匹配的 opaque marker。
 *
 * 这是第二道防线：日志侧的主防线是路由层判定「这是 opaque 请求 → 不捕获
 * body」，但那依赖一串 if 判定正确。marker 一旦出现在任何字符串值里，
 * 无论它藏在哪个字段、来自哪条路径，这里都直接抹掉。
 *
 * 注意匹配范围必须覆盖 **整个 token**（版本 + stateId + compHash + signature）。
 * 只匹配到第一个冒号段会把 marker 变成
 * `codex-opaque-state:***:<compHash>:<signature>` —— stateId 遮住了，
 * 但完整的 compHash 与 HMAC signature 仍原样落盘，等于没遮。
 * 因此这里贪婪吃掉后续所有 `:段`，并对畸形/截断前缀也一并处理。
 */
const OPAQUE_MARKER_VALUE_RE = /codex-opaque-state:[A-Za-z0-9_-]*(?::[A-Za-z0-9_-]*)*/g;

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

/** 自由文本写日志前的截断上限，见 {@link sanitizeFreeTextForLog}。 */
const FREE_TEXT_LOG_MAX_LEN = 300;

/**
 * 统一处理"来源不完全可信的自由文本"写日志前的脱敏——典型场景是上游 API
 * 返回的错误消息（如 `CodexApiError.message`，追踪链路见
 * `opaque-compact-fallback-log.ts` 头部注释）：它不是本应用生成的固定分类
 * 字符串，理论上不该带凭据，但也没有任何代码保证过这一点。
 *
 * 两层处理，缺一不可：
 * 1. marker 值级脱敏（复用 {@link redactOpaqueMarkers}）——防止 opaque
 *    marker 通过被上游回显或拼接进错误文本的方式落盘。
 * 2. 截断到有限长度——`redactJson` 只按 key 名/marker 值做模式匹配，
 *    对未知形态的敏感内容没有通用防护；截断至少把最坏情况的暴露面
 *    从"整段上游 body"收窄到一个有限窗口。
 *
 * 不是万能脱敏：如果自由文本里恰好混了一段既不是 marker、又在截断窗口内
 * 的敏感内容，这里不会拦住。这是已知取舍，不是遗漏。
 */
export function sanitizeFreeTextForLog(value: string, maxLen = FREE_TEXT_LOG_MAX_LEN): string {
  const scrubbed = redactOpaqueMarkers(value);
  if (scrubbed.length <= maxLen) return scrubbed;
  return `${scrubbed.slice(0, maxLen)}…(truncated, ${scrubbed.length} chars total)`;
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
