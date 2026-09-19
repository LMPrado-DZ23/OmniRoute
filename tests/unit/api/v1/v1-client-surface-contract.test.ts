// Contract tests for the remaining client-facing /v1 routes.
//
//   GET /api/v1/combos            GET /api/v1/explain/routing
//   GET /api/v1/muse-code/models  GET /api/v1/search/analytics
//   GET /api/v1/agents/health     GET|POST|DELETE /api/v1/agents/tasks/{id}
//
// These are what an end user's client actually calls, so the contract pinned
// here is the auth model each one uses (they differ on purpose), the documented
// envelope, and the 400/404 paths.
//
// /api/v1/agents/health is driven with NO cloud-agent credentials configured,
// which is the fresh-install state: every provider short-circuits to
// "No credentials configured" before any outbound call is attempted.
//
// NO NETWORK: globalThis.fetch is replaced after the route imports by a stub
// that throws on every URL, so an accidental outbound call fails loudly.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-client-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "v1-client-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const combosRoute = await import("../../../../src/app/api/v1/combos/route.ts");
const explainRoute = await import("../../../../src/app/api/v1/explain/routing/route.ts");
const museModelsRoute = await import("../../../../src/app/api/v1/muse-code/models/route.ts");
const searchAnalyticsRoute = await import("../../../../src/app/api/v1/search/analytics/route.ts");
const agentsHealthRoute = await import("../../../../src/app/api/v1/agents/health/route.ts");
const agentTaskRoute = await import("../../../../src/app/api/v1/agents/tasks/[id]/route.ts");

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

