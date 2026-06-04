import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { OpenAIErrorBody } from "../types/openai.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import { GEMINI_STATUS_MAP } from "../types/gemini.js";

function makeOpenAIError(
  message: string,
  type: string,
  code: string | null,
): OpenAIErrorBody {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

function makeAnthropicError(
  message: string,
  errorType: AnthropicErrorType,
): AnthropicErrorBody {
  return { type: "error", error: { type: errorType, message } };
}

interface GeminiErrorBody {
  error: { code: number; message: string; status: string };
}

function makeGeminiError(
  code: number,
  message: string,
  status: string,
): GeminiErrorBody {
  return { error: { code, message, status } };
}

export async function errorHandler(arg1: unknown, arg2: unknown): Promise<Response | void> {
  let err: unknown;
  let c: Context;
  let next: Next | undefined;

  if (arg1 && typeof arg1 === "object" && "req" in arg1) {
    c = arg1 as Context;
    next = arg2 as Next;
    try {
      await next();
      return;
    } catch (e) {
      err = e;
    }
  } else {
    err = arg1;
    c = arg2 as Context;
  }

  const isObj = typeof err === "object" && err !== null;
  const errName = isObj && "name" in err && typeof (err as any).name === "string" ? (err as any).name : "";
  const errMessage = isObj && "message" in err && typeof (err as any).message === "string" ? (err as any).message : String(err);
  const message = errMessage || "Internal server error";
  const stack = isObj && "stack" in err && typeof (err as any).stack === "string" ? (err as any).stack : undefined;
  console.error("[ErrorHandler]", stack ?? message);

  const status = isObj && "status" in err && typeof (err as any).status === "number" ? (err as any).status : undefined;

  const path = c.req.path;

  // Malformed JSON request body should be treated as a client error.
  const isSyntaxError = err instanceof SyntaxError || errName === "SyntaxError" || String(err).includes("SyntaxError");
  if (isSyntaxError && message.toLowerCase().includes("json")) {
    c.status(400);
    if (path.startsWith("/v1/messages")) {
      return c.json(
        makeAnthropicError("Malformed JSON request body", "invalid_request_error"),
      );
    }
    if (path.startsWith("/v1beta/")) {
      return c.json(
        makeGeminiError(400, "Malformed JSON request body", "INVALID_ARGUMENT"),
      );
    }
    return c.json(
      makeOpenAIError(
        "Malformed JSON request body",
        "invalid_request_error",
        "invalid_json",
      ),
    );
  }

  // Anthropic Messages API errors
  if (path.startsWith("/v1/messages")) {
    if (status === 401) {
      c.status(401);
      return c.json(
        makeAnthropicError(
          "Invalid or expired token. Please re-authenticate.",
          "authentication_error",
        ),
      );
    }
    if (status === 429) {
      c.status(429);
      return c.json(
        makeAnthropicError(
          "Rate limit exceeded. Please try again later.",
          "rate_limit_error",
        ),
      );
    }
    if (status && status >= 500) {
      c.status(502);
      return c.json(
        makeAnthropicError(`Upstream server error: ${message}`, "api_error"),
      );
    }
    c.status(500);
    return c.json(makeAnthropicError(message, "api_error"));
  }

  // Gemini API errors
  if (path.startsWith("/v1beta/")) {
    const code = status ?? 500;
    const geminiStatus = GEMINI_STATUS_MAP[code] ?? "INTERNAL";
    c.status((code >= 400 && code < 600 ? code : 500) as StatusCode);
    return c.json(makeGeminiError(code, message, geminiStatus));
  }

  // Default: OpenAI-format errors
  if (status === 401) {
    c.status(401);
    return c.json(
      makeOpenAIError(
        "Invalid or expired ChatGPT token. Please re-authenticate.",
        "invalid_request_error",
        "invalid_api_key",
      ),
    );
  }

  if (status === 429) {
    c.status(429);
    return c.json(
      makeOpenAIError(
        "Rate limit exceeded. Please try again later.",
        "rate_limit_error",
        "rate_limit_exceeded",
      ),
    );
  }

  if (status && status >= 500) {
    c.status(502);
    return c.json(
      makeOpenAIError(
        `Upstream server error: ${message}`,
        "server_error",
        "server_error",
      ),
    );
  }

  c.status(500);
  return c.json(
    makeOpenAIError(message, "server_error", "internal_error"),
  );
}

