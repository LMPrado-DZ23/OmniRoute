// Contract tests for the provider credential export routes and the webhook
// URL/delivery helpers.
//
//   POST /api/providers/{id}/claude-auth/export
//   POST /api/providers/{id}/codex-auth/export
//   POST /api/webhooks/validate-url
//   GET  /api/webhooks/{id}/deliveries
//
// The export routes hand the caller a connection's raw OAuth tokens as a
// downloadable credentials file, so the contract is: the auth ladder, the
// attachment headers (no-store, nosniff, Content-Disposition filename), the
// exact file payload shape the Claude/Codex CLIs read, and the coded 4xx for
// every connection that cannot be exported (unknown, wrong provider, API-key
// auth, missing token). All tokens here are fake fixtures, and every seeded
// connection is unexpired, so the export never needs a live refresh call.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-export-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "auth-export-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../../src/lib/db/providers.ts");
const webhooksDb = await import("../../../../src/lib/db/webhooks.ts");
const claudeExportRoute =
  await import("../../../../src/app/api/providers/[id]/claude-auth/export/route.ts");
const codexExportRoute =
  await import("../../../../src/app/api/providers/[id]/codex-auth/export/route.ts");
const validateUrlRoute = await import("../../../../src/app/api/webhooks/validate-url/route.ts");
const deliveriesRoute = await import("../../../../src/app/api/webhooks/[id]/deliveries/route.ts");

type CodedError = { error: string; code: string };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(url: string, method = "POST", apiKey?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

const FAR_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

let manageKey = "";
let readOnlyKey = "";
let claudeId = "";
let claudeNoRefreshId = "";
let claudeApiKeyId = "";
let codexId = "";

async function seed(data: Record<string, unknown>): Promise<string> {
  const created = (await providersDb.createProviderConnection(data)) as { id: string };
  return created.id;
}

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "auth-export-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("export-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("export-readonly", "contract-test", ["read"])).key;

  claudeId = await seed({
    provider: "claude",
    authType: "oauth",
    name: "claude-contract",
    email: "operator@example.com",
    accessToken: "fake-claude-access",
    refreshToken: "fake-claude-refresh",
    expiresAt: FAR_FUTURE,
    providerSpecificData: { scopes: ["user:inference"], subscriptionType: "pro" },
  });
  claudeNoRefreshId = await seed({
    provider: "claude",
    authType: "oauth",
    name: "claude-no-refresh",
    accessToken: "fake-claude-access-2",
    expiresAt: FAR_FUTURE,
  });
  claudeApiKeyId = await seed({
    provider: "claude",
    authType: "apikey",
    name: "claude-apikey",
    apiKey: "sk-ant-fake-contract-key-000000",
  });
  codexId = await seed({
    provider: "codex",
    authType: "oauth",
    name: "codex-contract",
    accessToken: "fake-codex-access",
    refreshToken: "fake-codex-refresh",
    idToken: fakeJwt({
      email: "operator@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-contract-123" },
    }),
    expiresAt: FAR_FUTURE,
  });
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/providers/{id}/claude-auth/export ───────────────────────────────────

it("POST claude-auth/export answers 401 without a credential", async () => {
  const response = await claudeExportRoute.POST(
    req(`http://localhost/api/providers/${claudeId}/claude-auth/export`),
    params(claudeId)
  );
  assert.equal(response.status, 401);
});

it("POST claude-auth/export answers 403 for a key without the manage scope", async () => {
  const response = await claudeExportRoute.POST(
    req(`http://localhost/api/providers/${claudeId}/claude-auth/export`, "POST", readOnlyKey),
    params(claudeId)
  );
  assert.equal(response.status, 403);
});

it("POST claude-auth/export returns the credentials.json attachment", async () => {
  const response = await claudeExportRoute.POST(
    req(`http://localhost/api/providers/${claudeId}/claude-auth/export`, "POST", manageKey),
    params(claudeId)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="claude-auth-operator@example.com.json"'
  );

  const file = await readJson<{
    claudeAiOauth: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scopes: string[];
      subscriptionType?: string;
    };
  }>(response);
  assert.equal(file.claudeAiOauth.accessToken, "fake-claude-access");
  assert.equal(file.claudeAiOauth.refreshToken, "fake-claude-refresh");
  assert.equal(file.claudeAiOauth.expiresAt, new Date(FAR_FUTURE).getTime(), "expiry in epoch ms");
  assert.deepEqual(file.claudeAiOauth.scopes, ["user:inference"]);
  assert.equal(file.claudeAiOauth.subscriptionType, "pro");
});

it("POST claude-auth/export answers 404 not_found for an unknown connection", async () => {
  const response = await claudeExportRoute.POST(
    req("http://localhost/api/providers/nope/claude-auth/export", "POST", manageKey),
    params("nope")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<CodedError>(response)).code, "not_found");
});

it("POST claude-auth/export refuses a non-Claude connection with 400", async () => {
  const response = await claudeExportRoute.POST(
    req(`http://localhost/api/providers/${codexId}/claude-auth/export`, "POST", manageKey),
    params(codexId)
  );
  assert.equal(response.status, 400);
  const body = await readJson<CodedError>(response);
  assert.equal(body.code, "invalid_request");
  assert.match(body.error, /Only Claude provider connections/);
});

it("POST claude-auth/export refuses an API-key Claude connection with 400", async () => {
  const response = await claudeExportRoute.POST(
    req(`http://localhost/api/providers/${claudeApiKeyId}/claude-auth/export`, "POST", manageKey),
    params(claudeApiKeyId)
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<CodedError>(response)).error, /Only OAuth Claude connections/);
});

