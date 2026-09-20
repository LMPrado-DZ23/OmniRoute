// Contract tests for the /v1 key-issuance quota and limit routes.
//
// Covers /api/v1/quotas/check, /api/v1/accounts/{id}/limits and
// /api/v1/providers/{provider}/limits — the client-facing surface that decides
// whether a registered key may be issued at all.
//
// Contract under test: 401 without a credential on every verb, the documented
// success envelopes, the 400 bodies (malformed JSON, non-positive limit), and
// that a configured limit is honoured by the quota check itself.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-limits-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "v1-limits-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const quotasCheckRoute = await import("../../../../src/app/api/v1/quotas/check/route.ts");
const accountLimitsRoute = await import("../../../../src/app/api/v1/accounts/[id]/limits/route.ts");
const providerLimitsRoute =
  await import("../../../../src/app/api/v1/providers/[provider]/limits/route.ts");

type LimitsRow = {
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
};
type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string }> };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function idParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function providerParams(provider: string): { params: Promise<{ provider: string }> } {
  return { params: Promise.resolve({ provider }) };
}

function authed(url: string, method = "GET"): Request {
  return new Request(url, { method, headers: { Authorization: `Bearer ${clientKey}` } });
}

function authedJson(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", Authorization: `Bearer ${clientKey}` },
    body: JSON.stringify(body),
  });
}

let clientKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "v1-limits-contract-test-password";
  clientKey = (await apiKeysDb.createApiKey("v1-limits-client", "contract-test", ["read"])).key;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/v1/quotas/check ─────────────────────────────────────────────────────

it("GET /api/v1/quotas/check answers 401 without a credential", async () => {
  const response = await quotasCheckRoute.GET(new Request("http://localhost/api/v1/quotas/check"));
  assert.equal(response.status, 401);
  assert.equal(
    (await readJson<{ error: { message: string } }>(response)).error.message,
    "Authentication required"
  );
});

it("GET /api/v1/quotas/check allows issuance when no limit is configured", async () => {
  const response = await quotasCheckRoute.GET(
    authed("http://localhost/api/v1/quotas/check?provider=unlimited-co&accountId=acct-1")
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    allowed: boolean;
    provider: string | null;
    accountId: string | null;
    checkedAt: string;
    errorCode?: string;
  }>(response);
  assert.equal(body.allowed, true);
  assert.equal(body.provider, "unlimited-co");
  assert.equal(body.accountId, "acct-1");
  assert.equal(body.errorCode, undefined, "an allowed check carries no error code");
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)), "checkedAt is an ISO timestamp");
});

it("GET /api/v1/quotas/check reports null provider/accountId when omitted", async () => {
  const response = await quotasCheckRoute.GET(authed("http://localhost/api/v1/quotas/check"));
  assert.equal(response.status, 200);
  const body = await readJson<{ provider: string | null; accountId: string | null }>(response);
  assert.equal(body.provider, null);
  assert.equal(body.accountId, null);
});

// ── /api/v1/providers/{provider}/limits ──────────────────────────────────────

it("GET /api/v1/providers/{provider}/limits answers 401 without a credential", async () => {
  const response = await providerLimitsRoute.GET(
    new Request("http://localhost/api/v1/providers/acme/limits"),
    providerParams("acme")
  );
  assert.equal(response.status, 401);
});

it("PUT /api/v1/providers/{provider}/limits answers 401 without a credential", async () => {
  const response = await providerLimitsRoute.PUT(
    new Request("http://localhost/api/v1/providers/acme/limits", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxActiveKeys: 1 }),
    }),
    providerParams("acme")
  );
  assert.equal(response.status, 401);
});

it("GET /api/v1/providers/{provider}/limits returns null limits when unset", async () => {
  const response = await providerLimitsRoute.GET(
    authed("http://localhost/api/v1/providers/never-configured/limits"),
    providerParams("never-configured")
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ provider: string; limits: null }>(response), {
    provider: "never-configured",
    limits: null,
  });
});

