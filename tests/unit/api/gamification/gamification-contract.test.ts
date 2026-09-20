// Contract tests for the /api/gamification routes.
//
// Covers all ten routes the governance baseline listed as untested:
//   anomalies, badges, badges/earned, invite, invite/redeem, notifications,
//   rotate, servers, stream, transfer
//
// Every one of them is management-scoped via `requireManagementAuth`, so the
// contract starts with the auth ladder (401 anonymous / 403 under-scoped) and
// then covers the documented success envelope, the CORS headers these routes
// promise, and the 400 bodies for missing query params and invalid payloads.
//
// The two SSE routes are asserted on their response headers and then aborted
// immediately, so no interval outlives the test.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gamification-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "gamification-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const anomaliesRoute = await import("../../../../src/app/api/gamification/anomalies/route.ts");
const badgesRoute = await import("../../../../src/app/api/gamification/badges/route.ts");
const earnedRoute = await import("../../../../src/app/api/gamification/badges/earned/route.ts");
const inviteRoute = await import("../../../../src/app/api/gamification/invite/route.ts");
const redeemRoute = await import("../../../../src/app/api/gamification/invite/redeem/route.ts");
const notificationsRoute =
  await import("../../../../src/app/api/gamification/notifications/route.ts");
const rotateRoute = await import("../../../../src/app/api/gamification/rotate/route.ts");
const serversRoute = await import("../../../../src/app/api/gamification/servers/route.ts");
const streamRoute = await import("../../../../src/app/api/gamification/stream/route.ts");
const transferRoute = await import("../../../../src/app/api/gamification/transfer/route.ts");

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * The handlers are typed against `NextRequest`, which is a `Request` plus
 * `nextUrl`/`cookies`. Every assertion here exercises only the `Request`
 * surface (url, headers, json, signal), so a plain `Request` is the honest
 * input; this helper is the single place that states that.
 */
function nextRequest(url: string, init?: RequestInit): Parameters<typeof badgesRoute.GET>[0] {
  const request = new Request(url, init);
  return request as unknown as Parameters<typeof badgesRoute.GET>[0];
}

function get(url: string, apiKey?: string) {
  return nextRequest(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
}

function send(url: string, method: string, body: unknown, apiKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return nextRequest(url, { method, headers, body: JSON.stringify(body) });
}

function del(url: string, apiKey: string) {
  return nextRequest(url, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } });
}

/** Drive an SSE route and abort it right away so no interval outlives the test. */
async function openAndAbortStream(
  handler: (request: Parameters<typeof streamRoute.GET>[0]) => Promise<Response>,
  url: string,
  apiKey: string
): Promise<Response> {
  const controller = new AbortController();
  const request = new Request(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  });
  const response = await handler(request as unknown as Parameters<typeof streamRoute.GET>[0]);
  controller.abort();
  await response.body?.cancel().catch(() => {});
  return response;
}

let manageKey = "";
let readOnlyKey = "";
let subjectKeyId = "";
let otherKeyId = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "gamification-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("gamification-manage", "contract-test", ["manage"]))
    .key;
  readOnlyKey = (await apiKeysDb.createApiKey("gamification-readonly", "contract-test", ["read"]))
    .key;
  subjectKeyId = (await apiKeysDb.createApiKey("gamification-subject", "contract-test", [])).id;
  otherKeyId = (await apiKeysDb.createApiKey("gamification-other", "contract-test", [])).id;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/gamification/anomalies ──────────────────────────────────────────────

