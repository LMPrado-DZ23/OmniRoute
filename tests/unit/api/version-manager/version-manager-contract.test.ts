// Contract tests for the legacy /api/version-manager routes (CLIProxyAPI).
//
//   GET  /api/version-manager/status
//   GET  /api/version-manager/check-update
//   POST /api/version-manager/install
//   POST /api/version-manager/{start,restart,stop}
//
// All six are management-scoped. start/restart/stop share
// parseVersionManagerToolRequest, so they also share a body contract: a `tool`
// field that must name a supervisor tool (cliproxy / the cliproxyapi alias).
//
// SCOPE, stated honestly: the install/check-update/start/restart HAPPY paths
// are NOT driven. They shell out to `npm view` / `npm install` and spawn the
// CLIProxyAPI child process, which no in-process stub can intercept. What is
// covered is everything that returns BEFORE that: the auth ladder, JSON
// parsing, tool validation, and the 409 "not installed" short-circuit that
// start/restart return while no cliproxy row exists — which is also what keeps
// this file from ever spawning anything.
//
// NO NETWORK: globalThis.fetch is replaced after the route imports by a stub
// that throws on every URL, so an accidental outbound call fails loudly.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-version-manager-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "version-manager-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const versionManager = await import("../../../../src/lib/db/versionManager.ts");
const statusRoute = await import("../../../../src/app/api/version-manager/status/route.ts");
const checkUpdateRoute =
  await import("../../../../src/app/api/version-manager/check-update/route.ts");
const installRoute = await import("../../../../src/app/api/version-manager/install/route.ts");
const startRoute = await import("../../../../src/app/api/version-manager/start/route.ts");
const restartRoute = await import("../../../../src/app/api/version-manager/restart/route.ts");
const stopRoute = await import("../../../../src/app/api/version-manager/stop/route.ts");

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

const BASE = "http://localhost/api/version-manager";

const toolRoutes: Array<[string, (request: Request) => Promise<Response>]> = [
  ["start", startRoute.POST],
  ["restart", restartRoute.POST],
  ["stop", stopRoute.POST],
];

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "version-manager-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("vm-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("vm-readonly", "contract-test", ["read"])).key;
  // Guard: every start/restart test below relies on cliproxy NOT being installed,
  // which is what makes them return 409 instead of spawning the child process.
  assert.equal(await versionManager.getServiceRow("cliproxy"), null);
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── GET /api/version-manager/status ──────────────────────────────────────────

it("GET /api/version-manager/status answers 401 without a credential", async () => {
  assert.equal((await statusRoute.GET(req(`${BASE}/status`))).status, 401);
});

it("GET /api/version-manager/status answers 403 for a key without the manage scope", async () => {
  assert.equal((await statusRoute.GET(req(`${BASE}/status`, "GET", readOnlyKey))).status, 403);
});