/** These handlers are typed against NextRequest but only use the Request surface. */
function nextRequest(url: string, init?: RequestInit): Parameters<typeof agentsHealthRoute.GET>[0] {
  return new Request(url, init) as unknown as Parameters<typeof agentsHealthRoute.GET>[0];
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

const ORIGINAL_REQUIRE_API_KEY = process.env.REQUIRE_API_KEY;
let manageKey = "";
let clientKey = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "v1-client-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("v1-manage", "contract-test", ["manage"])).key;
  clientKey = (await apiKeysDb.createApiKey("v1-client", "contract-test", ["read"])).key;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  if (ORIGINAL_REQUIRE_API_KEY === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = ORIGINAL_REQUIRE_API_KEY;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── GET /api/v1/combos ───────────────────────────────────────────────────────

const COMBOS = "http://localhost/api/v1/combos";

it("GET /api/v1/combos answers 401 anonymously when REQUIRE_API_KEY is on", async () => {
  process.env.REQUIRE_API_KEY = "true";
  try {
    const response = await combosRoute.GET(req(COMBOS));
    assert.equal(response.status, 401);
    const body = await readJson<{ error: { message: string } }>(response);
    assert.match(body.error.message, /Authentication required/i);
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }
});

it("GET /api/v1/combos accepts a plain API key and returns an OpenAI-style list", async () => {
  process.env.REQUIRE_API_KEY = "true";
  try {
    const response = await combosRoute.GET(req(COMBOS, "GET", clientKey));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await readJson<{ object: string; data: unknown[] }>(response);
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }
});

it("GET /api/v1/combos allows an anonymous read when REQUIRE_API_KEY is off", async () => {
  process.env.REQUIRE_API_KEY = "false";
  try {
    const response = await combosRoute.GET(req(COMBOS));
    assert.equal(response.status, 200, "the documented local-first behaviour");
    assert.equal((await readJson<{ object: string }>(response)).object, "list");
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }
});

it("OPTIONS /api/v1/combos advertises GET on the preflight", async () => {
  const response = await combosRoute.OPTIONS();
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

// ── GET /api/v1/explain/routing ──────────────────────────────────────────────

const EXPLAIN = "http://localhost/api/v1/explain/routing";

it("GET /api/v1/explain/routing answers 401 anonymously when REQUIRE_API_KEY is on", async () => {
  process.env.REQUIRE_API_KEY = "true";
  try {
    assert.equal((await explainRoute.GET(req(EXPLAIN))).status, 401);
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }
});

it("GET /api/v1/explain/routing returns routing metadata and never prompt content", async () => {
  const response = await explainRoute.GET(req(EXPLAIN, "GET", clientKey));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await readJson<{
    object: string;
    events: unknown[];
    quality: unknown[];
    otelEnabled: boolean;
  }>(response);
  assert.equal(body.object, "routing_explain");
  assert.ok(Array.isArray(body.events));
  assert.ok(Array.isArray(body.quality));
  assert.equal(typeof body.otelEnabled, "boolean");
});

it("GET /api/v1/explain/routing clamps ?limit to the documented maximum", async () => {
  const response = await explainRoute.GET(req(`${EXPLAIN}?limit=99999`, "GET", clientKey));
  assert.equal(response.status, 200, "an oversized limit is clamped, not rejected");
  const body = await readJson<{ events: unknown[] }>(response);
  assert.ok(body.events.length <= 500);
});

// ── GET /api/v1/muse-code/models ─────────────────────────────────────────────

it("GET /api/v1/muse-code/models serves the public catalog in the Muse format", async () => {
  const response = await museModelsRoute.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  const body = await readJson<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      created: number;
      owned_by: string;
      metadata: { name: string; family: string; reasoning: boolean; tool_call: boolean };
    }>;
  }>(response);
  assert.equal(body.object, "list");
  assert.ok(body.data.length > 0, "the catalog is not empty");
  for (const model of body.data) {
    assert.equal(model.object, "model");
    assert.equal(typeof model.id, "string");
    assert.equal(typeof model.created, "number");
    assert.equal(typeof model.metadata.name, "string");
    assert.equal(typeof model.metadata.reasoning, "boolean");
    assert.equal(typeof model.metadata.tool_call, "boolean");
  }
});

// ── GET /api/v1/search/analytics ─────────────────────────────────────────────

it("GET /api/v1/search/analytics returns zeroed stats on a fresh install", async () => {
  const response = await searchAnalyticsRoute.GET(
    req("http://localhost/api/v1/search/analytics", "GET", clientKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    total: number;
    today: number;
    cached: number;
    errors: number;
    totalCostUsd: number;
    byProvider: Record<string, unknown>;
    cacheHitRate: number;
    avgDurationMs: number;
    last24h: unknown[];
  }>(response);
  assert.equal(body.total, 0);
  assert.equal(body.today, 0);
  assert.equal(body.errors, 0);
  assert.equal(body.totalCostUsd, 0);
  assert.equal(body.cacheHitRate, 0, "0 searches must not divide by zero");
  assert.equal(body.avgDurationMs, 0);
  assert.deepEqual(body.byProvider, {});
  assert.deepEqual(body.last24h, []);
});

// ── GET /api/v1/agents/health ────────────────────────────────────────────────

const AGENTS_HEALTH = "http://localhost/api/v1/agents/health";

it("GET /api/v1/agents/health answers 401 without a credential", async () => {
  assert.equal((await agentsHealthRoute.GET(nextRequest(AGENTS_HEALTH))).status, 401);
});

it("GET /api/v1/agents/health answers 403 for a key without the manage scope", async () => {
  const response = await agentsHealthRoute.GET(
    nextRequest(AGENTS_HEALTH, { headers: { Authorization: `Bearer ${clientKey}` } })
  );
  assert.equal(response.status, 403);
});

it("GET /api/v1/agents/health reports every provider as unconfigured, with no probe", async () => {
  const response = await agentsHealthRoute.GET(
    nextRequest(AGENTS_HEALTH, { headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    providers: Array<{ id: string; name: string; connected: boolean; error?: string }>;
  }>(response);
  assert.ok(Array.isArray(body.providers));
  assert.ok(body.providers.length > 0);
  for (const provider of body.providers) {
    assert.equal(provider.connected, false);
    assert.equal(provider.error, "No credentials configured");
  }
  assert.deepEqual(unexpectedCalls, [], "an unconfigured provider is never probed");
});

// ── /api/v1/agents/tasks/{id} ────────────────────────────────────────────────

const TASK = "http://localhost/api/v1/agents/tasks/task-1";

it("GET /api/v1/agents/tasks/{id} answers 401 without a credential", async () => {
  const response = await agentTaskRoute.GET(nextRequest(TASK), idParams("task-1"));
  assert.equal(response.status, 401);
});

it("GET /api/v1/agents/tasks/{id} answers 404 for an unknown task", async () => {
  const response = await agentTaskRoute.GET(
    nextRequest(TASK, { headers: { Authorization: `Bearer ${manageKey}` } }),
    idParams("task-1")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Task not found");
});

it("POST /api/v1/agents/tasks/{id} answers 404 for an unknown task", async () => {
  const response = await agentTaskRoute.POST(
    nextRequest(TASK, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ action: "cancel" }),
    }),
    idParams("task-1")
  );
  assert.equal(response.status, 404);
  assert.deepEqual(unexpectedCalls, [], "an unknown task never reaches a cloud agent");
});

it("DELETE /api/v1/agents/tasks/{id} answers 401 without a credential", async () => {
  const response = await agentTaskRoute.DELETE(
    nextRequest(TASK, { method: "DELETE" }),
    idParams("task-1")
  );
  assert.equal(response.status, 401);
});