it("POST claude-auth/export answers 409 reauth_required without a refresh token", async () => {
  const response = await claudeExportRoute.POST(
    req(
      `http://localhost/api/providers/${claudeNoRefreshId}/claude-auth/export`,
      "POST",
      manageKey
    ),
    params(claudeNoRefreshId)
  );
  assert.equal(response.status, 409);
  assert.equal((await readJson<CodedError>(response)).code, "reauth_required");
});

// ── /api/providers/{id}/codex-auth/export ────────────────────────────────────

it("POST codex-auth/export answers 401 without a credential", async () => {
  const response = await codexExportRoute.POST(
    req(`http://localhost/api/providers/${codexId}/codex-auth/export`),
    params(codexId)
  );
  assert.equal(response.status, 401);
});

it("POST codex-auth/export returns the auth.json attachment with the account id", async () => {
  const response = await codexExportRoute.POST(
    req(`http://localhost/api/providers/${codexId}/codex-auth/export`, "POST", manageKey),
    params(codexId)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename=".+\.json"$/
  );

  const file = await readJson<{
    auth_mode: string;
    OPENAI_API_KEY: null;
    tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
    last_refresh: string;
  }>(response);
  assert.equal(file.auth_mode, "chatgpt");
  assert.equal(file.OPENAI_API_KEY, null);
  assert.equal(file.tokens.access_token, "fake-codex-access");
  assert.equal(file.tokens.refresh_token, "fake-codex-refresh");
  assert.equal(file.tokens.account_id, "acct-contract-123", "derived from the id_token claim");
  assert.ok(!Number.isNaN(Date.parse(file.last_refresh)));
});

it("POST codex-auth/export refuses a non-Codex connection with 400", async () => {
  const response = await codexExportRoute.POST(
    req(`http://localhost/api/providers/${claudeId}/codex-auth/export`, "POST", manageKey),
    params(claudeId)
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<CodedError>(response)).error, /Only Codex provider connections/);
});

it("POST codex-auth/export answers 404 not_found for an unknown connection", async () => {
  const response = await codexExportRoute.POST(
    req("http://localhost/api/providers/nope/codex-auth/export", "POST", manageKey),
    params("nope")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<CodedError>(response)).code, "not_found");
});

// ── /api/webhooks/validate-url ───────────────────────────────────────────────

const VALIDATE_URL = "http://localhost/api/webhooks/validate-url";

it("POST /api/webhooks/validate-url answers 401 without a credential", async () => {
  const response = await validateUrlRoute.POST(req(VALIDATE_URL, "POST", undefined, { url: "x" }));
  assert.equal(response.status, 401);
});

it("POST /api/webhooks/validate-url accepts a public https URL", async () => {
  const response = await validateUrlRoute.POST(
    req(VALIDATE_URL, "POST", manageKey, { url: "https://hooks.example.com/omniroute" })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { valid: true });
});

it("POST /api/webhooks/validate-url flags a private/metadata URL as blocked_private", async () => {
  const response = await validateUrlRoute.POST(
    req(VALIDATE_URL, "POST", manageKey, { url: "http://169.254.169.254/latest/meta-data" })
  );
  assert.equal(response.status, 200, "a verdict, not an error");
  assert.deepEqual(await readJson<unknown>(response), { valid: false, reason: "blocked_private" });
});

it("POST /api/webhooks/validate-url rejects a malformed URL (reported as blocked_private)", async () => {
  // KNOWN DEFECT, pinned not endorsed: parseOutboundUrl throws an
  // OutboundUrlGuardError (code OUTBOUND_URL_INVALID) for a malformed or
  // non-http(s) URL, and the route maps EVERY OutboundUrlGuardError to
  // "blocked_private" — so the `invalid_url` branch is unreachable. Fixing it
  // changes a response value, which this patch release does not do; reported
  // in the PR instead.
  for (const url of ["not a url at all", "ftp://files.example.com/x"]) {
    const response = await validateUrlRoute.POST(req(VALIDATE_URL, "POST", manageKey, { url }));
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson<unknown>(response), {
      valid: false,
      reason: "blocked_private",
    });
  }
});

it("POST /api/webhooks/validate-url rejects an empty url with 400", async () => {
  const response = await validateUrlRoute.POST(req(VALIDATE_URL, "POST", manageKey, { url: "" }));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["url"]
  );
});

// ── /api/webhooks/{id}/deliveries ────────────────────────────────────────────

it("GET /api/webhooks/{id}/deliveries answers 401 without a credential", async () => {
  const response = await deliveriesRoute.GET(
    req("http://localhost/api/webhooks/x/deliveries", "GET"),
    params("x")
  );
  assert.equal(response.status, 401);
});

it("GET /api/webhooks/{id}/deliveries answers 404 for an unknown webhook", async () => {
  const response = await deliveriesRoute.GET(
    req("http://localhost/api/webhooks/nope/deliveries", "GET", manageKey),
    params("nope")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Webhook not found");
});

it("GET /api/webhooks/{id}/deliveries returns { deliveries } for a known webhook", async () => {
  const webhook = webhooksDb.createWebhook({
    url: "https://hooks.example.com/deliveries",
    events: ["*"],
    description: "contract",
    kind: "custom",
    enabled: true,
  }) as { id: string };
  const response = await deliveriesRoute.GET(
    req(`http://localhost/api/webhooks/${webhook.id}/deliveries?limit=500`, "GET", manageKey),
    params(webhook.id)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { deliveries: [] });
});
