// Contract tests for the embedded-service lifecycle routes under /api/services.
//
// These routes live under a prefix the central authz middleware classifies
// LOCAL_ONLY (routeGuard.ts, T-10: they spawn child processes), so there is no
// per-handler auth on most of them. What a handler-level contract CAN pin, and
// what is covered here without ever spawning or installing anything:
//
//   POST {9router,bifrost,cliproxy,dario,mux}/auto-restart-adopted
//   POST dario/auto-start                   — 400 bodies, 204, DB read-back
//   POST {9router,bifrost,cliproxy,dario}/restart
//                                            — 409 when the service is not
//                                              installed (returns before any
//                                              supervisor is created)
//   POST dario/stop                          — no supervisor -> "stopped"
//   POST dario/install                       — version validation 400s only
//                                              (the path-traversal guard);
//                                              the installer is never reached
//   dario/admin/{accounts,login-start,login-complete}
//                                            — 401 when login is required,
//                                              400 validation, 409 with no
//                                              admin token, and the forwarding
//                                              contract: the stored admin token
//                                              goes upstream as a Bearer header
//                                              and NEVER back to the caller.
//
// NO NETWORK: globalThis.fetch is replaced AFTER the route imports (importing
// them loads proxyFetch, which re-patches fetch — see the note in
// tests/unit/api/providers/auth-import-contract.test.ts) by a stub that answers
// only the loopback Dario admin URL and throws on anything else.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-services-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "services-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
delete process.env.DARIO_HOST;
delete process.env.DARIO_PORT;

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const versionManager = await import("../../../../src/lib/db/versionManager.ts");
const serviceApiKey = await import("../../../../src/lib/services/apiKey.ts");

type Handler = (request: Request) => Promise<Response>;
type NoArgHandler = () => Promise<Response>;

// Explicit import paths (not template literals): the API-governance gate finds a
// route's test by its literal `app/api/.../route` import path.
const adoptedRoutes: Array<[string, Handler]> = [
  [
    "9router",
    (await import("../../../../src/app/api/services/9router/auto-restart-adopted/route.ts")).POST,
  ],
  [
    "bifrost",
    (await import("../../../../src/app/api/services/bifrost/auto-restart-adopted/route.ts")).POST,
  ],
  [
    "cliproxy",
    (await import("../../../../src/app/api/services/cliproxy/auto-restart-adopted/route.ts")).POST,
  ],
  [
    "dario",
    (await import("../../../../src/app/api/services/dario/auto-restart-adopted/route.ts")).POST,
  ],
  [
    "mux",
    (await import("../../../../src/app/api/services/mux/auto-restart-adopted/route.ts")).POST,
  ],
];
const restartRoutes: Array<[string, NoArgHandler, string]> = [
  [
    "9router",
    (await import("../../../../src/app/api/services/9router/restart/route.ts")).POST,
    "9router",
  ],
  [
    "bifrost",
    (await import("../../../../src/app/api/services/bifrost/restart/route.ts")).POST,
    "Bifrost",
  ],
  [
    "cliproxy",
    (await import("../../../../src/app/api/services/cliproxy/restart/route.ts")).POST,
    "CLIProxyAPI",
  ],
  [
    "dario",
    (await import("../../../../src/app/api/services/dario/restart/route.ts")).POST,
    "Dario",
  ],
];
const darioAutoStart = await import("../../../../src/app/api/services/dario/auto-start/route.ts");
const darioStop = await import("../../../../src/app/api/services/dario/stop/route.ts");
const darioInstall = await import("../../../../src/app/api/services/dario/install/route.ts");
const darioAccounts =
  await import("../../../../src/app/api/services/dario/admin/accounts/route.ts");
const darioLoginStart =
  await import("../../../../src/app/api/services/dario/admin/login-start/route.ts");
const darioLoginComplete =
  await import("../../../../src/app/api/services/dario/admin/login-complete/route.ts");
const darioLib = await import("../../../../src/app/api/services/dario/admin/_lib.ts");

// Installed only now — after proxyFetch has patched the global.
const DARIO_ADMIN_BASE = darioLib.darioBaseUrl();
const upstreamCalls: Array<{ url: string; method: string; authorization: string | null }> = [];
const unexpectedCalls: string[] = [];
const realFetch = globalThis.fetch;

