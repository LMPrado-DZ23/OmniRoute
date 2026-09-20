// Contract tests for the usage-reporting and session-pool routes.
//
//   GET  /api/usage/budget/bulk
//   GET  /api/usage/combo-trace/{id}
//   GET  /api/usage/provider-window-costs
//   GET/POST/DELETE /api/usage/token-limits
//   GET  /api/session-pools, GET /api/session-pools/{provider}
//   GET  /api/synced-available-models
//
// These expose spend, budget limits and routing traces for every key, so the
// contract starts with the auth ladder and then pins the documented envelopes
// and the 400/404 paths.
//
// NO NETWORK: globalThis.fetch is replaced after the route imports by a stub
// that throws on every URL, so an accidental outbound call fails loudly.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-pools-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "usage-pools-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const budgetBulkRoute = await import("../../../../src/app/api/usage/budget/bulk/route.ts");
const comboTraceRoute = await import("../../../../src/app/api/usage/combo-trace/[id]/route.ts");
const windowCostsRoute =
  await import("../../../../src/app/api/usage/provider-window-costs/route.ts");
const tokenLimitsRoute = await import("../../../../src/app/api/usage/token-limits/route.ts");
const sessionPoolsRoute = await import("../../../../src/app/api/session-pools/route.ts");
const sessionPoolRoute = await import("../../../../src/app/api/session-pools/[provider]/route.ts");
const syncedModelsRoute = await import("../../../../src/app/api/synced-available-models/route.ts");

// Installed only now — after proxyFetch has patched the global.
const unexpectedCalls: string[] = [];
const realFetch = globalThis.fetch;
async function stubFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  unexpectedCalls.push(url);
  throw new Error(`contract test blocked an unexpected outbound request: ${url}`);
}
globalThis.fetch = stubFetch;

type ErrorEnvelope = { error: { message: string } };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function providerParams(provider: string): { params: Promise<{ provider: string }> } {
  return { params: Promise.resolve({ provider }) };
}

function idParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(url: string, method = "GET", apiKey?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

let manageKey = "";
let readOnlyKey = "";
let subjectKeyId = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "usage-pools-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("usage-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("usage-readonly", "contract-test", ["read"])).key;
  subjectKeyId = (await apiKeysDb.createApiKey("usage-subject", "contract-test", [])).id;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/usage/budget/bulk ───────────────────────────────────────────────────

const BULK = "http://localhost/api/usage/budget/bulk";

it("GET /api/usage/budget/bulk answers 401 without a credential", async () => {
  assert.equal((await budgetBulkRoute.GET(req(BULK))).status, 401);
});

it("GET /api/usage/budget/bulk answers 403 for a key without the manage scope", async () => {
  assert.equal((await budgetBulkRoute.GET(req(BULK, "GET", readOnlyKey))).status, 403);
});

