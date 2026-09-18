/**
 * Phase 6: every first-use failure maps to a guidance kind (why / how to fix / retry / docs).
 * The mapping only reads the existing HTTP error envelopes; it never changes them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const guide = await import("../../src/shared/utils/actionableError.ts");
const en = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/i18n/messages/en.json"), "utf8")
) as { onboarding: { errorGuide: Record<string, unknown> } };
const ptBR = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/i18n/messages/pt-BR.json"), "utf8")
) as { onboarding: { errorGuide: Record<string, unknown> } };

test("management call statuses map to session / input / rate-limit / server guidance", () => {
  assert.equal(guide.guideForHttpStatus(401).kind, "sessionExpired");
  assert.equal(guide.guideForHttpStatus(403).kind, "sessionExpired");
  assert.equal(guide.guideForHttpStatus(400).kind, "invalidInput");
  assert.equal(guide.guideForHttpStatus(409).kind, "invalidInput");
  assert.equal(guide.guideForHttpStatus(408).kind, "timeout");
  assert.equal(guide.guideForHttpStatus(429).kind, "rateLimited");
  assert.equal(guide.guideForHttpStatus(500).kind, "server");
  assert.equal(guide.guideForHttpStatus(503).kind, "server");
  assert.equal(guide.guideForHttpStatus(undefined).kind, "unknown");
  assert.equal(guide.guideForHttpStatus(302).kind, "unknown");
});

test("connection-test verdicts: typed transport codes win over the diagnosis type", () => {
  const timeout = guide.guideForConnectionTest({
    diagnosis: { type: "network_error", code: "UPSTREAM_TIMEOUT" },
  });
  assert.deepEqual(timeout, {
    kind: "unreachable",
    retryable: true,
    docsHref: "/docs/guides/troubleshooting",
  });
  assert.equal(
    guide.guideForConnectionTest({ diagnosis: { type: "network_error", code: "UPSTREAM_TLS" } })
      .kind,
    "tls"
  );
  assert.equal(
    guide.guideForConnectionTest({ diagnosis: { type: "upstream_auth_error", code: "401" } }).kind,
    "credential"
  );
  assert.equal(
    guide.guideForConnectionTest({ diagnosis: { type: "upstream_rate_limited", code: "429" } })
      .kind,
    "rateLimited"
  );
  assert.equal(
    guide.guideForConnectionTest({ diagnosis: { type: "upstream_unavailable", code: "503" } }).kind,
    "providerDown"
  );
  assert.equal(
    guide.guideForConnectionTest({ diagnosis: { type: "something_new" } }).kind,
    "unknown"
  );
  assert.equal(guide.guideForConnectionTest(null).kind, "unknown");
});

test("a rejected credential is not retryable as-is and points to the providers guide", () => {
  const credential = guide.guideForConnectionTest({
    diagnosis: { type: "upstream_ambiguous_auth_or_quota" },
  });
  assert.equal(credential.retryable, false);
  assert.equal(credential.docsHref, "/docs/getting-started/providers-guide");
});

test("model-test failures: route policy, upstream status and timeouts", () => {
  assert.equal(guide.guideForModelTest(403, { statusCode: null }).kind, "paidModelBlocked");
  assert.equal(guide.guideForModelTest(429, null).kind, "rateLimited");
  assert.equal(guide.guideForModelTest(502, { rateLimited: true }).kind, "rateLimited");
  assert.equal(guide.guideForModelTest(401, { statusCode: 401 }).kind, "credential");
  assert.equal(guide.guideForModelTest(502, { statusCode: 403 }).kind, "credential");
  assert.equal(guide.guideForModelTest(502, { statusCode: 503 }).kind, "providerDown");
  assert.equal(guide.guideForModelTest(400, { statusCode: null }).kind, "invalidInput");
  assert.equal(guide.guideForModelTest(409, null).kind, "invalidInput");
  assert.equal(guide.guideForModelTest(401, null).kind, "sessionExpired");
  assert.equal(guide.guideForModelTest(504, null).kind, "timeout");
  assert.equal(guide.guideForModelTest(500, null).kind, "providerDown");
  assert.equal(guide.guideForModelTest(418, null).kind, "unknown");
});

test("every guidance kind has why/fix copy in en and pt-BR, and a real docs route", () => {
  const kinds = [
    "network",
    "timeout",
    "unreachable",
    "tls",
    "credential",
    "rateLimited",
    "providerDown",
    "invalidInput",
    "sessionExpired",
    "server",
    "noConnection",
    "noModels",
    "paidModelBlocked",
    "unknown",
  ] as const;
  const docsFiles: Record<string, string> = {
    "/docs/getting-started/first_10_minutes": "docs/getting-started/FIRST_10_MINUTES.md",
    "/docs/getting-started/providers-guide": "docs/getting-started/PROVIDERS-GUIDE.md",
    "/docs/guides/troubleshooting": "docs/guides/TROUBLESHOOTING.md",
  };
  for (const kind of kinds) {
    const g = guide.actionableGuide(kind);
    assert.equal(g.kind, kind);
    for (const catalog of [en, ptBR]) {
      const entry = catalog.onboarding.errorGuide[kind] as { why?: string; fix?: string };
      assert.ok(entry?.why?.trim(), `${kind}.why`);
      assert.ok(entry?.fix?.trim(), `${kind}.fix`);
    }
    const file = docsFiles[g.docsHref];
    assert.ok(file, `docs route for ${kind}: ${g.docsHref}`);
    assert.ok(fs.existsSync(path.join(process.cwd(), file)), file);
  }
  assert.equal(guide.FIRST_USE_DOCS.firstSteps, "/docs/getting-started/first_10_minutes");
});
