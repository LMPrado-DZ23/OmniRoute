// Contract tests for the /api/v1/registered-keys credential routes.
//
// Covers /api/v1/registered-keys, /api/v1/registered-keys/{id} and
// /api/v1/registered-keys/{id}/revoke. These are `/v1/**` client-facing routes
// guarded by `isAuthenticated`, so the contract is: 401 without a credential,
// the documented success envelopes, the 400 validation body, and that the raw
// key material is returned once on issue and never again on read.
//
// The handlers are driven directly against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-registered-keys-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "registered-keys-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const collectionRoute = await import("../../../../src/app/api/v1/registered-keys/route.ts");
const itemRoute = await import("../../../../src/app/api/v1/registered-keys/[id]/route.ts");
const revokeRoute = await import("../../../../src/app/api/v1/registered-keys/[id]/revoke/route.ts");

type IssuedKey = {
  key: string;
  keyId: string;
  keyPrefix: string;
  name: string;
  provider: string;
  accountId: string;
  createdAt: string;
  warning: string;
};
type RegisteredKeyShape = {
  id: string;
  keyPrefix: string;
  name: string;
  provider: string;
  isActive: boolean;
  revokedAt: string | null;
};
type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string }> };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function authedJson(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", Authorization: `Bearer ${clientKey}` },
    body: JSON.stringify(body),
  });
}

function authed(url: string, method: string): Request {
  return new Request(url, { method, headers: { Authorization: `Bearer ${clientKey}` } });
}

let clientKey = "";
let issued: IssuedKey;

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "registered-keys-contract-test-password";
  clientKey = (await apiKeysDb.createApiKey("registered-keys-client", "contract-test", ["read"]))
    .key;

  const response = await collectionRoute.POST(
    authedJson("http://localhost/api/v1/registered-keys", "POST", {
      name: "contract-fixture",
      provider: "openai",
      accountId: "acct-contract",
    })
  );
  assert.equal(response.status, 201);
  issued = await readJson<IssuedKey>(response);
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/v1/registered-keys ──────────────────────────────────────────────────

it("GET /api/v1/registered-keys answers 401 without a credential", async () => {
  const response = await collectionRoute.GET(
    new Request("http://localhost/api/v1/registered-keys")
  );
  assert.equal(response.status, 401);
  const body = await readJson<{ error: { message: string } }>(response);
  assert.equal(body.error.message, "Authentication required");
});

it("POST /api/v1/registered-keys answers 401 without a credential", async () => {
  const response = await collectionRoute.POST(
    new Request("http://localhost/api/v1/registered-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "unauthenticated" }),
    })
  );
  assert.equal(response.status, 401);
});

it("POST /api/v1/registered-keys issues a key and shows the secret once", async () => {
  assert.equal(issued.name, "contract-fixture");
  assert.equal(issued.provider, "openai");
  assert.equal(issued.accountId, "acct-contract");
  assert.equal(typeof issued.key, "string");
  assert.ok(issued.key.length > 0);
  assert.ok(issued.key.startsWith(issued.keyPrefix));
  assert.match(issued.warning, /not be shown again/);
});

it("GET /api/v1/registered-keys returns { keys, total } and never the raw key", async () => {
  const response = await collectionRoute.GET(
    authed("http://localhost/api/v1/registered-keys", "GET")
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ keys: RegisteredKeyShape[]; total: number }>(response);
  assert.ok(Array.isArray(body.keys));
  assert.equal(body.total, body.keys.length);

  const fixture = body.keys.find((key) => key.id === issued.keyId);
  assert.ok(fixture, "the issued key is listed");
  assert.equal(fixture.name, "contract-fixture");
  assert.equal(fixture.keyPrefix, issued.keyPrefix);
  assert.equal(fixture.isActive, true);
  assert.ok(
    !JSON.stringify(body).includes(issued.key),
    "the listing never re-exposes the raw key material"
  );
});

it("GET /api/v1/registered-keys filters by provider", async () => {
  const response = await collectionRoute.GET(
    authed("http://localhost/api/v1/registered-keys?provider=not-a-provider", "GET")
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ keys: RegisteredKeyShape[]; total: number }>(response);
  assert.deepEqual(body.keys, []);
  assert.equal(body.total, 0);
});