it("GET /api/usage/budget/bulk returns a budget entry per key, keyed by id", async () => {
  const response = await budgetBulkRoute.GET(req(BULK, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{
    budgets: Record<string, { totalCostToday: number; budgetCheck: { allowed: boolean } }>;
  }>(response);
  const entry = body.budgets[subjectKeyId];
  assert.ok(entry, "every existing key has an entry");
  assert.equal(entry.totalCostToday, 0);
  assert.equal(entry.budgetCheck.allowed, true);
  assert.ok(
    Object.keys(body.budgets).length >= 3,
    "all three keys created by this suite are reported"
  );
});

// ── /api/usage/combo-trace/{id} ──────────────────────────────────────────────

it("GET /api/usage/combo-trace/{id} answers 401 without a credential", async () => {
  const response = await comboTraceRoute.GET(
    req("http://localhost/api/usage/combo-trace/combo-1"),
    idParams("combo-1")
  );
  assert.equal(response.status, 401);
});

it("GET /api/usage/combo-trace/{id} rejects an id without the combo- prefix", async () => {
  const response = await comboTraceRoute.GET(
    req("http://localhost/api/usage/combo-trace/nope", "GET", manageKey),
    idParams("nope")
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid invocation id");
});

it("GET /api/usage/combo-trace/{id} answers 404 for an unknown or expired trace", async () => {
  const response = await comboTraceRoute.GET(
    req("http://localhost/api/usage/combo-trace/combo-missing", "GET", manageKey),
    idParams("combo-missing")
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "Combo trace not found or expired"
  );
});

// ── /api/usage/provider-window-costs ─────────────────────────────────────────

const COSTS = "http://localhost/api/usage/provider-window-costs";

it("GET /api/usage/provider-window-costs answers 401 without a credential", async () => {
  assert.equal((await windowCostsRoute.GET(req(`${COSTS}?provider=openai`))).status, 401);
});

it("GET /api/usage/provider-window-costs requires the provider query param", async () => {
  const response = await windowCostsRoute.GET(req(COSTS, "GET", manageKey));
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "provider query param is required"
  );
});

it("GET /api/usage/provider-window-costs rejects a provider that fails the pattern", async () => {
  const response = await windowCostsRoute.GET(
    req(`${COSTS}?provider=${encodeURIComponent("../etc/passwd")}`, "GET", manageKey)
  );
  assert.equal(response.status, 400);
});

it("GET /api/usage/provider-window-costs returns a breakdown for a known provider", async () => {
  const response = await windowCostsRoute.GET(req(`${COSTS}?provider=openai`, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object");
});

// ── /api/usage/token-limits ──────────────────────────────────────────────────

const LIMITS = "http://localhost/api/usage/token-limits";

it("GET /api/usage/token-limits requires the apiKeyId query param", async () => {
  const response = await tokenLimitsRoute.GET(req(LIMITS, "GET", manageKey));
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<ErrorEnvelope>(response)).error.message,
    "apiKeyId query param is required"
  );
});

it("POST then GET /api/usage/token-limits round-trips a limit with its window fields", async () => {
  const created = await tokenLimitsRoute.POST(
    req(LIMITS, "POST", manageKey, {
      apiKeyId: subjectKeyId,
      scopeType: "global",
      tokenLimit: 1000,
      resetInterval: "daily",
    })
  );
  assert.equal(created.status, 200);
  const createdBody = await readJson<{ success: boolean; limit: { id: string } }>(created);
  assert.equal(createdBody.success, true);
  assert.equal(typeof createdBody.limit.id, "string");

  const listed = await tokenLimitsRoute.GET(
    req(`${LIMITS}?apiKeyId=${subjectKeyId}`, "GET", manageKey)
  );
  assert.equal(listed.status, 200);
  const body = await readJson<{
    apiKeyId: string;
    limits: Array<{
      id: string;
      tokenLimit: number;
      tokensUsed: number;
      remaining: number;
      nextResetAt: unknown;
    }>;
  }>(listed);
  assert.equal(body.apiKeyId, subjectKeyId);
  const limit = body.limits.find((entry) => entry.id === createdBody.limit.id);
  assert.ok(limit, "the created limit is listed");
  assert.equal(limit.tokenLimit, 1000);
  assert.equal(limit.tokensUsed, 0);
  // With no usage recorded this only pins that `remaining` starts at the limit;
  // it cannot distinguish `limit - used` from a plain `limit`.
  assert.equal(limit.remaining, 1000);

  const deleted = await tokenLimitsRoute.DELETE(
    req(`${LIMITS}?id=${createdBody.limit.id}`, "DELETE", manageKey)
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await readJson<unknown>(deleted), { success: true });
});

it("POST /api/usage/token-limits rejects a non-positive tokenLimit with 400", async () => {
  const response = await tokenLimitsRoute.POST(
    req(LIMITS, "POST", manageKey, {
      apiKeyId: subjectKeyId,
      scopeType: "global",
      tokenLimit: 0,
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string; message: string }> } }>(
    response
  );
  assert.equal(body.error.details[0].field, "tokenLimit");
  assert.equal(body.error.details[0].message, "tokenLimit must be greater than zero");
});

it("POST /api/usage/token-limits rejects an unknown scopeType with 400", async () => {
  const response = await tokenLimitsRoute.POST(
    req(LIMITS, "POST", manageKey, {
      apiKeyId: subjectKeyId,
      scopeType: "galaxy",
      tokenLimit: 10,
    })
  );
  assert.equal(response.status, 400);
});

it("POST /api/usage/token-limits rejects malformed JSON with 400", async () => {
  const response = await tokenLimitsRoute.POST(req(LIMITS, "POST", manageKey, "{ nope"));
  assert.equal(response.status, 400);
  assert.equal((await readJson<ErrorEnvelope>(response)).error.message, "Invalid JSON body");
});

it("DELETE /api/usage/token-limits requires an id and answers 404 for an unknown one", async () => {
  const missingId = await tokenLimitsRoute.DELETE(req(LIMITS, "DELETE", manageKey));
  assert.equal(missingId.status, 400);
  assert.equal(
    (await readJson<ErrorEnvelope>(missingId)).error.message,
    "id query param is required"
  );

  const unknown = await tokenLimitsRoute.DELETE(
    req(`${LIMITS}?id=does-not-exist`, "DELETE", manageKey)
  );
  assert.equal(unknown.status, 404);
  assert.deepEqual(await readJson<unknown>(unknown), { success: false });
});

// ── /api/session-pools ───────────────────────────────────────────────────────

it("GET /api/session-pools answers 401 without a credential", async () => {
  assert.equal(
    (await sessionPoolsRoute.GET(req("http://localhost/api/session-pools"))).status,
    401
  );
});

it("GET /api/session-pools returns a { checkedAt, providers } report", async () => {
  const response = await sessionPoolsRoute.GET(
    req("http://localhost/api/session-pools", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ checkedAt: string; providers: unknown[] }>(response);
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)));
  assert.ok(Array.isArray(body.providers));
});

