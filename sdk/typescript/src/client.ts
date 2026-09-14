import { AttemptController } from "./attempt.ts";
import {
  OmniRouteError,
  abortedError,
  errorFromHttpResponse,
  invalidResponseError,
  isRecord,
  networkError,
  parseJson,
  parseRetryAfterMs,
  timeoutError,
} from "./errors.ts";
import { ChatCompletionStream } from "./stream.ts";
import type {
  ApiKeyStatus,
  ApiResponse,
  ChatCompletion,
  ChatCompletionRequest,
  HealthStatus,
  ModelList,
  RoutePreviewRequest,
  RoutePreviewResult,
} from "./types.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type AuthMode = "none" | "apiKey" | "management";

interface OperationSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly auth: AuthMode;
}

/** Every HTTP operation the SDK issues. Asserted against docs/openapi.yaml by tests/unit/sdk-openapi-drift.test.ts. */
export const OPERATIONS = {
  chatCompletions: { method: "POST", path: "/api/v1/chat/completions", auth: "apiKey" },
  listModels: { method: "GET", path: "/api/v1/models", auth: "apiKey" },
  health: { method: "GET", path: "/api/health", auth: "none" },
  quota: { method: "GET", path: "/api/v1/me/status", auth: "apiKey" },
  routePreview: { method: "POST", path: "/api/omniroute/route/preview", auth: "management" },
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;

export const DEFAULT_BASE_URL = "http://localhost:20128";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const REQUEST_ID_HEADER = "x-request-id";
export const DEFAULT_RETRY = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  retryOn: Object.freeze([408, 429, 500, 502, 503, 504]),
});

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** HTTP statuses that trigger a retry. Network errors and timeouts are always retryable. */
  retryOn?: readonly number[];
}

interface ResolvedRetry {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: ReadonlySet<number>;
}

export interface RequestDebugInfo {
  method: string;
  url: string;
  attempt: number;
  clientRequestId: string;
  /** Header snapshot with credentials replaced by "[REDACTED]". */
  headers: Record<string, string>;
}