it("POST /api/v1/registered-keys rejects a blank name with 400", async () => {
  const response = await collectionRoute.POST(
    authedJson("http://localhost/api/v1/registered-keys", "POST", { name: "" })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["name"]
  );
});

it("POST /api/v1/registered-keys rejects a malformed JSON body with 400", async () => {
  const response = await collectionRoute.POST(
    new Request("http://localhost/api/v1/registered-keys", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${clientKey}` },
      body: "{ not json",
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
});

// ── /api/v1/registered-keys/{id} ─────────────────────────────────────────────

it("GET /api/v1/registered-keys/{id} answers 401 without a credential", async () => {
  const response = await itemRoute.GET(
    new Request(`http://localhost/api/v1/registered-keys/${issued.keyId}`),
    params(issued.keyId)
  );
  assert.equal(response.status, 401);
});

it("GET /api/v1/registered-keys/{id} returns the masked key record", async () => {
  const response = await itemRoute.GET(
    authed(`http://localhost/api/v1/registered-keys/${issued.keyId}`, "GET"),
    params(issued.keyId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ key: RegisteredKeyShape }>(response);
  assert.equal(body.key.id, issued.keyId);
  assert.equal(body.key.keyPrefix, issued.keyPrefix);
  assert.equal(body.key.isActive, true);
  assert.equal(body.key.revokedAt, null);
  assert.ok(!JSON.stringify(body).includes(issued.key), "the record never carries the secret");
});

it("GET /api/v1/registered-keys/{id} answers 404 for an unknown id", async () => {
  const response = await itemRoute.GET(
    authed("http://localhost/api/v1/registered-keys/no-such-key", "GET"),
    params("no-such-key")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Key not found");
});

it("DELETE /api/v1/registered-keys/{id} revokes the key and is not repeatable", async () => {
  const victim = await readJson<IssuedKey>(
    await collectionRoute.POST(
      authedJson("http://localhost/api/v1/registered-keys", "POST", { name: "to-be-deleted" })
    )
  );

  const response = await itemRoute.DELETE(
    authed(`http://localhost/api/v1/registered-keys/${victim.keyId}`, "DELETE"),
    params(victim.keyId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ success: boolean; id: string; revokedAt: string }>(response);
  assert.equal(body.success, true);
  assert.equal(body.id, victim.keyId);
  assert.equal(typeof body.revokedAt, "string");

  const again = await itemRoute.DELETE(
    authed(`http://localhost/api/v1/registered-keys/${victim.keyId}`, "DELETE"),
    params(victim.keyId)
  );
  assert.equal(again.status, 404);
  assert.equal(
    (await readJson<{ error: string }>(again)).error,
    "Key not found or already revoked"
  );
});

// ── /api/v1/registered-keys/{id}/revoke ──────────────────────────────────────

it("POST /api/v1/registered-keys/{id}/revoke answers 401 without a credential", async () => {
  const response = await revokeRoute.POST(
    new Request(`http://localhost/api/v1/registered-keys/${issued.keyId}/revoke`, {
      method: "POST",
    }),
    params(issued.keyId)
  );
  assert.equal(response.status, 401);
});

it("POST /api/v1/registered-keys/{id}/revoke deactivates the key", async () => {
  const victim = await readJson<IssuedKey>(
    await collectionRoute.POST(
      authedJson("http://localhost/api/v1/registered-keys", "POST", { name: "to-be-revoked" })
    )
  );

  const response = await revokeRoute.POST(
    authed(`http://localhost/api/v1/registered-keys/${victim.keyId}/revoke`, "POST"),
    params(victim.keyId)
  );
  assert.equal(response.status, 200);
  assert.equal((await readJson<{ success: boolean }>(response)).success, true);

  const read = await itemRoute.GET(
    authed(`http://localhost/api/v1/registered-keys/${victim.keyId}`, "GET"),
    params(victim.keyId)
  );
  const body = await readJson<{ key: RegisteredKeyShape }>(read);
  assert.equal(body.key.isActive, false);
  assert.equal(typeof body.key.revokedAt, "string");
});

it("POST /api/v1/registered-keys/{id}/revoke answers 404 for an unknown id", async () => {
  const response = await revokeRoute.POST(
    authed("http://localhost/api/v1/registered-keys/no-such-key/revoke", "POST"),
    params("no-such-key")
  );
  assert.equal(response.status, 404);
});