it("GET /api/session-pools/{provider} answers 401 without a credential", async () => {
  const response = await sessionPoolRoute.GET(
    req("http://localhost/api/session-pools/openai"),
    providerParams("openai")
  );
  assert.equal(response.status, 401);
});

it("GET /api/session-pools/{provider} answers 200 with an empty pool for any provider", async () => {
  // KNOWN DEAD BRANCH, pinned not endorsed: the route documents a 404 for an
  // unknown provider, but getWebSessionPoolHealth(provider) always synthesises
  // one entry for whatever name it is given, so `report.providers[0]` is never
  // undefined and the 404 is unreachable. Reported in the PR.
  const response = await sessionPoolRoute.GET(
    req("http://localhost/api/session-pools/not-a-provider", "GET", manageKey),
    providerParams("not-a-provider")
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ checkedAt: string; provider: string; health: string }>(response);
  assert.equal(body.provider, "not-a-provider");
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)));
  assert.equal(typeof body.health, "string");
});

// ── /api/synced-available-models ─────────────────────────────────────────────

it("GET /api/synced-available-models answers 401 without a credential", async () => {
  const response = await syncedModelsRoute.GET(req("http://localhost/api/synced-available-models"));
  assert.equal(response.status, 401);
  const body = await readJson<{ error: { message: string; type: string } }>(response);
  assert.equal(body.error.message, "Authentication required");
  assert.equal(body.error.type, "invalid_api_key");
});

it("GET /api/synced-available-models?provider= returns { models } for one provider", async () => {
  const response = await syncedModelsRoute.GET(
    req("http://localhost/api/synced-available-models?provider=openai", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ models: unknown[] }>(response);
  assert.ok(Array.isArray(body.models));
});

it("GET /api/synced-available-models returns the all-provider map without a filter", async () => {
  const response = await syncedModelsRoute.GET(
    req("http://localhost/api/synced-available-models", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object");
  assert.equal("models" in body, false, "the unfiltered read is the map itself, not { models }");
  assert.deepEqual(unexpectedCalls, [], "no outbound call was made by any of these routes");
});
