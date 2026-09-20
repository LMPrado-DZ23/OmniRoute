// Final audit C-03: the typed transport code produced by the validator must reach the
// dashboard through `diagnosis` (route → classifyFailure) and be rendered as a translated
// sentence (presentConnectionTestFailure). Covers the server boundary and the shared
// presentation helper; the wizard rendering is covered by the vitest component test.
import test from "node:test";
import assert from "node:assert/strict";

const { classifyFailure, projectConnectionTestResultForPublicResponse } =
  await import("../../src/app/api/providers/[id]/test/publicErrorBoundary.ts");
const { presentConnectionTestFailure, isTransportFailureCode } =
  await import("../../src/shared/utils/apiErrorPresentation.ts");

const TIMEOUT_MESSAGE =
  "Could not connect to 10.255.255.1: timed out after 15 s. Check the URL and that the service is running.";

test("C-03: classifyFailure surfaces a typed transport code as network_error with host/timeout params", () => {
  const diagnosis = classifyFailure({
    error: TIMEOUT_MESSAGE,
    statusCode: 504, // synthetic 504 from getSafeOutboundFetchErrorStatus — must not win
    provider: "openai-compatible",
    code: "UPSTREAM_TIMEOUT",
    host: "10.255.255.1",
    timeoutMs: 15000,
  });
  assert.equal(diagnosis.type, "network_error");
  assert.equal(diagnosis.code, "UPSTREAM_TIMEOUT");
  assert.equal(diagnosis.message, TIMEOUT_MESSAGE);
  assert.deepEqual((diagnosis as { params?: unknown }).params, {
    host: "10.255.255.1",
    timeoutMs: 15000,
  });

  const unreachable = classifyFailure({
    error:
      "Could not connect to localhost:11434 (connection refused). Check the URL and that the service is running.",
    code: "UPSTREAM_UNREACHABLE",
    host: "localhost:11434",
  });
  assert.equal(unreachable.type, "network_error");
  assert.equal(unreachable.code, "UPSTREAM_UNREACHABLE");
  assert.deepEqual((unreachable as { params?: unknown }).params, {
    host: "localhost:11434",
    timeoutMs: null,
  });
});

test("C-03: classifyFailure without a typed code behaves exactly as before", () => {
  const legacy504 = classifyFailure({ error: "Provider unavailable (504)", statusCode: 504 });
  assert.equal(legacy504.type, "upstream_unavailable");
  assert.equal(legacy504.code, "504");
  assert.equal("params" in legacy504, false);

  const unknownCode = classifyFailure({ error: "fetch failed", code: "SOMETHING_ELSE" });
  assert.equal(unknownCode.type, "network_error");
  assert.equal(unknownCode.code, "network_error");
  assert.equal("params" in unknownCode, false);
});

test("C-03: the public projection keeps diagnosis.params and never leaks a path through it", () => {
  const projected = projectConnectionTestResultForPublicResponse({
    valid: false,
    error: TIMEOUT_MESSAGE,
    diagnosis: classifyFailure({
      error: TIMEOUT_MESSAGE,
      code: "UPSTREAM_TIMEOUT",
      host: "10.255.255.1",
      timeoutMs: 15000,
    }),
  });
  const diagnosis = projected.diagnosis as { code: string; message: string; params: unknown };
  assert.equal(diagnosis.code, "UPSTREAM_TIMEOUT");
  assert.equal(diagnosis.message, TIMEOUT_MESSAGE);
  assert.deepEqual(diagnosis.params, { host: "10.255.255.1", timeoutMs: 15000 });
  assert.doesNotMatch(String(projected.error), /<path>/);
});

test("C-03: presentConnectionTestFailure renders the translated sentence with host + seconds", () => {
  const messages: Record<string, string> = {
    "apiErrors.upstreamTimeout":
      "Não foi possível conectar a {host}: tempo esgotado após {seconds} s. Verifique a URL e se o serviço está no ar.",
    "apiErrors.upstreamTimeoutUnknownDuration":
      "Não foi possível conectar a {host}: a requisição expirou.",
    "apiErrors.upstreamUnreachable": "Não foi possível conectar a {host}.",
    "apiErrors.upstreamTls": "O handshake TLS com {host} falhou.",
    "apiErrors.unknownHost": "o provedor",
  };
  const translate = (key: string, values?: Record<string, string | number>) => {
    const template = messages[key];
    if (!template) return null;
    return Object.entries(values ?? {}).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      template
    );
  };

  const timeout = presentConnectionTestFailure(
    {
      error: TIMEOUT_MESSAGE,
      diagnosis: {
        type: "network_error",
        code: "UPSTREAM_TIMEOUT",
        message: TIMEOUT_MESSAGE,
        params: { host: "10.255.255.1", timeoutMs: 15000 },
      },
    },
    { translate, fallback: "Falha no teste" }
  );
  assert.equal(
    timeout.message,
    "Não foi possível conectar a 10.255.255.1: tempo esgotado após 15 s. Verifique a URL e se o serviço está no ar."
  );
  assert.equal(timeout.code, "UPSTREAM_TIMEOUT");
  assert.equal(timeout.detail, TIMEOUT_MESSAGE);

  const noHost = presentConnectionTestFailure(
    { error: "x", diagnosis: { code: "UPSTREAM_TIMEOUT", params: null } },
    { translate, fallback: "Falha no teste" }
  );
  assert.equal(noHost.message, "Não foi possível conectar a o provedor: a requisição expirou.");

  const tls = presentConnectionTestFailure(
    {
      error: "TLS handshake with llm.example.com failed",
      diagnosis: { code: "UPSTREAM_TLS", params: { host: "llm.example.com" } },
    },
    { translate, fallback: "Falha no teste" }
  );
  assert.equal(tls.message, "O handshake TLS com llm.example.com falhou.");

  // Non-typed failures keep the server sentence; missing everything → fallback.
  const legacy = presentConnectionTestFailure(
    { error: "Invalid API key", diagnosis: { type: "upstream_auth_error", code: "401" } },
    { translate, fallback: "Falha no teste" }
  );
  // `details` carries per-field validation messages; a transport failure has none,
  // and an empty array rather than undefined is what a caller can spread safely.
  assert.deepEqual(legacy, {
    message: "Invalid API key",
    code: null,
    detail: null,
    details: [],
  });
  assert.equal(
    presentConnectionTestFailure({ valid: false }, { translate, fallback: "Falha no teste" })
      .message,
    "Falha no teste"
  );
  assert.equal(isTransportFailureCode("UPSTREAM_TLS"), true);
  assert.equal(isTransportFailureCode("upstream_error"), false);
});
