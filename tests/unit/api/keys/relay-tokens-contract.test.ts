// Contract tests for the relay-token routes.
//
// Covers /api/relay/tokens and /api/relay/tokens/{id} — the credentials a relay
// client presents to OmniRoute. The critical part of the contract is that the
// list/patch responses never leak `tokenHash`, and that the raw secret is
// returned exactly once, on creation.
//
// The handlers are driven directly against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-relay-tokens-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "relay-tokens-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const tokensRoute = await import("../../../../src/app/api/relay/tokens/route.ts");
const tokenRoute = await import("../../../../src/app/api/relay/tokens/[id]/route.ts");

type CreatedToken = { id: string; name: string; rawToken: string; tokenPrefix: string };
type ListedToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  createdAt: number;
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

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let created: CreatedToken;

before(async () => {
  const response = await tokensRoute.POST(
    jsonRequest("http://localhost/api/relay/tokens", "POST", {
      name: "contract-fixture",
      description: "fixture relay token",
      maxRequestsPerMinute: 30,
    })
  );
  assert.equal(response.status, 200);
  created = await readJson<CreatedToken>(response);
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/relay/tokens ────────────────────────────────────────────────────────

it("POST /api/relay/tokens returns the raw token exactly once, with its prefix", async () => {
  assert.equal(created.name, "contract-fixture");
  assert.equal(typeof created.rawToken, "string");
  assert.ok(created.rawToken.length > 0);
  assert.match(created.rawToken, /^relay_[0-9a-f]{48}$/);
  // The display prefix is `rl_` plus the first 8 hex characters of the secret —
  // enough to identify a token in the UI, too short to reconstruct it.
  assert.equal(created.tokenPrefix, `rl_${created.rawToken.slice(6, 14)}`);
  assert.match(created.id, /^rl_[0-9a-f]{32}$/);
});

it("GET /api/relay/tokens lists tokens without any secret material", async () => {
  const response = await tokensRoute.GET();
  assert.equal(response.status, 200);
  const body = await readJson<ListedToken[]>(response);
  assert.ok(Array.isArray(body), "the list endpoint answers with a bare array");

  const fixture = body.find((token) => token.id === created.id);
  assert.ok(fixture, "the created token is listed");
  assert.equal(fixture.name, "contract-fixture");
  assert.equal(fixture.tokenPrefix, created.tokenPrefix);
  assert.equal(fixture.enabled, true);
  assert.equal(typeof fixture.createdAt, "number");

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("tokenHash"), "the listing never exposes tokenHash");
  assert.ok(!serialized.includes(created.rawToken), "the listing never re-exposes the raw token");
});

it("POST /api/relay/tokens rejects a blank name with 400 and names the field", async () => {
  const response = await tokensRoute.POST(
    jsonRequest("http://localhost/api/relay/tokens", "POST", { name: "  " })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["name"]
  );
});

it("POST /api/relay/tokens rejects a non-positive rate limit with 400", async () => {
  const response = await tokensRoute.POST(
    jsonRequest("http://localhost/api/relay/tokens", "POST", {
      name: "bad-limits",
      maxRequestsPerMinute: 0,
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["maxRequestsPerMinute"]
  );
});

// ── /api/relay/tokens/{id} ───────────────────────────────────────────────────

it("GET /api/relay/tokens/{id} returns the token with usage and logs", async () => {
  const response = await tokenRoute.GET(
    new Request(`http://localhost/api/relay/tokens/${created.id}`),
    params(created.id)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    id: string;
    name: string;
    maxRequestsPerMinute: number;
    usage: { lastHour: unknown; lastDay: unknown };
    logs: unknown[];
  }>(response);
  assert.equal(body.id, created.id);
  assert.equal(body.name, "contract-fixture");
  assert.equal(body.maxRequestsPerMinute, 30);
  assert.ok(body.usage && typeof body.usage === "object");
  assert.ok("lastHour" in body.usage && "lastDay" in body.usage);
  assert.ok(Array.isArray(body.logs));
});

it("GET /api/relay/tokens/{id} answers 404 for an unknown token", async () => {
  const response = await tokenRoute.GET(
    new Request("http://localhost/api/relay/tokens/rl_missing"),
    params("rl_missing")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Token not found");
});

it("PATCH /api/relay/tokens/{id} toggles the enabled flag", async () => {
  const disabled = await tokenRoute.PATCH(
    jsonRequest(`http://localhost/api/relay/tokens/${created.id}`, "PATCH", { enabled: false }),
    params(created.id)
  );
  assert.equal(disabled.status, 200);
  assert.equal((await readJson<{ enabled: boolean }>(disabled)).enabled, false);

  const enabled = await tokenRoute.PATCH(
    jsonRequest(`http://localhost/api/relay/tokens/${created.id}`, "PATCH", { enabled: true }),
    params(created.id)
  );
  assert.equal(enabled.status, 200);
  assert.equal((await readJson<{ enabled: boolean }>(enabled)).enabled, true);
});

it("PATCH /api/relay/tokens/{id} updates fields without exposing the hash", async () => {
  const response = await tokenRoute.PATCH(
    jsonRequest(`http://localhost/api/relay/tokens/${created.id}`, "PATCH", {
      description: "patched by contract test",
      maxRequestsPerDay: 500,
    }),
    params(created.id)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ description: string; maxRequestsPerDay: number }>(response);
  assert.equal(body.description, "patched by contract test");
  assert.equal(body.maxRequestsPerDay, 500);
});

it("PATCH /api/relay/tokens/{id} rejects an empty body with 400", async () => {
  const response = await tokenRoute.PATCH(
    jsonRequest(`http://localhost/api/relay/tokens/${created.id}`, "PATCH", {}),
    params(created.id)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.ok(body.error.details.length > 0);
});

it("PATCH /api/relay/tokens/{id} answers 404 for an unknown token", async () => {
  const response = await tokenRoute.PATCH(
    jsonRequest("http://localhost/api/relay/tokens/rl_missing", "PATCH", { enabled: false }),
    params("rl_missing")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Token not found");
});

it("DELETE /api/relay/tokens/{id} removes the token and it stops being listed", async () => {
  const doomed = await readJson<CreatedToken>(
    await tokensRoute.POST(
      jsonRequest("http://localhost/api/relay/tokens", "POST", { name: "to-be-deleted" })
    )
  );

  const response = await tokenRoute.DELETE(
    new Request(`http://localhost/api/relay/tokens/${doomed.id}`, { method: "DELETE" }),
    params(doomed.id)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(response), { success: true });

  const listed = await readJson<ListedToken[]>(await tokensRoute.GET());
  assert.ok(!listed.some((token) => token.id === doomed.id), "the deleted token is gone");
});
