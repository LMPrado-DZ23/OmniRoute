// Contract tests for the remaining /api/settings routes in the governance
// baseline: the integration connectors, the proxy registry helpers and the
// usage-history purge.
//
//   GET/PUT    /api/settings/auto-disable-accounts
//   GET/POST/DELETE /api/settings/{notion,obsidian,local-corpus}
//   POST       /api/settings/oneproxy/rotate
//   POST       /api/settings/proxies/bulk-import
//   POST       /api/settings/proxies/migrate
//   POST       /api/settings/purge-usage-history
//
// SCOPE NOTE — the Notion and Obsidian POST happy paths are deliberately NOT
// covered. Those validate the supplied token by calling the vendor through
// `guardedFetch`, which dispatches via undici (NOT globalThis.fetch) and
// resolves the hostname through a pinned DNS lookup BEFORE its test seam is
// reached, so it cannot be driven offline. Everything that returns before that
// call — auth, JSON parsing, schema, and Obsidian's port-27124 guard — is
// covered here, and the token-validation path stays out of scope.
//
// NO NETWORK: globalThis.fetch is replaced after the route imports by a stub
// that throws on every URL, so any accidental outbound call fails loudly.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-integr-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "settings-integrations-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const autoDisableRoute =
  await import("../../../../src/app/api/settings/auto-disable-accounts/route.ts");
const notionRoute = await import("../../../../src/app/api/settings/notion/route.ts");
const obsidianRoute = await import("../../../../src/app/api/settings/obsidian/route.ts");
const localCorpusRoute = await import("../../../../src/app/api/settings/local-corpus/route.ts");
const oneproxyRotateRoute =
  await import("../../../../src/app/api/settings/oneproxy/rotate/route.ts");
const bulkImportRoute =
  await import("../../../../src/app/api/settings/proxies/bulk-import/route.ts");
const migrateRoute = await import("../../../../src/app/api/settings/proxies/migrate/route.ts");
const purgeUsageRoute =
  await import("../../../../src/app/api/settings/purge-usage-history/route.ts");

// Installed only now — after proxyFetch has patched the global.
const unexpectedCalls: string[] = [];
const realFetch = globalThis.fetch;
async function stubFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  unexpectedCalls.push(url);
  throw new Error(`contract test blocked an unexpected outbound request: ${url}`);
}
globalThis.fetch = stubFetch;

type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string }> };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** These handlers are typed against NextRequest but only use the Request surface. */
function nextRequest(url: string, init?: RequestInit): Parameters<typeof notionRoute.GET>[0] {
  return new Request(url, init) as unknown as Parameters<typeof notionRoute.GET>[0];
}