it("GET /api/gamification/anomalies answers 401 without a credential", async () => {
  const response = await anomaliesRoute.GET(get("http://localhost/api/gamification/anomalies"));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/anomalies answers 403 for a key without the manage scope", async () => {
  const response = await anomaliesRoute.GET(
    get("http://localhost/api/gamification/anomalies", readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("GET /api/gamification/anomalies returns { anomalies } with CORS headers", async () => {
  const response = await anomaliesRoute.GET(
    get("http://localhost/api/gamification/anomalies", manageKey)
  );
  assert.equal(response.status, 200);
  // The route ships CORS_HEADERS; the allowed *origin* is overlaid by the
  // middleware on the way out, so it is deliberately absent here.
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await readJson<{ anomalies: unknown[] }>(response);
  assert.ok(Array.isArray(body.anomalies));
});

it("OPTIONS /api/gamification/anomalies answers the CORS preflight", async () => {
  const response = await anomaliesRoute.OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/);
});

// ── /api/gamification/badges and badges/earned ───────────────────────────────

it("GET /api/gamification/badges answers 401 without a credential", async () => {
  const response = await badgesRoute.GET(get("http://localhost/api/gamification/badges"));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/badges seeds and returns the built-in badge catalog", async () => {
  const response = await badgesRoute.GET(
    get("http://localhost/api/gamification/badges", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ badges: Array<{ id: string; category: string }> }>(response);
  assert.ok(Array.isArray(body.badges));
  assert.ok(body.badges.length > 0, "the built-in badges are seeded on first read");
  for (const badge of body.badges) {
    assert.equal(typeof badge.id, "string");
  }
});

it("GET /api/gamification/badges?category= filters the catalog", async () => {
  const all = await readJson<{ badges: Array<{ category: string }> }>(
    await badgesRoute.GET(get("http://localhost/api/gamification/badges", manageKey))
  );
  const category = all.badges[0].category;

  const filtered = await badgesRoute.GET(
    get(`http://localhost/api/gamification/badges?category=${category}`, manageKey)
  );
  assert.equal(filtered.status, 200);
  const body = await readJson<{ badges: Array<{ category: string }> }>(filtered);
  assert.ok(body.badges.length > 0);
  assert.ok(body.badges.every((badge) => badge.category === category));
});

it("GET /api/gamification/badges/earned answers 401 without a credential", async () => {
  const response = await earnedRoute.GET(get("http://localhost/api/gamification/badges/earned"));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/badges/earned returns an empty set for a fresh key", async () => {
  const response = await earnedRoute.GET(
    get(`http://localhost/api/gamification/badges/earned?apiKeyId=${subjectKeyId}`, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ badges: unknown[] }>(response);
  assert.deepEqual(body.badges, []);
});

// ── /api/gamification/invite and invite/redeem ───────────────────────────────

const INVITE_URL = "http://localhost/api/gamification/invite";

it("GET /api/gamification/invite answers 401 without a credential", async () => {
  const response = await inviteRoute.GET(get(`${INVITE_URL}?apiKeyId=${subjectKeyId}`));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/invite requires the apiKeyId query param", async () => {
  const response = await inviteRoute.GET(get(INVITE_URL, manageKey));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "apiKeyId required");
});

it("POST /api/gamification/invite rejects a malformed JSON body with 400", async () => {
  const response = await inviteRoute.POST(
    nextRequest(INVITE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: "{ not json",
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
});

it("POST /api/gamification/invite rejects a missing apiKeyId with 400 and issue details", async () => {
  const response = await inviteRoute.POST(send(INVITE_URL, "POST", { maxUses: 2 }, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string; details: Array<{ path: string[] }> }>(response);
  assert.equal(body.error, "Invalid request");
  assert.ok(body.details.some((issue) => issue.path.includes("apiKeyId")));
});

it("POST then GET then DELETE /api/gamification/invite round-trips an invite", async () => {
  const created = await inviteRoute.POST(
    send(INVITE_URL, "POST", { apiKeyId: subjectKeyId, maxUses: 3 }, manageKey)
  );
  assert.equal(created.status, 201);
  const invite = await readJson<{ code: string; token: string }>(created);
  assert.equal(typeof invite.code, "string");
  assert.ok(invite.code.length > 0);

  const listed = await inviteRoute.GET(get(`${INVITE_URL}?apiKeyId=${subjectKeyId}`, manageKey));
  assert.equal(listed.status, 200);
  const invites = await readJson<{ invites: Array<{ id: string; code: string }> }>(listed);
  const found = invites.invites.find((entry) => entry.code === invite.code);
  assert.ok(found, "the created invite is listed for its owner");

  const revoked = await inviteRoute.DELETE(del(`${INVITE_URL}?id=${found.id}`, manageKey));
  assert.equal(revoked.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(revoked), { success: true });
});

it("DELETE /api/gamification/invite requires the id query param", async () => {
  const response = await inviteRoute.DELETE(del(INVITE_URL, manageKey));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "id required");
});

it("POST /api/gamification/invite/redeem answers 401 without a credential", async () => {
  const response = await redeemRoute.POST(
    nextRequest("http://localhost/api/gamification/invite/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x", apiKeyId: subjectKeyId }),
    })
  );
  assert.equal(response.status, 401);
});

it("POST /api/gamification/invite/redeem rejects an unknown code with 400", async () => {
  const response = await redeemRoute.POST(
    send(
      "http://localhost/api/gamification/invite/redeem",
      "POST",
      { code: "definitely-not-a-real-code", apiKeyId: otherKeyId },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string }>(response);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0, "the rejection explains why");
});

it("POST /api/gamification/invite/redeem rejects a missing code with 400", async () => {
  const response = await redeemRoute.POST(
    send(
      "http://localhost/api/gamification/invite/redeem",
      "POST",
      { apiKeyId: otherKeyId },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid request");
});

// ── /api/gamification/rotate ─────────────────────────────────────────────────

const ROTATE_URL = "http://localhost/api/gamification/rotate";

it("POST /api/gamification/rotate answers 401 without a credential", async () => {
  const response = await rotateRoute.POST(
    nextRequest(ROTATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "weekly" }),
    })
  );
  assert.equal(response.status, 401);
});

it("POST /api/gamification/rotate rejects an unknown scope with 400", async () => {
  const response = await rotateRoute.POST(send(ROTATE_URL, "POST", { scope: "daily" }, manageKey));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid request");
});

it("POST /api/gamification/rotate rotates a documented scope", async () => {
  const response = await rotateRoute.POST(send(ROTATE_URL, "POST", { scope: "weekly" }, manageKey));
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ success: boolean; scope: string }>(response), {
    success: true,
    scope: "weekly",
  });
});

