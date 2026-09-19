// Contract tests for the core operations an external client depends on and
// that are candidates for promotion to `stable`:
//
//   GET /api/providers, GET /api/settings, PATCH /api/settings,
//   GET /api/metrics, GET /api/telemetry/summary, GET /api/monitoring/health,
//   GET /api/usage/budget (and its POST, which the GET reads back)
//
// Each test pins the documented wire contract — status codes, envelope shape,
// auth behaviour and the 400/409 bodies — so any drift fails before promotion.
// These tests do NOT change any operation's `x-stability`; promotion is a
// separate decision.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved (the seeded provider connection is
// never contacted — GET /api/providers only reads the row back).
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-core-read-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "core-read-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../../src/lib/db/providers.ts");
const providersRoute = await import("../../../../src/app/api/providers/route.ts");
const settingsRoute = await import("../../../../src/app/api/settings/route.ts");
const metricsRoute = await import("../../../../src/app/api/metrics/route.ts");
const telemetryRoute = await import("../../../../src/app/api/telemetry/summary/route.ts");
const healthRoute = await import("../../../../src/app/api/monitoring/health/route.ts");
const budgetRoute = await import("../../../../src/app/api/usage/budget/route.ts");

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function req(
  url: string,
  method = "GET",
  apiKey?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Request {
  const headers: Record<string, string> = { ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PROVIDER_SECRET = "sk-contract-0123456789abcdefWXYZ";

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "core-read-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("core-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("core-readonly", "contract-test", ["read"])).key;
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "contract-openai",
    apiKey: PROVIDER_SECRET,
    isActive: true,
  });
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── GET /api/providers ───────────────────────────────────────────────────────

it("GET /api/providers answers 401 without a credential", async () => {
  const response = await providersRoute.GET(req("http://localhost/api/providers"));
  assert.equal(response.status, 401);
});