it("GET /api/version-manager/status returns the tool rows as an array", async () => {
  const response = await statusRoute.GET(req(`${BASE}/status`, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<Array<{ tool: string; status: string }>>(response);
  assert.ok(Array.isArray(body), "the legacy shape is a bare array");
  for (const row of body) {
    assert.equal(typeof row.tool, "string");
    assert.equal(typeof row.status, "string");
  }
});

// ── GET /api/version-manager/check-update ────────────────────────────────────

it("GET /api/version-manager/check-update answers 401 without a credential", async () => {
  assert.equal((await checkUpdateRoute.GET(req(`${BASE}/check-update`))).status, 401);
});

it("GET /api/version-manager/check-update answers 403 for a key without manage", async () => {
  const response = await checkUpdateRoute.GET(req(`${BASE}/check-update`, "GET", readOnlyKey));
  assert.equal(response.status, 403);
});

it("GET /api/version-manager/check-update rejects an unknown tool with 400", async () => {
  const response = await checkUpdateRoute.GET(
    req(`${BASE}/check-update?tool=not-a-tool`, "GET", manageKey)
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unknown tool: not-a-tool");
  assert.deepEqual(unexpectedCalls, [], "an unknown tool never reaches the registry lookup");
});

// ── POST /api/version-manager/install ────────────────────────────────────────

it("POST /api/version-manager/install answers 401 without a credential", async () => {
  const response = await installRoute.POST(
    req(`${BASE}/install`, "POST", undefined, { tool: "cliproxy" })
  );
  assert.equal(response.status, 401);
});

it("POST /api/version-manager/install answers 403 for a key without the manage scope", async () => {
  const response = await installRoute.POST(
    req(`${BASE}/install`, "POST", readOnlyKey, { tool: "cliproxy" })
  );
  assert.equal(response.status, 403);
});

it("POST /api/version-manager/install rejects malformed JSON with 400", async () => {
  const response = await installRoute.POST(req(`${BASE}/install`, "POST", manageKey, "{ nope"));
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
});

it("POST /api/version-manager/install rejects a missing tool with a field-level 400", async () => {
  const response = await installRoute.POST(req(`${BASE}/install`, "POST", manageKey, {}));
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["tool"]
  );
  assert.deepEqual(unexpectedCalls, [], "a rejected body never reaches the installer");
});

// ── POST /api/version-manager/{start,restart,stop} ───────────────────────────

for (const [name, handler] of toolRoutes) {
  it(`POST /api/version-manager/${name} answers 401 without a credential`, async () => {
    const response = await handler(req(`${BASE}/${name}`, "POST", undefined, { tool: "cliproxy" }));
    assert.equal(response.status, 401);
  });

  it(`POST /api/version-manager/${name} answers 403 for a key without the manage scope`, async () => {
    const response = await handler(
      req(`${BASE}/${name}`, "POST", readOnlyKey, { tool: "cliproxy" })
    );
    assert.equal(response.status, 403);
  });

  it(`POST /api/version-manager/${name} rejects malformed JSON with 400`, async () => {
    const response = await handler(req(`${BASE}/${name}`, "POST", manageKey, "{ nope"));
    assert.equal(response.status, 400);
    assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
  });

  it(`POST /api/version-manager/${name} rejects a tool outside the supervisor set with 400`, async () => {
    const response = await handler(req(`${BASE}/${name}`, "POST", manageKey, { tool: "9router" }));
    assert.equal(response.status, 400);
    assert.equal((await readJson<{ error: string }>(response)).error, "Unknown tool: 9router");
  });

  it(`POST /api/version-manager/${name} rejects an empty tool with a field-level 400`, async () => {
    const response = await handler(req(`${BASE}/${name}`, "POST", manageKey, { tool: "  " }));
    assert.equal(response.status, 400);
    const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
    assert.deepEqual(
      body.error.details.map((detail) => detail.field),
      ["tool"]
    );
  });
}

it("POST /api/version-manager/start answers 409 while CLIProxyAPI is not installed", async () => {
  const response = await startRoute.POST(
    req(`${BASE}/start`, "POST", manageKey, { tool: "cliproxy" })
  );
  assert.equal(response.status, 409);
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "CLIProxyAPI is not installed."
  );
});

it("POST /api/version-manager/restart answers 409 while CLIProxyAPI is not installed", async () => {
  const response = await restartRoute.POST(
    req(`${BASE}/restart`, "POST", manageKey, { tool: "cliproxyapi" })
  );
  assert.equal(response.status, 409, "the cliproxyapi alias resolves to the same tool");
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "CLIProxyAPI is not installed."
  );
});

it("POST /api/version-manager/stop succeeds when no supervisor is registered", async () => {
  const response = await stopRoute.POST(
    req(`${BASE}/stop`, "POST", manageKey, { tool: "cliproxy" })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { success: true });
  assert.deepEqual(unexpectedCalls, [], "no outbound call was made by any of these routes");
});
