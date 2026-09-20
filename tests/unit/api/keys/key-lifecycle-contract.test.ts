// Contract tests for the per-API-key management sub-resources.
//
// Covers /api/keys/{id}/devices, /api/keys/{id}/regenerate and
// /api/keys/{id}/usage-limits — every one of them guarded by
// `requireManagementAuth`, so the contract under test is the full
// authorization ladder (401 anonymous / 403 under-scoped / 200 manage) plus
// the 404 and the response envelope.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-lifecycle-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "key-lifecycle-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const devicesRoute = await import("../../../../src/app/api/keys/[id]/devices/route.ts");
const regenerateRoute = await import("../../../../src/app/api/keys/[id]/regenerate/route.ts");
const usageLimitsRoute = await import("../../../../src/app/api/keys/[id]/usage-limits/route.ts");

type ErrorEnvelope = { error: { message: string; type?: string } };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function request(url: string, method: string, apiKey?: string): Request {
  return new Request(url, {
    method,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
}

let manageKey = "";
let readOnlyKey = "";
let subjectKeyId = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "key-lifecycle-contract-test-password";

  manageKey = (await apiKeysDb.createApiKey("lifecycle-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("lifecycle-readonly", "contract-test", ["read"])).key;
  subjectKeyId = (await apiKeysDb.createApiKey("lifecycle-subject", "contract-test", [])).id;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/keys/{id}/devices ───────────────────────────────────────────────────

it("GET /api/keys/{id}/devices answers 401 without a credential", async () => {
  const response = await devicesRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/devices`, "GET"),
    params(subjectKeyId)
  );
  assert.equal(response.status, 401);
  const body = await readJson<ErrorEnvelope>(response);
  assert.equal(body.error.message, "Authentication required");
});

it("GET /api/keys/{id}/devices answers 403 for a key without the manage scope", async () => {
  const response = await devicesRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/devices`, "GET", readOnlyKey),
    params(subjectKeyId)
  );
  assert.equal(response.status, 403);
  const body = await readJson<ErrorEnvelope>(response);
  assert.match(body.error.message, /manage/);
});

it("GET /api/keys/{id}/devices returns the device envelope for a manage key", async () => {
  const response = await devicesRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/devices`, "GET", manageKey),
    params(subjectKeyId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    keyId: string;
    name: string;
    count: number;
    devices: unknown[];
  }>(response);
  assert.equal(body.keyId, subjectKeyId);
  assert.equal(body.name, "lifecycle-subject");
  assert.equal(typeof body.count, "number");
  assert.ok(Array.isArray(body.devices));
});

it("GET /api/keys/{id}/devices answers 404 for an unknown key id", async () => {
  const response = await devicesRoute.GET(
    request("http://localhost/api/keys/no-such-key/devices", "GET", manageKey),
    params("no-such-key")
  );
  assert.equal(response.status, 404);
  const body = await readJson<ErrorEnvelope>(response);
  assert.equal(body.error.message, "Key not found");
});

// ── /api/keys/{id}/usage-limits ──────────────────────────────────────────────

it("GET /api/keys/{id}/usage-limits answers 401 without a credential", async () => {
  const response = await usageLimitsRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/usage-limits`, "GET"),
    params(subjectKeyId)
  );
  assert.equal(response.status, 401);
});

it("GET /api/keys/{id}/usage-limits answers 403 for a key without the manage scope", async () => {
  const response = await usageLimitsRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/usage-limits`, "GET", readOnlyKey),
    params(subjectKeyId)
  );
  assert.equal(response.status, 403);
});

it("GET /api/keys/{id}/usage-limits returns the { key, status } envelope", async () => {
  const response = await usageLimitsRoute.GET(
    request(`http://localhost/api/keys/${subjectKeyId}/usage-limits`, "GET", manageKey),
    params(subjectKeyId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    key: {
      id: string;
      name: string;
      usageLimitEnabled: boolean;
      dailyUsageLimitUsd: number | null;
      weeklyUsageLimitUsd: number | null;
    };
    status: unknown;
  }>(response);
  assert.equal(body.key.id, subjectKeyId);
  assert.equal(body.key.name, "lifecycle-subject");
  assert.equal(body.key.usageLimitEnabled, false);
  assert.equal(body.key.dailyUsageLimitUsd, null);
  assert.equal(body.key.weeklyUsageLimitUsd, null);
  assert.ok(body.status && typeof body.status === "object");
});

it("GET /api/keys/{id}/usage-limits answers 404 for an unknown key id", async () => {
  const response = await usageLimitsRoute.GET(
    request("http://localhost/api/keys/no-such-key/usage-limits", "GET", manageKey),
    params("no-such-key")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Key not found");
});

// ── /api/keys/{id}/regenerate ────────────────────────────────────────────────

it("POST /api/keys/{id}/regenerate answers 401 without a credential", async () => {
  const response = await regenerateRoute.POST(
    request(`http://localhost/api/keys/${subjectKeyId}/regenerate`, "POST"),
    params(subjectKeyId)
  );
  assert.equal(response.status, 401);
});

it("POST /api/keys/{id}/regenerate answers 403 for a key without the manage scope", async () => {
  const response = await regenerateRoute.POST(
    request(`http://localhost/api/keys/${subjectKeyId}/regenerate`, "POST", readOnlyKey),
    params(subjectKeyId)
  );
  assert.equal(response.status, 403);
});

it("POST /api/keys/{id}/regenerate answers 404 for an unknown key id", async () => {
  const response = await regenerateRoute.POST(
    request("http://localhost/api/keys/no-such-key/regenerate", "POST", manageKey),
    params("no-such-key")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Key not found");
});

it("POST /api/keys/{id}/regenerate issues a new key and invalidates the old one", async () => {
  const victim = await apiKeysDb.createApiKey("lifecycle-rotate", "contract-test", ["read"]);
  assert.equal(await apiKeysDb.validateApiKey(victim.key), true);

  const response = await regenerateRoute.POST(
    request(`http://localhost/api/keys/${victim.id}/regenerate`, "POST", manageKey),
    params(victim.id)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ message: string; key: string; id: string }>(response);
  assert.equal(body.id, victim.id);
  assert.equal(body.message, "API key regenerated successfully");
  assert.notEqual(body.key, victim.key, "a fresh secret is returned");

  assert.equal(await apiKeysDb.validateApiKey(body.key), true, "the new key authenticates");
  assert.equal(
    await apiKeysDb.validateApiKey(victim.key),
    false,
    "the superseded key no longer authenticates"
  );
});