it("GET /api/providers answers 403 for a key without the manage scope", async () => {
  const response = await providersRoute.GET(
    req("http://localhost/api/providers", "GET", readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("GET /api/providers returns { connections, total } with the secret masked", async () => {
  const response = await providersRoute.GET(
    req("http://localhost/api/providers", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    connections: Array<{
      id: string;
      provider: string;
      name: string;
      apiKey?: string;
      accessToken?: string;
      refreshToken?: string;
    }>;
    total: number;
  }>(response);
  assert.ok(Array.isArray(body.connections));
  assert.equal(body.total, body.connections.length);

  const seeded = body.connections.find((c) => c.name === "contract-openai");
  assert.ok(seeded, "the seeded connection is listed");
  assert.equal(seeded.provider, "openai");
  assert.equal(seeded.apiKey, "sk-contr****WXYZ", "the key is masked to prefix****suffix");
  assert.equal(seeded.accessToken, undefined);
  assert.equal(seeded.refreshToken, undefined);
  assert.ok(
    !JSON.stringify(body).includes(PROVIDER_SECRET),
    "the raw provider secret never appears in the listing"
  );
});

it("GET /api/providers?provider= filters, and total follows the filter", async () => {
  const response = await providersRoute.GET(
    req("http://localhost/api/providers?provider=not-a-provider", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { connections: [], total: 0 });
});

// ── GET / PATCH /api/settings ────────────────────────────────────────────────

it("GET /api/settings answers 401 without a credential", async () => {
  const response = await settingsRoute.GET(req("http://localhost/api/settings"));
  assert.equal(response.status, 401);
});

it("GET /api/settings returns the settings with a revision ETag and no password", async () => {
  const response = await settingsRoute.GET(req("http://localhost/api/settings", "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{
    settingsRevision: number;
    hasPassword: boolean;
    requireLogin: boolean;
    runtimePorts: Record<string, unknown>;
    cloudConfigured: boolean;
    password?: unknown;
  }>(response);
  assert.equal(typeof body.settingsRevision, "number");
  assert.equal(response.headers.get("etag"), String(body.settingsRevision));
  assert.equal(body.requireLogin, true);
  assert.equal(typeof body.hasPassword, "boolean");
  assert.ok(body.runtimePorts && typeof body.runtimePorts === "object");
  assert.equal(typeof body.cloudConfigured, "boolean");
  assert.equal("password" in body, false, "the password hash is never returned");
});

it("PATCH /api/settings answers 403 for a key without the manage scope", async () => {
  const response = await settingsRoute.PATCH(
    req("http://localhost/api/settings", "PATCH", readOnlyKey, { debugMode: true })
  );
  assert.equal(response.status, 403);
});

it("PATCH /api/settings rejects malformed JSON with a coded 400", async () => {
  const response = await settingsRoute.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: "{ not json",
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { code: string; message: string } }>(response);
  assert.equal(body.error.code, "INVALID_JSON");
});

it("PATCH /api/settings rejects a wrongly-typed field with a field-level 400", async () => {
  const response = await settingsRoute.PATCH(
    req("http://localhost/api/settings", "PATCH", manageKey, { requireLogin: "yes please" })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{
    error: { message: string; details: Array<{ field: string; message: string }> };
  }>(response);
  assert.ok(body.error.details.some((detail) => detail.field === "requireLogin"));
});

it("PATCH /api/settings applies a change that GET reads back, bumping the revision", async () => {
  const before = await readJson<{ settingsRevision: number; debugMode?: boolean }>(
    await settingsRoute.GET(req("http://localhost/api/settings", "GET", manageKey))
  );
  const nextValue = before.debugMode !== true;

  const response = await settingsRoute.PATCH(
    req("http://localhost/api/settings", "PATCH", manageKey, { debugMode: nextValue })
  );
  assert.equal(response.status, 200);

  const after = await readJson<{ settingsRevision: number; debugMode?: boolean }>(
    await settingsRoute.GET(req("http://localhost/api/settings", "GET", manageKey))
  );
  assert.equal(after.debugMode, nextValue);
  assert.ok(after.settingsRevision > before.settingsRevision, "a write bumps the revision");
});

it("PATCH /api/settings answers 409 when If-Match names a stale revision", async () => {
  const current = await readJson<{ settingsRevision: number }>(
    await settingsRoute.GET(req("http://localhost/api/settings", "GET", manageKey))
  );
  const stale = Math.max(0, current.settingsRevision - 1);

  const response = await settingsRoute.PATCH(
    req(
      "http://localhost/api/settings",
      "PATCH",
      manageKey,
      { debugMode: false },
      {
        "If-Match": String(stale),
      }
    )
  );
  assert.equal(response.status, 409);
  const body = await readJson<{
    error: { code: string; currentRevision: number };
  }>(response);
  assert.equal(body.error.code, "SETTINGS_REVISION_CONFLICT");
  assert.equal(body.error.currentRevision, current.settingsRevision);
  assert.equal(response.headers.get("etag"), String(current.settingsRevision));
});

// ── GET /api/metrics ─────────────────────────────────────────────────────────

it("GET /api/metrics always requires auth, even with requireLogin disabled", async () => {
  await settingsDb.updateSettings({ requireLogin: false });
  try {
    const response = await metricsRoute.GET(req("http://localhost/api/metrics"));
    assert.equal(response.status, 401);
  } finally {
    await settingsDb.updateSettings({ requireLogin: true });
  }
});

it("GET /api/metrics answers 403 for a key without the manage scope", async () => {
  const response = await metricsRoute.GET(req("http://localhost/api/metrics", "GET", readOnlyKey));
  assert.equal(response.status, 403);
});

it("GET /api/metrics serves Prometheus text by default", async () => {
  const response = await metricsRoute.GET(req("http://localhost/api/metrics", "GET", manageKey));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.match(text, /^# (HELP|TYPE) /m, "the body is a Prometheus exposition");
});

it("GET /api/metrics?format=json serves a JSON summary", async () => {
  const response = await metricsRoute.GET(
    req("http://localhost/api/metrics?format=json", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
});

// ── GET /api/telemetry/summary ───────────────────────────────────────────────

it("GET /api/telemetry/summary returns the telemetry envelope", async () => {
  // NOTE: this handler carries no auth check of its own; it is protected only by
  // the central authz pipeline in front of /api/*. A handler-level contract
  // test therefore cannot assert 401 here — recorded as a promotion caveat.
  const response = await telemetryRoute.GET(
    req("http://localhost/api/telemetry/summary?windowMs=60000", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    uptime: number;
    memoryUsage: { rss: number; heapUsed: number };
    activeConnections: number;
    errorRate: number;
  }>(response);
  assert.equal(typeof body.uptime, "number");
  assert.equal(typeof body.memoryUsage.rss, "number");
  assert.equal(typeof body.memoryUsage.heapUsed, "number");
  assert.equal(body.activeConnections, 0);
  assert.equal(body.errorRate, 0, "no routed traffic means a 0% error rate, not NaN");
});

// ── GET /api/monitoring/health ───────────────────────────────────────────────

it("GET /api/monitoring/health gives an anonymous caller only the liveness verdict", async () => {
  healthRoute.__test_resetMonitoringHealthPayloadCache();
  const response = await healthRoute.GET(req("http://localhost/api/monitoring/health"));
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.equal(typeof body.status, "string");
  const allowed = new Set(["status", "setupComplete"]);
  assert.deepEqual(
    Object.keys(body).filter((key) => !allowed.has(key)),
    [],
    "no host-fingerprinting detail leaks to an anonymous probe"
  );
});

it("GET /api/monitoring/health gives a manage key the full payload", async () => {
  healthRoute.__test_resetMonitoringHealthPayloadCache();
  const response = await healthRoute.GET(
    req("http://localhost/api/monitoring/health", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.equal(typeof body.status, "string");
  assert.ok(
    Object.keys(body).length > 2,
    "the management view carries more than the liveness verdict"
  );
});

// ── /api/usage/budget ────────────────────────────────────────────────────────

it("GET /api/usage/budget answers 401 without a credential", async () => {
  const response = await budgetRoute.GET(req("http://localhost/api/usage/budget?apiKeyId=x"));
  assert.equal(response.status, 401);
});

it("GET /api/usage/budget requires the apiKeyId query param", async () => {
  const response = await budgetRoute.GET(
    req("http://localhost/api/usage/budget", "GET", manageKey)
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "apiKeyId query param is required"
  );
});

it("POST then GET /api/usage/budget round-trips a budget", async () => {
  const subject = await apiKeysDb.createApiKey("budget-subject", "contract-test", []);
  const written = await budgetRoute.POST(
    req("http://localhost/api/usage/budget", "POST", manageKey, {
      apiKeyId: subject.id,
      dailyLimitUsd: 5,
      warningThreshold: 0.8,
      resetInterval: "daily",
    })
  );
  assert.equal(written.status, 200);
  const writeBody = await readJson<{ success: boolean; apiKeyId: string }>(written);
  assert.equal(writeBody.success, true);
  assert.equal(writeBody.apiKeyId, subject.id);

  const read = await budgetRoute.GET(
    req(`http://localhost/api/usage/budget?apiKeyId=${subject.id}`, "GET", manageKey)
  );
  assert.equal(read.status, 200);
  const body = await readJson<{
    dailyLimitUsd: number;
    warningThreshold: number;
    resetInterval: string;
    totalCostToday: number;
    budgetCheck: { allowed: boolean };
  }>(read);
  assert.equal(body.dailyLimitUsd, 5);
  assert.equal(body.warningThreshold, 0.8);
  assert.equal(body.resetInterval, "daily");
  assert.equal(body.totalCostToday, 0);
  assert.equal(body.budgetCheck.allowed, true, "no spend yet, so the budget allows traffic");
});

it("POST /api/usage/budget rejects a negative limit with a field-level 400", async () => {
  const response = await budgetRoute.POST(
    req("http://localhost/api/usage/budget", "POST", manageKey, {
      apiKeyId: "k",
      dailyLimitUsd: -1,
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{
    error: { details: Array<{ field: string; message: string }> };
  }>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["dailyLimitUsd"]
  );
});
