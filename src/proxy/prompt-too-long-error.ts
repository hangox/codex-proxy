export const PROMPT_TOO_LONG_MESSAGE = "Prompt is too long";

interface ParsedError {
  code?: string;
  type?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripCodexErrorPrefix(message: string): string {
  return message.replace(/^Codex API error \(\d+\):\s*/, "");
}

function parseErrorBody(raw: string): ParsedError {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const error = isRecord(parsed.error) ? parsed.error : parsed;
    const response = isRecord(parsed.response) ? parsed.response : null;
    const responseError = response && isRecord(response.error) ? response.error : null;
    const source = responseError ?? error;

    return {
      code: typeof source.code === "string" ? source.code : undefined,
      type: typeof source.type === "string" ? source.type : undefined,
      message:
        typeof source.message === "string"
          ? source.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : undefined,
    };
  } catch {
    return {};
  }
}

export function isPromptTooLongLike(input: string): boolean {
  const parsed = parseErrorBody(input);
  const haystack = [
    input,
    parsed.code,
    parsed.type,
    parsed.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

  return (
    haystack.includes("prompt is too long") ||
    haystack.includes("context_length_exceeded") ||
    haystack.includes("exceeds the context window") ||
    haystack.includes("exceeded the context window")
  );
}

export function normalizePromptTooLongMessage(input: string): string {
  const parsed = parseErrorBody(input);
  const detail = stripCodexErrorPrefix(parsed.message ?? input).trim();

  if (detail.toLowerCase().startsWith(PROMPT_TOO_LONG_MESSAGE.toLowerCase())) {
    return `${PROMPT_TOO_LONG_MESSAGE}${detail.slice(PROMPT_TOO_LONG_MESSAGE.length)}`;
  }

  return detail ? `${PROMPT_TOO_LONG_MESSAGE}: ${detail}` : PROMPT_TOO_LONG_MESSAGE;
}

export function promptTooLongStatus(status: number): number {
  return status >= 400 && status < 500 ? status : 400;
}

export function buildPromptTooLongErrorBody(input: string): string {
  return JSON.stringify({
    error: {
      type: "context_length_exceeded",
      code: "context_length_exceeded",
      message: normalizePromptTooLongMessage(input),
    },
  });
}