it("PUT /api/v1/providers/{provider}/limits stores the limits and GET reads them back", async () => {
  const written = await providerLimitsRoute.PUT(
    authedJson("http://localhost/api/v1/providers/acme/limits", "PUT", {
      maxActiveKeys: 2,
      dailyIssueLimit: 5,
    }),
    providerParams("acme")
  );
  assert.equal(written.status, 200);
  const body = await readJson<{ provider: string; limits: LimitsRow }>(written);
  assert.equal(body.provider, "acme");
  assert.equal(body.limits.maxActiveKeys, 2);
  assert.equal(body.limits.dailyIssueLimit, 5);

  const read = await providerLimitsRoute.GET(
    authed("http://localhost/api/v1/providers/acme/limits"),
    providerParams("acme")
  );
  const current = await readJson<{ limits: LimitsRow }>(read);
  assert.equal(current.limits.maxActiveKeys, 2);
  assert.equal(current.limits.dailyIssueLimit, 5);
});

it("PUT /api/v1/providers/{provider}/limits rejects a non-positive limit with 400", async () => {
  const response = await providerLimitsRoute.PUT(
    authedJson("http://localhost/api/v1/providers/acme/limits", "PUT", { maxActiveKeys: 0 }),
    providerParams("acme")
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["maxActiveKeys"]
  );
});

it("PUT /api/v1/providers/{provider}/limits rejects malformed JSON with 400", async () => {
  const response = await providerLimitsRoute.PUT(
    new Request("http://localhost/api/v1/providers/acme/limits", {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${clientKey}` },
      body: "{ not json",
    }),
    providerParams("acme")
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
});

// ── /api/v1/accounts/{id}/limits ─────────────────────────────────────────────

it("GET /api/v1/accounts/{id}/limits answers 401 without a credential", async () => {
  const response = await accountLimitsRoute.GET(
    new Request("http://localhost/api/v1/accounts/acct-1/limits"),
    idParams("acct-1")
  );
  assert.equal(response.status, 401);
});

it("GET /api/v1/accounts/{id}/limits returns null limits when unset", async () => {
  const response = await accountLimitsRoute.GET(
    authed("http://localhost/api/v1/accounts/never-configured/limits"),
    idParams("never-configured")
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ accountId: string; limits: null }>(response), {
    accountId: "never-configured",
    limits: null,
  });
});

it("PUT /api/v1/accounts/{id}/limits rejects a non-positive limit with 400", async () => {
  const response = await accountLimitsRoute.PUT(
    authedJson("http://localhost/api/v1/accounts/acct-1/limits", "PUT", { dailyIssueLimit: -1 }),
    idParams("acct-1")
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["dailyIssueLimit"]
  );
});

it("a maxActiveKeys of 1 set via PUT makes the quota check deny the second key", async () => {
  const account = "acct-capped";
  const provider = "capped-co";

  const written = await accountLimitsRoute.PUT(
    authedJson(`http://localhost/api/v1/accounts/${account}/limits`, "PUT", { maxActiveKeys: 1 }),
    idParams(account)
  );
  assert.equal(written.status, 200);
  assert.equal((await readJson<{ limits: LimitsRow }>(written)).limits.maxActiveKeys, 1);

  const before = await quotasCheckRoute.GET(
    authed(`http://localhost/api/v1/quotas/check?provider=${provider}&accountId=${account}`)
  );
  assert.equal((await readJson<{ allowed: boolean }>(before)).allowed, true);

  const registeredKeys = await import("../../../../src/lib/db/registeredKeys.ts");
  registeredKeys.issueRegisteredKey({ name: "capped-1", provider, accountId: account });

  const afterIssue = await quotasCheckRoute.GET(
    authed(`http://localhost/api/v1/quotas/check?provider=${provider}&accountId=${account}`)
  );
  assert.equal(afterIssue.status, 200);
  const denied = await readJson<{ allowed: boolean; errorCode?: string; reason?: string }>(
    afterIssue
  );
  assert.equal(denied.allowed, false, "the configured cap is enforced by the check endpoint");
  assert.equal(typeof denied.errorCode, "string");
  assert.ok((denied.reason ?? "").length > 0, "the denial explains why");
});
