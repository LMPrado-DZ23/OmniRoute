import { getErrorMessage } from "./api";

/**
 * User-facing presentation of an API error body (U4).
 *
 * Management routes answer failures in three shapes:
 *   `{ error: "text" }`
 *   `{ error: { code, message, … } }`          (e.g. PATCH /api/settings)
 *   `{ error: { message, details: [...] } }`   (validation)
 * Rendering `data.error` directly shows a raw technical sentence — or, for the object
 * shapes, throws in React. `presentApiError` always yields a string headline, prefers a
 * translated message keyed by `error.code`, and keeps the technical text as `detail`
 * so the UI can offer it behind "show details".
 */

/** `error.code` → key in the `common.apiErrors` message namespace. */
export const API_ERROR_CODE_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  PASSWORD_REQUIRED: "apiErrors.passwordRequired",
  PASSWORD_MISMATCH: "apiErrors.passwordMismatch",
  PASSWORD_REQUIRED_TO_ENABLE_LOGIN: "apiErrors.passwordRequiredToEnableLogin",
  INVALID_JSON: "apiErrors.invalidJson",
  VALIDATION_ERROR: "apiErrors.validation",
  SETTINGS_REVISION_CONFLICT: "apiErrors.settingsRevisionConflict",
  OIDC_ALLOWED_SUBJECTS_REQUIRED: "apiErrors.oidcAllowedSubjectsRequired",
  PAID_MODEL_TARGET_BLOCKED: "apiErrors.paidModelTargetBlocked",
};

export interface PresentedApiError {
  /** Short, user-facing headline — never JSON, never an object. */
  message: string;
  /** `error.code` when the server sent one. */
  code: string | null;
  /** The technical server text when it differs from `message`; for "show details". */
  detail: string | null;
  /**
   * The per-field validation messages of `{ error: { message, details: [...] } }`,
   * formatted as `field: message`.
   *
   * These used to be dropped on the floor. A short password answered
   * `400 { error: { message: "Invalid request", details: [{ field: "password",
   * message: "Password must be at least 4 characters" }] } }`, the caller rendered
   * only `message`, and the user saw "Invalid request" beside guidance telling them
   * the message above explains the problem — while the rule the server had already
   * sent went unread.
   */
  details: string[];
}

export type ApiErrorTranslate = (
  key: string,
  values?: Record<string, string | number>
) => string | null;

export interface PresentApiErrorOptions {
  /** Returns the translated text for a `common.apiErrors.*` key, or null when missing. */
  translate?: ApiErrorTranslate;
  /** Headline when the body carries nothing usable. */
  fallback: string;
  status?: number;
}

/**
 * Final audit C-03 — typed transport codes a provider connection test can carry in
 * `diagnosis.code` (see `lib/providers/validation/transport.ts`). Each maps to a
 * `common.apiErrors` message that takes `{host}` (and `{seconds}` for the timeout).
 */
export const CONNECTION_TEST_CODE_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  UPSTREAM_TIMEOUT: "apiErrors.upstreamTimeout",
  UPSTREAM_UNREACHABLE: "apiErrors.upstreamUnreachable",
  UPSTREAM_TLS: "apiErrors.upstreamTls",
};

export interface ConnectionTestFailureLike {
  error?: string | null;
  warning?: string | null;
  diagnosis?: {
    type?: string | null;
    message?: string | null;
    code?: string | null;
    params?: { host?: string | null; timeoutMs?: number | null } | null;
  } | null;
}

export function isTransportFailureCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(CONNECTION_TEST_CODE_MESSAGE_KEYS, code)
  );
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

type ConnectionTestDiagnosisParams = NonNullable<
  NonNullable<ConnectionTestFailureLike["diagnosis"]>["params"]
>;

/** The server's own sentence, in precedence order: `error`, `warning`, `diagnosis.message`. */
function readConnectionTestFailureText(
  result: ConnectionTestFailureLike | null | undefined
): string | null {
  const candidates = [result?.error, result?.warning, result?.diagnosis?.message];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return typeof found === "string" ? found.trim() : null;
}