export interface OmniRouteClientOptions {
  baseUrl?: string;
  /** Client API key, sent as `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Credential for management routes (route preview). Falls back to `apiKey`. */
  managementKey?: string;
  /** Per-attempt timeout. For streams it covers the time until response headers arrive. */
  timeoutMs?: number;
  retry?: RetryOptions | false;
  fetch?: FetchLike;
  requestIdFactory?: () => string;
  headers?: Record<string, string>;
  /** Debug hook invoked before every attempt. Credentials are redacted. */
  onRequest?: (info: RequestDebugInfo) => void;
  /** Backoff sleep; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Overrides the generated `x-request-id` for this call. */
  requestId?: string;
  retry?: RetryOptions | false;
  headers?: Record<string, string>;
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  });
  return out;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function resolveRetry(
  base: RetryOptions | false | undefined,
  override: RetryOptions | false | undefined
): ResolvedRetry {
  if (override === false || (override === undefined && base === false)) {
    return { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryOn: new Set() };
  }
  const merged: RetryOptions = { ...(base === false ? {} : base), ...override };
  return {
    maxRetries: nonNegative(merged.maxRetries, DEFAULT_RETRY.maxRetries),
    baseDelayMs: nonNegative(merged.baseDelayMs, DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: nonNegative(merged.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
    retryOn: new Set(merged.retryOn ?? DEFAULT_RETRY.retryOn),
  };
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.toString().replace(/\/+$/, "");
}

interface Established {
  response: Response;
  clientRequestId: string;
  attempt: AttemptController;
}

export interface ChatCompletionsResource {
  create(request: ChatCompletionRequest, options?: RequestOptions): Promise<ApiResponse<ChatCompletion>>;
  stream(request: ChatCompletionRequest, options?: RequestOptions): Promise<ChatCompletionStream>;
}

export class OmniRouteClient {
  readonly baseUrl: string;
  readonly chat: { readonly completions: ChatCompletionsResource };
  readonly models: { list(options?: RequestOptions): Promise<ApiResponse<ModelList>> };
  readonly routing: {
    preview(request: RoutePreviewRequest, options?: RequestOptions): Promise<ApiResponse<RoutePreviewResult>>;
  };
  readonly #apiKey: string | undefined;
  readonly #managementKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #retry: RetryOptions | false | undefined;
  readonly #fetch: FetchLike;
  readonly #requestIdFactory: () => string;
  readonly #defaultHeaders: Record<string, string>;
  readonly #onRequest: ((info: RequestDebugInfo) => void) | undefined;
  readonly #sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;

  constructor(options: OmniRouteClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#apiKey = options.apiKey;
    this.#managementKey = options.managementKey;
    this.#timeoutMs = nonNegative(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#retry = options.retry;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.#defaultHeaders = { ...options.headers };
    this.#onRequest = options.onRequest;
    this.#sleep = options.sleep ?? defaultSleep;

    this.chat = {
      completions: {
        create: (request, requestOptions) =>
          this.#requestJson<ChatCompletion>(
            OPERATIONS.chatCompletions,
            { ...request, stream: false },
            requestOptions
          ),
        stream: (request, requestOptions) => this.#openStream(request, requestOptions),
      },
    };
    this.models = {
      list: (requestOptions) =>
        this.#requestJson<ModelList>(OPERATIONS.listModels, undefined, requestOptions),
    };
    this.routing = {
      preview: (request, requestOptions) =>
        this.#requestJson<RoutePreviewResult>(OPERATIONS.routePreview, request, requestOptions),
    };
  }

  /** GET /api/health — unauthenticated liveness probe. */
  health(options?: RequestOptions): Promise<ApiResponse<HealthStatus>> {
    return this.#requestJson<HealthStatus>(OPERATIONS.health, undefined, options);
  }

  /** GET /api/v1/me/status — usage and quota of the configured API key (`self:usage` scope). */
  quota(options?: RequestOptions): Promise<ApiResponse<ApiKeyStatus>> {
    return this.#requestJson<ApiKeyStatus>(OPERATIONS.quota, undefined, options);
  }

  #buildHeaders(
    auth: AuthMode,
    accept: string,
    hasBody: boolean,
    clientRequestId: string,
    extra: Record<string, string> | undefined
  ): Headers {
    const headers = new Headers(this.#defaultHeaders);
    for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
    headers.set("accept", accept);
    if (hasBody) headers.set("content-type", "application/json");
    headers.set(REQUEST_ID_HEADER, clientRequestId);
    const credential =
      auth === "management"
        ? (this.#managementKey ?? this.#apiKey)
        : auth === "apiKey"
          ? this.#apiKey
          : undefined;
    if (credential) headers.set("authorization", `Bearer ${credential}`);
    return headers;
  }

  async #execute(
    op: OperationSpec,
    body: unknown,
    accept: string,
    options: RequestOptions
  ): Promise<Established> {
    const clientRequestId = options.requestId ?? this.#requestIdFactory();
    const retry = resolveRetry(this.#retry, options.retry);
    const timeoutMs = nonNegative(options.timeoutMs, this.#timeoutMs);
    const url = `${this.baseUrl}${op.path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attemptNumber = 0; ; attemptNumber++) {
      if (options.signal?.aborted) throw abortedError(clientRequestId);
      const attempt = new AttemptController(options.signal, timeoutMs);
      const headers = this.#buildHeaders(
        op.auth,
        accept,
        payload !== undefined,
        clientRequestId,
        options.headers
      );
      this.#onRequest?.({
        method: op.method,
        url,
        attempt: attemptNumber,
        clientRequestId,
        headers: redactHeaders(headers),
      });

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: op.method,
          headers,
          body: payload,
          signal: attempt.signal,
        });
      } catch (cause) {
        attempt.dispose();
        if (attempt.abortedByCaller) throw abortedError(clientRequestId, cause);
        const error = attempt.timedOut
          ? timeoutError(timeoutMs, clientRequestId, cause)
          : networkError(clientRequestId, cause);
        if (attemptNumber >= retry.maxRetries) throw error;
        await this.#backoff(attemptNumber, undefined, retry, options.signal, clientRequestId);
        continue;
      }

      if (response.ok) return { response, clientRequestId, attempt };

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      if (retry.retryOn.has(response.status) && attemptNumber < retry.maxRetries) {
        await discardBody(response);
        attempt.dispose();
        await this.#backoff(attemptNumber, retryAfterMs, retry, options.signal, clientRequestId);
        continue;
      }
      const text = await response.text().catch(() => "");
      attempt.dispose();
      throw errorFromHttpResponse(response.status, text, response.headers, clientRequestId, retryAfterMs);
    }
  }

  async #backoff(
    attemptNumber: number,
    retryAfterMs: number | undefined,
    retry: ResolvedRetry,
    signal: AbortSignal | undefined,
    clientRequestId: string
  ): Promise<void> {
    const exponential = retry.baseDelayMs * 2 ** attemptNumber;
    const delay = Math.min(retryAfterMs ?? exponential, retry.maxDelayMs);
    try {
      await this.#sleep(delay, signal);
    } catch (cause) {
      throw abortedError(clientRequestId, cause);
    }
  }

  async #requestJson<T>(
    op: OperationSpec,
    body: unknown,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const { response, clientRequestId, attempt } = await this.#execute(
      op,
      body,
      "application/json",
      options
    );
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (attempt.abortedByCaller) throw abortedError(clientRequestId, cause);
      if (attempt.timedOut) throw timeoutError(nonNegative(options.timeoutMs, this.#timeoutMs), clientRequestId, cause);
      throw networkError(clientRequestId, cause);
    } finally {
      attempt.dispose();
    }
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? clientRequestId;
    const parsed = parseJson(text);
    if (!parsed.ok || !isRecord(parsed.value)) {
      throw invalidResponseError(response.status, requestId, "Response body is not a JSON object");
    }
    return {
      // Response boundary: the shape is defined by docs/openapi.yaml; unknown fields pass through.
      data: parsed.value as T,
      status: response.status,
      requestId,
      clientRequestId,
      headers: response.headers,
    };
  }

  async #openStream(
    request: ChatCompletionRequest,
    options: RequestOptions = {}
  ): Promise<ChatCompletionStream> {
    const { response, clientRequestId, attempt } = await this.#execute(
      OPERATIONS.chatCompletions,
      { ...request, stream: true },
      "text/event-stream",
      options
    );
    attempt.clearTimer();
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? clientRequestId;
    if (!response.body) {
      attempt.dispose();
      throw invalidResponseError(response.status, requestId, "Streaming response has no body");
    }
    return new ChatCompletionStream({
      body: response.body,
      status: response.status,
      headers: response.headers,
      requestId,
      clientRequestId,
      attempt,
    });
  }
}

export { OmniRouteError };
