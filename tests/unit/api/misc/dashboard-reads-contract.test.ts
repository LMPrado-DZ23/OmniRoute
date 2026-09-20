// Contract tests for the dashboard read/mutate routes still in the baseline.
//
//   GET  /api/batches, GET /api/batches/{id}
//   GET  /api/conversations/{id}
//   GET|DELETE /api/combos/metrics
//   POST /api/combos/reorder
//   GET  /api/analytics/auto-routing
//   GET  /api/omniroute/status
//   GET  /api/network/info
//   GET|POST /api/rate-limit
//
// NO NETWORK: globalThis.fetch is replaced after the route imports by a stub
// that throws on every URL. /api/combos/reorder would sync to the cloud if the
// operator had enabled it; the default is off, and the stub proves the sync is
// not attempted.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dashboard-reads-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "dashboard-reads-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const batchesRoute = await import("../../../../src/app/api/batches/route.ts");
const batchRoute = await import("../../../../src/app/api/batches/[id]/route.ts");
const conversationRoute = await import("../../../../src/app/api/conversations/[id]/route.ts");
const comboMetricsRoute = await import("../../../../src/app/api/combos/metrics/route.ts");
const comboReorderRoute = await import("../../../../src/app/api/combos/reorder/route.ts");
const autoRoutingRoute = await import("../../../../src/app/api/analytics/auto-routing/route.ts");
const omnirouteStatusRoute = await import("../../../../src/app/api/omniroute/status/route.ts");
const networkInfoRoute = await import("../../../../src/app/api/network/info/route.ts");
const rateLimitRoute = await import("../../../../src/app/api/rate-limit/route.ts");

// Installed only now — after proxyFetch has patched the global.
const unexpectedCalls: string[] = [];
const realFetch = globalThis.fetch;
async function stubFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  unexpectedCalls.push(url);
  throw new Error(`contract test blocked an unexpected outbound request: ${url}`);
}
globalThis.fetch = stubFetch;

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "dashboard-reads-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("dash-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("dash-readonly", "contract-test", ["read"])).key;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/batches and /api/batches/{id} ───────────────────────────────────────

it("GET /api/batches answers 401 without a credential", async () => {
  assert.equal((await batchesRoute.GET(req("http://localhost/api/batches"))).status, 401);
});

it("GET /api/batches answers 403 for a key without the manage scope", async () => {
  const response = await batchesRoute.GET(req("http://localhost/api/batches", "GET", readOnlyKey));
  assert.equal(response.status, 403);
});

it("GET /api/batches returns { batches: [] } on a fresh install", async () => {
  const response = await batchesRoute.GET(req("http://localhost/api/batches", "GET", manageKey));
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { batches: [] });
});

it("GET /api/batches/{id} answers 401 without a credential", async () => {
  const response = await batchRoute.GET(req("http://localhost/api/batches/b1"), {
    params: { id: "b1" },
  });
  assert.equal(response.status, 401);
});

it("GET /api/batches/{id} answers 404 for an unknown batch", async () => {
  const response = await batchRoute.GET(req("http://localhost/api/batches/b1", "GET", manageKey), {
    params: { id: "b1" },
  });
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Batch not found");
});

// ── /api/conversations/{id} ──────────────────────────────────────────────────

it("GET /api/conversations/{id} answers 401 without a credential", async () => {
  const response = await conversationRoute.GET(req("http://localhost/api/conversations/c1"), {
    params: Promise.resolve({ id: "c1" }),
  });
  assert.equal(response.status, 401);
});

it("GET /api/conversations/{id} answers 404 for an unknown conversation", async () => {
  const response = await conversationRoute.GET(
    req("http://localhost/api/conversations/c1", "GET", manageKey),
    { params: Promise.resolve({ id: "c1" }) }
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Not found");
});

// ── /api/combos/metrics ──────────────────────────────────────────────────────

const METRICS = "http://localhost/api/combos/metrics";

it("GET /api/combos/metrics answers 401 without a credential", async () => {
  assert.equal((await comboMetricsRoute.GET(req(METRICS))).status, 401);
});

it("GET /api/combos/metrics returns the metrics map, and null for one unknown combo", async () => {
  const all = await comboMetricsRoute.GET(req(METRICS, "GET", manageKey));
  assert.equal(all.status, 200);
  const body = await readJson<{ metrics: unknown }>(all);
  assert.notEqual(body.metrics, undefined);

  const one = await comboMetricsRoute.GET(req(`${METRICS}?combo=not-a-combo`, "GET", manageKey));
  assert.equal(one.status, 200, "an unmeasured combo is a 200 with a null, not a 404");
  const single = await readJson<{ metrics: null; message: string }>(one);
  assert.equal(single.metrics, null);
  assert.equal(single.message, "No metrics for this combo yet");
});

it("DELETE /api/combos/metrics resets all metrics, or one named combo", async () => {
  const one = await comboMetricsRoute.DELETE(req(`${METRICS}?combo=my-combo`, "DELETE", manageKey));
  assert.equal(one.status, 200);
  assert.deepEqual(await readJson<unknown>(one), {
    success: true,
    message: "Metrics reset for my-combo",
  });

  const all = await comboMetricsRoute.DELETE(req(METRICS, "DELETE", manageKey));
  assert.equal(all.status, 200);
  assert.deepEqual(await readJson<unknown>(all), {
    success: true,
    message: "All combo metrics reset",
  });
});

// ── /api/combos/reorder ──────────────────────────────────────────────────────

const REORDER = "http://localhost/api/combos/reorder";

it("POST /api/combos/reorder answers 401 without a credential", async () => {
  const response = await comboReorderRoute.POST(
    req(REORDER, "POST", undefined, { comboIds: ["a"] })
  );
  assert.equal(response.status, 401);
});

it("POST /api/combos/reorder rejects malformed JSON with a field-level 400", async () => {
  const response = await comboReorderRoute.POST(req(REORDER, "POST", manageKey, "{ nope"));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string; message: string }> } }>(
    response
  );
  assert.deepEqual(body.error.details, [{ field: "body", message: "Invalid JSON body" }]);
});