async function stubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${DARIO_ADMIN_BASE}/admin/`)) {
    const headers = new Headers(init?.headers);
    upstreamCalls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return Response.json({ accounts: [{ alias: "primary" }], count: 1 });
  }
  unexpectedCalls.push(url);
  throw new Error(`contract test blocked an unexpected outbound request: ${url}`);
}
globalThis.fetch = stubFetch;

type ErrorEnvelope = { error: { message: string } };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function post(url: string, body?: unknown, extra: Record<string, string> = {}): Request {
  if (body === undefined) return new Request(url, { method: "POST", headers: extra });
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let manageKey = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  manageKey = (await apiKeysDb.createApiKey("services-manage", "contract-test", ["manage"])).key;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── restart: not installed ───────────────────────────────────────────────────
// Declared FIRST on purpose: node:test runs `it` blocks in order, and these must
// run while no cliproxy/dario row exists. Once a row with status "stopped" is
// seeded (the admin-forwarding tests below do that), restart would try to spawn.

for (const [tool, handler, label] of restartRoutes) {
  it(`POST /api/services/${tool}/restart answers 409 when the service is not installed`, async () => {
    const response = await handler();
    assert.equal(response.status, 409);
    const body = await readJson<ErrorEnvelope & { requestId: string }>(response);
    assert.equal(body.error.message, `${label} não está instalado.`);
    assert.equal(typeof body.requestId, "string");
  });
}

// ── auto-restart-adopted (all five services) ─────────────────────────────────

// 9router, bifrost and mux get a version_manager row from their seed migrations;
// cliproxy and dario only get one when they are installed.
const SEEDED_BY_MIGRATION = new Set(["9router", "bifrost", "mux"]);

for (const [tool, handler] of adoptedRoutes) {
  const url = `http://localhost/api/services/${tool}/auto-restart-adopted`;

  if (SEEDED_BY_MIGRATION.has(tool)) {
    it(`POST /api/services/${tool}/auto-restart-adopted persists the flag and answers 204`, async () => {
      const response = await handler(post(url, { enabled: true }));
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "", "204 carries no body");
      assert.equal((await versionManager.getServiceRow(tool))?.autoRestartAdopted, true);

      const off = await handler(post(url, { enabled: false }));
      assert.equal(off.status, 204);
      assert.equal((await versionManager.getServiceRow(tool))?.autoRestartAdopted, false);
    });
  } else {
    it(`POST /api/services/${tool}/auto-restart-adopted answers 204 but stores nothing before install`, async () => {
      // KNOWN DEFECT, pinned not endorsed: with no version_manager row yet,
      // updateVersionManagerTool is a silent no-op, yet the route still answers
      // 204 — the toggle is discarded. Reported in the PR.
      assert.equal(await versionManager.getServiceRow(tool), null);
      const response = await handler(post(url, { enabled: true }));
      assert.equal(response.status, 204);
      assert.equal(await versionManager.getServiceRow(tool), null, "nothing was persisted");
    });
  }

  it(`POST /api/services/${tool}/auto-restart-adopted rejects a non-boolean with 400`, async () => {
    const response = await handler(post(url, { enabled: "yes" }));
    assert.equal(response.status, 400);
    const body = await readJson<ErrorEnvelope>(response);
    assert.match(body.error.message, /enabled/);
  });

  it(`POST /api/services/${tool}/auto-restart-adopted rejects malformed JSON with 400`, async () => {
    const response = await handler(post(url, "{ nope"));
    assert.equal(response.status, 400);
    assert.equal((await readJson<ErrorEnvelope>(response)).error.message, "Invalid JSON body");
  });
}

// ── dario/auto-start ─────────────────────────────────────────────────────────

it("POST /api/services/dario/auto-start answers 204 but stores nothing before install", async () => {
  // Same pinned defect as auto-restart-adopted: no row yet, silent no-op.
  const response = await darioAutoStart.POST(
    post("http://localhost/api/services/dario/auto-start", { enabled: true })
  );
  assert.equal(response.status, 204);
  assert.equal(await versionManager.getServiceRow("dario"), null);
});

it("POST /api/services/dario/auto-start rejects a missing flag with 400", async () => {
  const response = await darioAutoStart.POST(
    post("http://localhost/api/services/dario/auto-start", {})
  );
  assert.equal(response.status, 400);
});

// ── dario/stop, dario/install ────────────────────────────────────────────────

it("POST /api/services/dario/stop reports stopped when no supervisor is running", async () => {
  const response = await darioStop.POST();
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { tool: "dario", state: "stopped" });
});

it("POST /api/services/dario/install rejects a path-traversal version with 400", async () => {
  const response = await darioInstall.POST(
    post("http://localhost/api/services/dario/install", { version: "../../malicious" })
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<ErrorEnvelope>(response)).error.message, /Invalid version/);
});