function send(url: string, method: string, body?: unknown, apiKey?: string): Request {
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
let corpusDir = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "settings-integrations-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("integr-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("integr-readonly", "contract-test", ["read"])).key;
  corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-corpus-"));
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  for (const dir of [TEST_DATA_DIR, corpusDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── /api/settings/auto-disable-accounts ──────────────────────────────────────

const AUTO_DISABLE = "http://localhost/api/settings/auto-disable-accounts";

it("GET /api/settings/auto-disable-accounts answers 401 without a credential", async () => {
  assert.equal((await autoDisableRoute.GET(send(AUTO_DISABLE, "GET"))).status, 401);
});

it("PUT /api/settings/auto-disable-accounts answers 403 for a key without manage", async () => {
  const response = await autoDisableRoute.PUT(
    send(AUTO_DISABLE, "PUT", { enabled: true }, readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("GET /api/settings/auto-disable-accounts returns the { enabled, threshold, scope } view", async () => {
  const response = await autoDisableRoute.GET(send(AUTO_DISABLE, "GET", undefined, manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{ enabled: boolean; threshold: number; scope: string }>(response);
  assert.equal(typeof body.enabled, "boolean");
  assert.equal(body.threshold, 3, "the documented default threshold");
  assert.equal(typeof body.scope, "string");
});

it("PUT /api/settings/auto-disable-accounts persists and reads back", async () => {
  const response = await autoDisableRoute.PUT(
    send(AUTO_DISABLE, "PUT", { enabled: true, threshold: 7 }, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ enabled: boolean; threshold: number }>(response);
  assert.equal(body.enabled, true);
  assert.equal(body.threshold, 7);

  const read = await readJson<{ enabled: boolean; threshold: number }>(
    await autoDisableRoute.GET(send(AUTO_DISABLE, "GET", undefined, manageKey))
  );
  assert.deepEqual([read.enabled, read.threshold], [true, 7]);
});

it("PUT /api/settings/auto-disable-accounts rejects an out-of-range threshold with 400", async () => {
  const response = await autoDisableRoute.PUT(
    send(AUTO_DISABLE, "PUT", { enabled: true, threshold: 99 }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["threshold"]
  );
});

it("PUT /api/settings/auto-disable-accounts rejects malformed JSON with a field-level 400", async () => {
  const response = await autoDisableRoute.PUT(send(AUTO_DISABLE, "PUT", "{ nope", manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(body.error.details, [{ field: "body", message: "Invalid JSON body" }]);
});

// ── /api/settings/notion ─────────────────────────────────────────────────────

const NOTION = "http://localhost/api/settings/notion";

it("GET /api/settings/notion answers 401 without a credential", async () => {
  assert.equal((await notionRoute.GET(nextRequest(NOTION))).status, 401);
});

it("GET /api/settings/notion reports a disconnected integration and never a token", async () => {
  const response = await notionRoute.GET(
    nextRequest(NOTION, { headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ connected: boolean; hasToken: boolean }>(response);
  assert.deepEqual(body, { connected: false, hasToken: false });
  assert.equal("token" in body, false);
});

it("POST /api/settings/notion rejects malformed JSON and an unknown field with 400", async () => {
  const badJson = await notionRoute.POST(
    nextRequest(NOTION, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: "{ nope",
    })
  );
  assert.equal(badJson.status, 400);
  assert.equal((await readJson<{ error: string }>(badJson)).error, "Invalid JSON body");

  const unknownField = await notionRoute.POST(
    nextRequest(NOTION, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ token: "secret-token", extra: true }),
    })
  );
  assert.equal(unknownField.status, 400, "the schema is .strict()");
  assert.equal((await readJson<{ error: string }>(unknownField)).error, "Missing or invalid token");
  assert.deepEqual(unexpectedCalls, [], "a rejected body never reaches the vendor");
});

it("DELETE /api/settings/notion disconnects the integration", async () => {
  const response = await notionRoute.DELETE(
    nextRequest(NOTION, { method: "DELETE", headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ connected: boolean; message: string }>(response);
  assert.equal(body.connected, false);
  assert.match(body.message, /disconnected/);
});

// ── /api/settings/obsidian ───────────────────────────────────────────────────

const OBSIDIAN = "http://localhost/api/settings/obsidian";

it("GET /api/settings/obsidian answers 401 without a credential", async () => {
  assert.equal((await obsidianRoute.GET(nextRequest(OBSIDIAN))).status, 401);
});

it("GET /api/settings/obsidian returns the connection view without the token", async () => {
  const response = await obsidianRoute.GET(
    nextRequest(OBSIDIAN, { headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ connected: boolean; hasToken: boolean }>(response);
  assert.equal(body.connected, false);
  assert.equal(body.hasToken, false);
  assert.equal("token" in body, false);
});

it("POST /api/settings/obsidian refuses the MCP port 27124 with a 400 that explains why", async () => {
  const response = await obsidianRoute.POST(
    nextRequest(OBSIDIAN, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ token: "t", baseUrl: "https://192.0.2.10:27124" }),
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: string; connected: boolean }>(response);
  assert.equal(body.connected, false);
  assert.match(body.error, /27123/, "the message names the correct REST port");
  assert.deepEqual(unexpectedCalls, [], "the guard returns before any outbound call");
});

it("POST /api/settings/obsidian rejects a non-URL baseUrl with 400", async () => {
  const response = await obsidianRoute.POST(
    nextRequest(OBSIDIAN, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ token: "t", baseUrl: "not a url" }),
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Missing or invalid token");
});

it("DELETE /api/settings/obsidian disconnects the integration", async () => {
  const response = await obsidianRoute.DELETE(
    nextRequest(OBSIDIAN, { method: "DELETE", headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 200);
  assert.equal((await readJson<{ connected: boolean }>(response)).connected, false);
});

// ── /api/settings/local-corpus ───────────────────────────────────────────────

const CORPUS = "http://localhost/api/settings/local-corpus";

it("GET /api/settings/local-corpus answers 401 without a credential", async () => {
  assert.equal((await localCorpusRoute.GET(nextRequest(CORPUS))).status, 401);
});

it("POST/GET/DELETE /api/settings/local-corpus round-trips a corpus root", async () => {
  const saved = await localCorpusRoute.POST(
    nextRequest(CORPUS, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ rootPath: corpusDir }),
    })
  );
  assert.equal(saved.status, 200);
  const savedBody = await readJson<{ configured: boolean; rootPath: string; message: string }>(
    saved
  );
  assert.equal(savedBody.configured, true);
  assert.equal(savedBody.rootPath, fs.realpathSync(corpusDir), "the stored path is canonical");
  assert.match(savedBody.message, /remains on the local filesystem/);

  const read = await localCorpusRoute.GET(
    nextRequest(CORPUS, { headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(read.status, 200);
  assert.equal((await readJson<{ rootPath: string }>(read)).rootPath, fs.realpathSync(corpusDir));

  const cleared = await localCorpusRoute.DELETE(
    nextRequest(CORPUS, { method: "DELETE", headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(cleared.status, 200);
  const clearedBody = await readJson<{ configured: boolean; message: string }>(cleared);
  assert.equal(clearedBody.configured, false);
  assert.match(clearedBody.message, /Source files were not modified/);
});

it("POST /api/settings/local-corpus rejects a relative path with 400", async () => {
  const response = await localCorpusRoute.POST(
    nextRequest(CORPUS, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ rootPath: "./relative" }),
    })
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<{ error: string }>(response)).error, /absolute/);
});

it("POST /api/settings/local-corpus rejects a path that does not exist with 400", async () => {
  const missing = path.join(corpusDir, "definitely-missing");
  const response = await localCorpusRoute.POST(
    nextRequest(CORPUS, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: JSON.stringify({ rootPath: missing }),
    })
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<{ error: string }>(response)).error, /not accessible/);
});

// ── /api/settings/oneproxy/rotate ────────────────────────────────────────────

it("POST /api/settings/oneproxy/rotate answers 401 without a credential", async () => {
  const response = await oneproxyRotateRoute.POST(
    send("http://localhost/api/settings/oneproxy/rotate", "POST")
  );
  assert.equal(response.status, 401);
});

it("POST /api/settings/oneproxy/rotate is a 308 compat redirect to the sync route", async () => {
  const response = await oneproxyRotateRoute.POST(
    send("http://localhost/api/settings/oneproxy/rotate", "POST", undefined, manageKey)
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/api/settings/free-proxies/sync");
  assert.equal(await response.text(), "");
});

// ── /api/settings/proxies/bulk-import and /migrate ───────────────────────────

const BULK = "http://localhost/api/settings/proxies/bulk-import";

it("POST /api/settings/proxies/bulk-import answers 401 without a credential", async () => {
  assert.equal((await bulkImportRoute.POST(send(BULK, "POST", { items: [] }))).status, 401);
});

it("POST /api/settings/proxies/bulk-import imports and reports per-item results", async () => {
  const response = await bulkImportRoute.POST(
    send(
      BULK,
      "POST",
      {
        items: [
          { name: "proxy-a", host: "198.51.100.10", port: 8080, type: "http" },
          { name: "proxy-b", host: "198.51.100.11", port: 1080, type: "socks5" },
        ],
      },
      manageKey
    )
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    created: number;
    updated: number;
    failed: number;
    results: Array<{ name: string; success: boolean; action?: string; id?: string }>;
  }>(response);
  assert.equal(body.created, 2);
  assert.equal(body.failed, 0);
  assert.equal(body.results.length, 2);
  assert.ok(body.results.every((result) => result.success && result.action === "created"));
});

it("POST /api/settings/proxies/bulk-import rejects an empty list with 400", async () => {
  const response = await bulkImportRoute.POST(send(BULK, "POST", { items: [] }, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { message: string; details: unknown } }>(response);
  assert.equal(body.error.message, "Invalid request");
});

it("POST /api/settings/proxies/bulk-import rejects an out-of-range port with 400", async () => {
  const response = await bulkImportRoute.POST(
    send(BULK, "POST", { items: [{ name: "bad", host: "h", port: 99999 }] }, manageKey)
  );
  assert.equal(response.status, 400);
});

it("POST /api/settings/proxies/migrate answers 401, then reports a migration result", async () => {
  const anonymous = await migrateRoute.POST(
    send("http://localhost/api/settings/proxies/migrate", "POST", {})
  );
  assert.equal(anonymous.status, 401);

  const response = await migrateRoute.POST(
    send("http://localhost/api/settings/proxies/migrate", "POST", {}, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object");
});

it("POST /api/settings/proxies/migrate rejects malformed JSON with a coded 400", async () => {
  const response = await migrateRoute.POST(
    send("http://localhost/api/settings/proxies/migrate", "POST", "{ nope", manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { message: string; type: string } }>(response);
  assert.equal(body.error.message, "Invalid JSON body");
  assert.equal(body.error.type, "invalid_request");
});

// ── /api/settings/purge-usage-history ────────────────────────────────────────

const PURGE = "http://localhost/api/settings/purge-usage-history";

it("POST /api/settings/purge-usage-history refuses an anonymous caller with 401", async () => {
  const response = await purgeUsageRoute.POST(send(PURGE, "POST", { period: "1h" }));
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("POST /api/settings/purge-usage-history rejects an unknown period with 400", async () => {
  const response = await purgeUsageRoute.POST(
    send(PURGE, "POST", { period: "forever" }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["period"]
  );
});

it("POST /api/settings/purge-usage-history reports the per-table deletion counts", async () => {
  const response = await purgeUsageRoute.POST(send(PURGE, "POST", { period: "1h" }, manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, number>>(response);
  for (const field of [
    "deleted",
    "deletedUsageHistory",
    "deletedCallLogs",
    "deletedRoutingDecisions",
    "deletedTokenLedger",
    "errors",
  ]) {
    assert.equal(typeof body[field], "number", `${field} is reported`);
  }
  assert.equal(body.errors, 0, "a clean store purges without errors");
});