it("POST /api/combos/reorder rejects a body without comboIds with 400", async () => {
  const response = await comboReorderRoute.POST(req(REORDER, "POST", manageKey, {}));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
  assert.ok(body.error.details.some((detail) => detail.field.startsWith("comboIds")));
});

it("POST /api/combos/reorder rejects an empty comboIds array with 400", async () => {
  const response = await comboReorderRoute.POST(req(REORDER, "POST", manageKey, { comboIds: [] }));
  assert.equal(response.status, 400, "the schema requires at least one id");
  const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
  assert.ok(body.error.details.some((detail) => detail.field.startsWith("comboIds")));
});

it("POST /api/combos/reorder rejects duplicate ids with 400", async () => {
  const response = await comboReorderRoute.POST(
    req(REORDER, "POST", manageKey, { comboIds: ["a", "a"] })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ message: string }> } }>(response);
  assert.ok(body.error.details.some((detail) => detail.message === "comboIds must be unique"));
});

it("POST /api/combos/reorder returns the combo list and never syncs with cloud off", async () => {
  const response = await comboReorderRoute.POST(
    req(REORDER, "POST", manageKey, { comboIds: ["combo-that-does-not-exist"] })
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ combos: unknown[] }>(response);
  assert.ok(Array.isArray(body.combos));
  assert.deepEqual(unexpectedCalls, [], "cloud sync is off by default, so nothing is sent");
});

// ── /api/analytics/auto-routing and /api/omniroute/status ────────────────────

it("GET /api/analytics/auto-routing answers 401 without a credential", async () => {
  const response = await autoRoutingRoute.GET(req("http://localhost/api/analytics/auto-routing"));
  assert.equal(response.status, 401);
});

it("GET /api/analytics/auto-routing returns an object for a manage key", async () => {
  const response = await autoRoutingRoute.GET(
    req("http://localhost/api/analytics/auto-routing", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object");
});

it("GET /api/omniroute/status answers 401 without a credential", async () => {
  assert.equal(
    (await omnirouteStatusRoute.GET(req("http://localhost/api/omniroute/status"))).status,
    401
  );
});

it("GET /api/omniroute/status reports a generated snapshot with no live request", async () => {
  const response = await omnirouteStatusRoute.GET(
    req("http://localhost/api/omniroute/status", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ generatedAt: string; liveRequestExecuted: boolean }>(response);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.equal(body.liveRequestExecuted, false, "building the status never issues a live request");
  assert.deepEqual(unexpectedCalls, []);
});

// ── /api/network/info ────────────────────────────────────────────────────────

it("GET /api/network/info answers 401 without a credential", async () => {
  const response = await networkInfoRoute.GET(req("http://localhost/api/network/info"));
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("GET /api/network/info returns the local, LAN and tailscale URLs", async () => {
  const response = await networkInfoRoute.GET(
    req("http://localhost/api/network/info", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    localUrl: string;
    lanUrls: string[];
    tailscaleIpUrl: string | null;
  }>(response);
  assert.match(body.localUrl, /^http:\/\/localhost:\d+\/v1$/);
  assert.ok(Array.isArray(body.lanUrls));
  for (const url of body.lanUrls) assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/v1$/);
  assert.ok(body.tailscaleIpUrl === null || body.tailscaleIpUrl.endsWith("/v1"));
});

// ── /api/rate-limit (deprecated) ─────────────────────────────────────────────

it("GET /api/rate-limit is a 308 redirect to /api/rate-limits", async () => {
  const response = await rateLimitRoute.GET(req("http://localhost/api/rate-limit?x=1"));
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/api/rate-limits?x=1",
    "the query string survives the redirect"
  );
});

it("POST /api/rate-limit is a 308 redirect to /api/rate-limits", async () => {
  const response = await rateLimitRoute.POST(req("http://localhost/api/rate-limit", "POST"));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "http://localhost/api/rate-limits");
});