// ── /api/gamification/servers ────────────────────────────────────────────────

const SERVERS_URL = "http://localhost/api/gamification/servers";

it("GET /api/gamification/servers answers 401 without a credential", async () => {
  const response = await serversRoute.GET(get(SERVERS_URL));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/servers returns { servers }", async () => {
  const response = await serversRoute.GET(get(SERVERS_URL, manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{ servers: unknown[] }>(response);
  assert.ok(Array.isArray(body.servers));
});

it("POST /api/gamification/servers rejects a non-URL with 400", async () => {
  const response = await serversRoute.POST(
    send(SERVERS_URL, "POST", { name: "peer", url: "not-a-url", apiKey: "k" }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string; details: Array<{ path: string[] }> }>(response);
  assert.equal(body.error, "Invalid request");
  assert.ok(body.details.some((issue) => issue.path.includes("url")));
});

it("POST /api/gamification/servers refuses a loopback federation URL with 400", async () => {
  const response = await serversRoute.POST(
    send(
      SERVERS_URL,
      "POST",
      { name: "peer", url: "http://127.0.0.1:9/peer", apiKey: "k" },
      manageKey
    )
  );
  assert.equal(response.status, 400, "the SSRF guard rejects it as a client error");
  const body = await readJson<{ error: string }>(response);
  assert.ok(body.error.length > 0);

  const listed = await readJson<{ servers: unknown[] }>(
    await serversRoute.GET(get(SERVERS_URL, manageKey))
  );
  assert.deepEqual(listed.servers, [], "a refused server URL is never persisted");
});

it("DELETE /api/gamification/servers requires the id query param", async () => {
  const response = await serversRoute.DELETE(del(SERVERS_URL, manageKey));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "id required");
});

// ── /api/gamification/transfer ───────────────────────────────────────────────

const TRANSFER_URL = "http://localhost/api/gamification/transfer";

it("GET /api/gamification/transfer answers 401 without a credential", async () => {
  const response = await transferRoute.GET(get(`${TRANSFER_URL}?apiKeyId=${subjectKeyId}`));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/transfer requires the apiKeyId query param", async () => {
  const response = await transferRoute.GET(get(TRANSFER_URL, manageKey));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "apiKeyId required");
});

it("GET /api/gamification/transfer returns { balance, history }", async () => {
  const response = await transferRoute.GET(
    get(`${TRANSFER_URL}?apiKeyId=${subjectKeyId}`, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ balance: unknown; history: unknown[] }>(response);
  assert.notEqual(body.balance, undefined);
  assert.ok(Array.isArray(body.history));
});

it("POST /api/gamification/transfer rejects a non-positive amount with 400", async () => {
  const response = await transferRoute.POST(
    send(
      TRANSFER_URL,
      "POST",
      { fromApiKeyId: subjectKeyId, toApiKeyId: otherKeyId, amount: 0 },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string; details: Array<{ path: string[] }> }>(response);
  assert.equal(body.error, "Invalid request");
  assert.ok(body.details.some((issue) => issue.path.includes("amount")));
});

it("POST /api/gamification/transfer refuses a transfer with no balance", async () => {
  const response = await transferRoute.POST(
    send(
      TRANSFER_URL,
      "POST",
      { fromApiKeyId: subjectKeyId, toApiKeyId: otherKeyId, amount: 1_000_000 },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string }>(response);
  assert.ok(body.error.length > 0, "the refusal explains why");
});

// ── SSE routes: /api/gamification/stream and /notifications ──────────────────

it("GET /api/gamification/stream answers 401 without a credential", async () => {
  const response = await streamRoute.GET(get("http://localhost/api/gamification/stream"));
  assert.equal(response.status, 401);
});

it("GET /api/gamification/stream opens a text/event-stream response", async () => {
  const response = await openAndAbortStream(
    streamRoute.GET,
    "http://localhost/api/gamification/stream?scope=weekly",
    manageKey
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache");
});

it("GET /api/gamification/notifications answers 401 without a credential", async () => {
  const response = await notificationsRoute.GET(
    get(`http://localhost/api/gamification/notifications?apiKeyId=${subjectKeyId}`)
  );
  assert.equal(response.status, 401);
});

it("GET /api/gamification/notifications requires the apiKeyId query param", async () => {
  const response = await notificationsRoute.GET(
    get("http://localhost/api/gamification/notifications", manageKey)
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await readJson<{ error: string }>(response)).error, "apiKeyId required");
});

it("GET /api/gamification/notifications opens a text/event-stream response", async () => {
  const response = await openAndAbortStream(
    notificationsRoute.GET,
    `http://localhost/api/gamification/notifications?apiKeyId=${subjectKeyId}`,
    manageKey
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
});
