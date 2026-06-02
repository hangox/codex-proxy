export type StreamCloseKind =
  | "client-abort"
  | "client-write-failed"
  | "upstream-error"
  | "upstream-premature";

const ERROR_NAMES: Readonly<Record<StreamCloseKind, string>> = {
  "client-abort": "StreamClientAbort",
  "client-write-failed": "StreamClientWriteFailed",
  "upstream-error": "StreamUpstreamError",
  "upstream-premature": "StreamUpstreamPrematureClose",
};

const BASE_MESSAGES: Readonly<Record<StreamCloseKind, string>> = {
  "client-abort": "Client closed stream before completion",
  "client-write-failed": "Client disconnected while proxy was writing stream",
  "upstream-error": "Upstream stream failed while proxying response",
  "upstream-premature": "Upstream WebSocket closed before terminal event",
};

const NAME_TO_KIND = new Map<string, StreamCloseKind>(
  Object.entries(ERROR_NAMES).map(([kind, name]) => [name, kind as StreamCloseKind]),
);

const WS_PREMATURE_DETAIL_RE = /\bWebSocket closed before terminal event: code=(\d+)(?:\s+reason=([^\n\r]+))?/;

function isStreamCloseKind(value: string | null): value is StreamCloseKind {
  return value === "client-abort" ||
    value === "client-write-failed" ||
    value === "upstream-error" ||
    value === "upstream-premature";
}

export function isUpstreamPrematureCloseDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && WS_PREMATURE_DETAIL_RE.test(detail);
}

export function extractStreamCloseCode(detail: string | null | undefined): number | null {
  if (typeof detail !== "string") return null;
  const match = detail.match(WS_PREMATURE_DETAIL_RE);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

export function streamCloseErrorName(kind: StreamCloseKind): string {
  return ERROR_NAMES[kind];
}

export function streamCloseMessage(
  kind: StreamCloseKind,
  detail?: string | null,
  closeCode?: number | null,
): string {
  if (kind === "upstream-premature") {
    const code = closeCode ?? extractStreamCloseCode(detail);
    if (code !== null) return `${BASE_MESSAGES[kind]} (code=${code})`;
    return detail ? `${BASE_MESSAGES[kind]}: ${detail}` : BASE_MESSAGES[kind];
  }
  const base = BASE_MESSAGES[kind];
  return detail ? `${base}: ${detail}` : base;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | null {
  const value = obj?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(obj: Record<string, unknown> | undefined, key: string): number | null {
  const value = obj?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function legacyMessageIsOnlyBase(kind: StreamCloseKind, message: string): boolean {
  return (kind === "client-abort" && message === "Client aborted stream") ||
    (kind === "client-write-failed" && message === "Client disconnected mid-stream (write failed)") ||
    (kind === "upstream-error" && message === "Upstream stream errored") ||
    (kind === "upstream-premature" && message === "Upstream stream closed before terminal event");
}

function alreadyFormattedMessage(kind: StreamCloseKind, message: string): string | null {
  const base = BASE_MESSAGES[kind];
  if (message === base || message.startsWith(`${base}: `) || message.startsWith(`${base} (`)) {
    return message;
  }
  return null;
}

export function normalizeStreamCloseErrorForDisplay(
  error: { name: string; message: string; stack?: string },
  context?: Record<string, unknown>,
): { name: string; message: string; stack?: string } {
  const contextKind = stringField(context, "kind");
  let kind = NAME_TO_KIND.get(error.name) ?? null;
  if (isStreamCloseKind(contextKind)) {
    kind = contextKind;
  }

  const detail = stringField(context, "detail") ?? error.message;
  if (kind === "upstream-error" && isUpstreamPrematureCloseDetail(detail)) {
    kind = "upstream-premature";
  }
  if (!kind) return error;
  const formattedMessage = alreadyFormattedMessage(kind, detail);
  if (formattedMessage !== null) {
    return {
      ...error,
      name: streamCloseErrorName(kind),
      message: formattedMessage,
    };
  }
  const normalizedDetail = legacyMessageIsOnlyBase(kind, detail) ? null : detail;

  return {
    ...error,
    name: streamCloseErrorName(kind),
    message: streamCloseMessage(kind, normalizedDetail, numberField(context, "closeCode")),
  };
}
