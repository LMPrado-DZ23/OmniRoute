/**
 * Actionable error guidance for the first-use flow (onboarding wizard).
 *
 * `presentApiError` / `presentConnectionTestFailure` (apiErrorPresentation.ts) answer
 * "what happened" with one readable headline. A first-time user also needs to know why it
 * happened, how to fix it, whether trying again can help and where the docs are. This
 * module classifies a failure into a small set of kinds; the UI renders the why/fix text
 * for the kind from the `onboarding.errorGuide.<kind>` messages. It never changes the
 * HTTP error envelopes — it only reads them.
 */

type ActionableErrorKind =
  | "network"
  | "timeout"
  | "unreachable"
  | "tls"
  | "credential"
  | "rateLimited"
  | "providerDown"
  | "invalidInput"
  | "sessionExpired"
  | "server"
  | "noConnection"
  | "noModels"
  | "paidModelBlocked"
  | "unknown";

export interface ActionableErrorGuide {
  kind: ActionableErrorKind;
  /** True when trying the same action again, unchanged, can succeed. */
  retryable: boolean;
  /** In-app docs route (served by src/app/docs/[...slug]). */
  docsHref: string;
}

/** Docs routes used by the guidance. Fumadocs serves lowercased slugs of docs/<section>/<FILE>.md. */
export const FIRST_USE_DOCS = {
  firstSteps: "/docs/getting-started/first_10_minutes",
  providers: "/docs/getting-started/providers-guide",
  troubleshooting: "/docs/guides/troubleshooting",
} as const;

const KIND_DEFAULTS: Readonly<Record<ActionableErrorKind, Omit<ActionableErrorGuide, "kind">>> = {
  network: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
  timeout: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
  unreachable: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
  tls: { retryable: false, docsHref: FIRST_USE_DOCS.troubleshooting },
  credential: { retryable: false, docsHref: FIRST_USE_DOCS.providers },
  rateLimited: { retryable: true, docsHref: FIRST_USE_DOCS.providers },
  providerDown: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
  invalidInput: { retryable: false, docsHref: FIRST_USE_DOCS.firstSteps },
  sessionExpired: { retryable: false, docsHref: FIRST_USE_DOCS.firstSteps },
  server: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
  noConnection: { retryable: false, docsHref: FIRST_USE_DOCS.firstSteps },
  noModels: { retryable: true, docsHref: FIRST_USE_DOCS.providers },
  paidModelBlocked: { retryable: false, docsHref: FIRST_USE_DOCS.firstSteps },
  unknown: { retryable: true, docsHref: FIRST_USE_DOCS.troubleshooting },
};

export function actionableGuide(kind: ActionableErrorKind): ActionableErrorGuide {
  return { kind, ...KIND_DEFAULTS[kind] };
}

/** Guidance for a failed management call (`/api/*`) from its HTTP status. */
export function guideForHttpStatus(status: number | null | undefined): ActionableErrorGuide {
  if (status === 401 || status === 403) return actionableGuide("sessionExpired");
  if (status === 408) return actionableGuide("timeout");
  if (status === 429) return actionableGuide("rateLimited");
  if (typeof status === "number" && status >= 400 && status < 500) {
    return actionableGuide("invalidInput");
  }
  if (typeof status === "number" && status >= 500) return actionableGuide("server");
  return actionableGuide("unknown");
}

const TRANSPORT_CODE_KINDS: Readonly<Record<string, ActionableErrorKind>> = {
  UPSTREAM_TIMEOUT: "unreachable",
  UPSTREAM_UNREACHABLE: "unreachable",
  UPSTREAM_TLS: "tls",
};

/** `diagnosis.type` values of `/api/providers/{id}/test` (publicErrorBoundary.ts). */
const DIAGNOSIS_TYPE_KINDS: Readonly<Record<string, ActionableErrorKind>> = {
  upstream_auth_error: "credential",
  upstream_ambiguous_auth_or_quota: "credential",
  token_expired: "credential",
  token_refresh_failed: "credential",
  account_deactivated: "credential",
  upstream_rate_limited: "rateLimited",
  upstream_unavailable: "providerDown",
  network_error: "unreachable",
  unsupported: "invalidInput",
};

interface ConnectionTestDiagnosisLike {
  diagnosis?: { type?: string | null; code?: string | null } | null;
}

/** Guidance for a `valid: false` connection-test verdict. */
export function guideForConnectionTest(
  result: ConnectionTestDiagnosisLike | null | undefined
): ActionableErrorGuide {
  const code = result?.diagnosis?.code;
  if (typeof code === "string" && TRANSPORT_CODE_KINDS[code]) {
    return actionableGuide(TRANSPORT_CODE_KINDS[code]);
  }
  const type = result?.diagnosis?.type;
  if (typeof type === "string" && DIAGNOSIS_TYPE_KINDS[type]) {
    return actionableGuide(DIAGNOSIS_TYPE_KINDS[type]);
  }
  return actionableGuide("unknown");
}

interface ModelTestFailureLike {
  statusCode?: number | null;
  rateLimited?: boolean | null;
}

/** Kind decided by the upstream provider status carried in the body, when there is one. */
function modelTestUpstreamKind(
  body: ModelTestFailureLike | null | undefined
): ActionableErrorKind | null {
  const upstream = body?.statusCode;
  if (body?.rateLimited === true || upstream === 429) return "rateLimited";
  if (upstream === 401 || upstream === 403) return "credential";
  if (typeof upstream === "number" && upstream >= 500) return "providerDown";
  return null;
}

/** Kind decided by the route's own HTTP status. */
const MODEL_TEST_ROUTE_STATUS_KINDS: Readonly<Record<number, ActionableErrorKind>> = {
  400: "invalidInput",
  401: "sessionExpired",
  403: "paidModelBlocked",
  404: "invalidInput",
  408: "timeout",
  409: "invalidInput",
  429: "rateLimited",
  504: "timeout",
};

/**
 * Guidance for a failed `POST /api/models/test`. `httpStatus` is the route's own status
 * (403 = paid model blocked by hidePaidModels, 409 = managed lease connection); the body's
 * `statusCode` is the upstream provider status when the request reached it.
 */
export function guideForModelTest(
  httpStatus: number,
  body: ModelTestFailureLike | null | undefined
): ActionableErrorGuide {
  // 403 is route policy (hidePaidModels) — it never reached the provider.
  if (httpStatus === 403) return actionableGuide("paidModelBlocked");
  const kind =
    modelTestUpstreamKind(body) ??
    MODEL_TEST_ROUTE_STATUS_KINDS[httpStatus] ??
    (httpStatus >= 500 ? "providerDown" : "unknown");
  return actionableGuide(kind);
}
