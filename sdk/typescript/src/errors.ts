/** Error codes the SDK assigns when the failure did not come from an HTTP error body. */
export const CLIENT_ERROR_CODES = Object.freeze({
  network: "network_error",
  timeout: "timeout",
  aborted: "aborted",
  invalidResponse: "invalid_response",
  streamError: "stream_error",
  streamConsumed: "stream_consumed",
  redirectRefused: "redirect_refused",
});

export interface OmniRouteErrorInit {
  message: string;
  /** HTTP status, or 0 when no HTTP response was received (network error, timeout, abort). */
  status: number;
  code?: string | undefined;
  type?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
  retryAfterMs?: number | undefined;
  body?: unknown;
  cause?: unknown;
}

/** The single error type raised by every SDK call. */
export class OmniRouteError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly body: unknown;

  constructor(init: OmniRouteErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "OmniRouteError";
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.reason = init.reason;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.body = init.body;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

export function parseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when the header is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Builds an error from a decoded error body. Understands both server envelopes:
 * `{ error: { message, type, code, reason } }` and `{ error: "text" }`, plus the
 * management `{ error: {...}, requestId }` variant.
 */
export function errorFromBody(
  status: number,
  body: unknown,
  requestId: string,
  retryAfterMs?: number
): OmniRouteError {
  let message: string | undefined;
  let type: string | undefined;
  let code: string | undefined;
  let reason: string | undefined;
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === "string" && error.length > 0) {
      message = error;
    } else if (isRecord(error)) {
      message = optionalString(error.message);
      type = optionalString(error.type);
      code = optionalString(error.code);
      reason = optionalString(error.reason);
    }
    message ??= optionalString(body.message);
  }
  return new OmniRouteError({
    status,
    message: message ?? `HTTP ${status}`,
    type,
    code,
    reason,
    requestId,
    retryAfterMs,
    body,
  });
}

export function errorFromHttpResponse(
  status: number,
  text: string,
  headers: Headers,
  clientRequestId: string,
  retryAfterMs: number | undefined
): OmniRouteError {
  const parsed = parseJson(text);
  const body = parsed.ok ? parsed.value : text.length > 0 ? text : undefined;
  const bodyRequestId = isRecord(body) ? optionalString(body.requestId) : undefined;
  const requestId = headers.get("x-request-id") ?? bodyRequestId ?? clientRequestId;
  return errorFromBody(status, body, requestId, retryAfterMs);
}

export function abortedError(requestId: string, cause?: unknown): OmniRouteError {
  return new OmniRouteError({
    status: 0,
    code: CLIENT_ERROR_CODES.aborted,
    type: CLIENT_ERROR_CODES.aborted,
    message: "The request was aborted",
    requestId,
    cause,
  });
}

export function timeoutError(
  timeoutMs: number,
  requestId: string,
  cause?: unknown
): OmniRouteError {
  return new OmniRouteError({
    status: 0,
    code: CLIENT_ERROR_CODES.timeout,
    type: CLIENT_ERROR_CODES.timeout,
    message: `The request timed out after ${timeoutMs}ms`,
    requestId,
    cause,
  });
}

export function networkError(requestId: string, cause?: unknown): OmniRouteError {
  return new OmniRouteError({
    status: 0,
    code: CLIENT_ERROR_CODES.network,
    type: CLIENT_ERROR_CODES.network,
    message: "The request failed before a response was received",
    requestId,
    cause,
  });
}

/**
 * A redirect the SDK refused to follow. `reason` and `target` are derived from the response's own
 * status and Location; neither the request body nor any header value reaches the message.
 */
export function redirectRefusedError(
  status: number,
  requestId: string,
  reason: string,
  target: string | null
): OmniRouteError {
  const where = target === null ? "" : ` to ${target}`;
  return new OmniRouteError({
    status,
    code: CLIENT_ERROR_CODES.redirectRefused,
    type: CLIENT_ERROR_CODES.redirectRefused,
    message: `Refusing to follow the ${status} redirect${where}: ${reason}`,
    requestId,
  });
}

export function invalidResponseError(
  status: number,
  requestId: string,
  message: string
): OmniRouteError {
  return new OmniRouteError({
    status,
    code: CLIENT_ERROR_CODES.invalidResponse,
    type: CLIENT_ERROR_CODES.invalidResponse,
    message,
    requestId,
  });
}