it("POST /api/services/dario/install rejects malformed JSON with 400", async () => {
  const response = await darioInstall.POST(
    post("http://localhost/api/services/dario/install", "{ nope")
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<ErrorEnvelope>(response)).error.message, "Invalid JSON body");
});

// ── dario/admin/* ────────────────────────────────────────────────────────────

const ACCOUNTS_URL = "http://localhost/api/services/dario/admin/accounts";

it("dario/admin routes answer 401 when login is required and the caller is anonymous", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "services-contract-test-password";
  try {
    const responses = await Promise.all([
      darioAccounts.GET(new Request(ACCOUNTS_URL)),
      darioAccounts.DELETE(new Request(`${ACCOUNTS_URL}?alias=x`, { method: "DELETE" })),
      darioLoginStart.POST(post("http://localhost/api/services/dario/admin/login-start", {})),
      darioLoginComplete.POST(
        post("http://localhost/api/services/dario/admin/login-complete", { code: "c" })
      ),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [401, 401, 401, 401]
    );
    assert.deepEqual(upstreamCalls, [], "nothing was forwarded for an anonymous caller");
  } finally {
    delete process.env.INITIAL_PASSWORD;
    await settingsDb.updateSettings({ requireLogin: false });
  }
});

it("GET dario/admin/accounts answers 409 while Dario has no admin token", async () => {
  const response = await darioAccounts.GET(
    new Request(ACCOUNTS_URL, { headers: { Authorization: `Bearer ${manageKey}` } })
  );
  assert.equal(response.status, 409);
  assert.match((await readJson<{ error: string }>(response)).error, /admin token unavailable/);
  assert.deepEqual(upstreamCalls, []);
});

it("DELETE dario/admin/accounts requires an alias", async () => {
  const response = await darioAccounts.DELETE(new Request(ACCOUNTS_URL, { method: "DELETE" }));
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<ErrorEnvelope>(response)).error.message,
    "alias required (?alias= or JSON body)"
  );
});

it("POST dario/admin/login-complete rejects a missing code with 400", async () => {
  const response = await darioLoginComplete.POST(
    post("http://localhost/api/services/dario/admin/login-complete", { alias: "a" })
  );
  assert.equal(response.status, 400);
  assert.match((await readJson<ErrorEnvelope>(response)).error.message, /code/);
});

// ── once Dario is installed ──────────────────────────────────────────────────
// Seeds the version_manager row exactly as the dario installer does. Every
// restart test has already run (see the ordering note above).

it("POST /api/services/dario/auto-start persists autoStart once the row exists", async () => {
  await versionManager.upsertVersionManagerTool({ tool: "dario", status: "stopped", port: 3456 });
  const response = await darioAutoStart.POST(
    post("http://localhost/api/services/dario/auto-start", { enabled: true })
  );
  assert.equal(response.status, 204);
  assert.equal((await versionManager.getServiceRow("dario"))?.autoStart, true);
});

it("GET dario/admin/accounts forwards with the stored token and never returns it", async () => {
  const adminToken = await serviceApiKey.getOrCreateApiKey("dario");
  const response = await darioAccounts.GET(new Request(ACCOUNTS_URL));
  assert.equal(response.status, 200);
  const body = await readJson<{ accounts: Array<{ alias: string }>; count: number }>(response);
  assert.deepEqual(body, { accounts: [{ alias: "primary" }], count: 1 });

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, `${DARIO_ADMIN_BASE}/admin/accounts`);
  assert.equal(upstreamCalls[0].method, "GET");
  assert.equal(upstreamCalls[0].authorization, `Bearer ${adminToken}`);
  assert.ok(!JSON.stringify(body).includes(adminToken), "the admin token never reaches the caller");
  assert.deepEqual(unexpectedCalls, []);
});

it("DELETE dario/admin/accounts forwards the URL-encoded alias", async () => {
  const before = upstreamCalls.length;
  const response = await darioAccounts.DELETE(
    new Request(`${ACCOUNTS_URL}?alias=${encodeURIComponent("team/a b")}`, { method: "DELETE" })
  );
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, before + 1);
  assert.equal(
    upstreamCalls[before].url,
    `${DARIO_ADMIN_BASE}/admin/accounts/${encodeURIComponent("team/a b")}`,
    "a slash in the alias cannot escape the /admin/accounts/ path"
  );
  assert.equal(upstreamCalls[before].method, "DELETE");
});