function readHostParam(params: ConnectionTestDiagnosisParams | null): string | null {
  return typeof params?.host === "string" && params.host.trim() ? params.host.trim() : null;
}

function readTimeoutParam(params: ConnectionTestDiagnosisParams | null): number | null {
  return typeof params?.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : null;
}

/** Message key for a typed transport code; a timeout of unknown duration has its own sentence. */
function connectionTestMessageKey(code: string, timeoutMs: number | null): string {
  return code === "UPSTREAM_TIMEOUT" && !timeoutMs
    ? "apiErrors.upstreamTimeoutUnknownDuration"
    : CONNECTION_TEST_CODE_MESSAGE_KEYS[code];
}

/**
 * Translated headline for a typed transport failure (host + seconds substituted), or null
 * when the message catalog yields nothing usable.
 */
function translateConnectionTestFailure(
  translate: ApiErrorTranslate,
  code: string,
  params: ConnectionTestDiagnosisParams | null
): string | null {
  const host = readHostParam(params) ?? (translate("apiErrors.unknownHost") || "the provider");
  const timeoutMs = readTimeoutParam(params);
  const translated = translate(connectionTestMessageKey(code, timeoutMs), {
    host,
    ...(timeoutMs ? { seconds: formatSeconds(timeoutMs) } : {}),
  });
  return translated && translated.trim() ? translated : null;
}

/**
 * User-facing presentation of a failed `/api/providers/{id}/test` result: a translated
 * headline for typed transport failures (host + timeout substituted), otherwise the
 * server's already-sanitized sentence. The technical text is kept as `detail`.
 */
export function presentConnectionTestFailure(
  result: ConnectionTestFailureLike | null | undefined,
  { translate, fallback }: Pick<PresentApiErrorOptions, "translate" | "fallback">
): PresentedApiError {
  const diagnosis = result?.diagnosis ?? null;
  const raw = readConnectionTestFailureText(result) ?? fallback;
  const code = isTransportFailureCode(diagnosis?.code) ? diagnosis.code : null;
  if (!code || !translate) return { message: raw, code, detail: null, details: [] };

  const message = translateConnectionTestFailure(translate, code, diagnosis?.params ?? null) ?? raw;
  return { message, code, detail: raw !== message ? raw : null, details: [] };
}

export function getApiErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== "object") return null;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && code.trim() ? code : null;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function presentApiError(
  body: unknown,
  { translate, fallback, status }: PresentApiErrorOptions
): PresentedApiError {
  const code = getApiErrorCode(body);
  const raw = getErrorMessage(body, status, fallback);
  // `getErrorMessage` serialises message-less objects; that is detail, not a headline.
  const technical = looksLikeJson(raw) ? raw : raw === fallback ? null : raw;
  const headlineFromServer = technical && !looksLikeJson(technical) ? technical : fallback;

  const key = code ? API_ERROR_CODE_MESSAGE_KEYS[code] : undefined;
  const translated = key && translate ? translate(key) : null;
  const message = translated && translated.trim() ? translated : headlineFromServer;

  const detail = technical && technical !== message ? technical : null;
  return { message, code, detail, details: readValidationDetails(body) };
}

/**
 * One readable line for a failed management API response: the `presentApiError` headline
 * plus the per-field validation details (`field: message`) of the shared envelope
 * `{ error: { message, details: [{ field, message }] } }`. Passing that envelope straight to
 * `new Error()` rendered `[object Object]` (audit C H1); this never does.
 */
export function describeApiError(body: unknown, fallback: string, status?: number): string {
  const { message, details } = presentApiError(body, { fallback, status });
  return details.length > 0 ? `${message}: ${details.join("; ")}` : message;
}

function readValidationDetails(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return [];
  const details = (error as Record<string, unknown>).details;
  if (!Array.isArray(details)) return [];
  return details.map(formatValidationDetail).filter((text): text is string => text !== null);
}

function formatValidationDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return null;
  const field = typeof record.field === "string" ? record.field.trim() : "";
  return field ? `${field}: ${message}` : message;
}
