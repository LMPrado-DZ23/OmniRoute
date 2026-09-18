/**
 * Phase 8 — admin controls that previously left no audit trail, and the internal budget alert.
 *
 *   budget.set, accessToken.create, accessToken.revoke, apiKey.permissions.update, apiKey.delete
 *   are recorded with the pipeline-stamped principal (`x-omniroute-auth-*`) and its management
 *   role, never with key material; failed/404 mutations record nothing.
 *   budget.threshold_reached is delivered once per budget period when projected spend crosses
 *   the warning threshold (delivery here is blocked by the outbound guard — no network).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-admin-audit-phase8-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "admin-audit-phase8-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "admin-audit-phase8-jwt-secret";
process.env.INITIAL_PASSWORD = "admin-audit-phase8-password";
process.env.APP_LOG_TO_FILE = "false";
delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../src/lib/db/accessTokens.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const webhooksDb = await import("../../src/lib/db/webhooks.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const costRules = await import("../../src/domain/costRules.ts");
const budgetRoute = await import("../../src/app/api/usage/budget/route.ts");
const tokensRoute = await import("../../src/app/api/cli/tokens/route.ts");
const tokenByIdRoute = await import("../../src/app/api/cli/tokens/[id]/route.ts");
const keyByIdRoute = await import("../../src/app/api/keys/[id]/route.ts");

let writeToken = { id: "", secret: "" };
let adminToken = { id: "", secret: "" };

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

interface Stamp {
  kind: string;
  id: string;
  label?: string;
}

async function makeRequest(
  url: string,
  init: {
    method: string;
    bearer?: string;
    session?: boolean;
    stamp?: Stamp;
    body?: Record<string, unknown>;
  }
): Promise<Request> {
  const headers = new Headers({ "x-request-id": `req-${init.method}-${url.length}` });
  if (init.session) headers.set("cookie", await sessionCookie());
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.stamp) {
    headers.set("x-omniroute-auth-kind", init.stamp.kind);
    headers.set("x-omniroute-auth-id", init.stamp.id);
    if (init.stamp.label) headers.set("x-omniroute-auth-label", init.stamp.label);
  }
  if (init.body) headers.set("content-type", "application/json");
  return new Request(url, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

function events(action: string) {
  return compliance.getAuditLog({ action, limit: 100 });
}

function metadataOf(event: Record<string, unknown>): Record<string, unknown> {
  const metadata = event.metadata;
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata));
  return metadata as Record<string, unknown>;
}

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  await settingsDb.updateSettings({ requireLogin: true });
  const write = accessTokensDb.createAccessToken({
    name: "audit-write",
    scope: "write",
    expiresAt: null,
  });
  writeToken = { id: write.record.id, secret: write.secret };
  const admin = accessTokensDb.createAccessToken({
    name: "audit-admin",
    scope: "admin",
    expiresAt: null,
  });
  adminToken = { id: admin.record.id, secret: admin.secret };
});

test.after(() => {
  costRules.resetCostData();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST /api/usage/budget records budget.set with the stamped operator principal", async () => {
  const key = await apiKeysDb.createApiKey("audit-budget", "machine-audit-01", []);
  const response = await budgetRoute.POST(
    await makeRequest("http://localhost/api/usage/budget", {
      method: "POST",
      bearer: writeToken.secret,
      stamp: { kind: "management_key", id: writeToken.id, label: "access-token:write" },
      body: { apiKeyId: key.id, dailyLimitUsd: 5, warningThreshold: 0.8 },
    })
  );
  assert.equal(response.status, 200);

  const [event] = events("budget.set");
  assert.ok(event);
  assert.equal(event.actor, `management_key:${writeToken.id}`);
  assert.equal(event.target, key.id);
  assert.equal(event.resourceType, "internal_budget");
  const metadata = metadataOf(event);
  assert.equal(metadata.role, "operator");
  assert.equal(metadata.dailyLimitUsd, 5);
  assert.equal(metadata.warningThreshold, 0.8);

  const invalid = await budgetRoute.POST(
    await makeRequest("http://localhost/api/usage/budget", {
      method: "POST",
      session: true,
      body: { dailyLimitUsd: 5 },
    })
  );
  assert.equal(invalid.status, 400);
  assert.equal(events("budget.set").length, 1, "a rejected mutation must not be audited");
});

test("CLI access token create/revoke are audited without the secret, hash or prefix", async () => {
  const stamp = { kind: "management_key", id: adminToken.id, label: "access-token:admin" };
  const created = await tokensRoute.POST(
    await makeRequest("http://localhost/api/cli/tokens", {
      method: "POST",
      bearer: adminToken.secret,
      stamp,
      body: { name: "audited-token", scope: "read" },
    })
  );
  assert.equal(created.status, 200);
  const body = (await created.json()) as { token: string; id: string; tokenPrefix: string };

  const [createEvent] = events("accessToken.create");
  assert.ok(createEvent);
  assert.equal(createEvent.target, body.id);
  assert.equal(createEvent.actor, `management_key:${adminToken.id}`);
  const metadata = metadataOf(createEvent);
  assert.deepEqual(
    { name: metadata.name, scope: metadata.scope, role: metadata.role },
    { name: "audited-token", scope: "read", role: "admin" }
  );
  const dump = JSON.stringify(createEvent);
  assert.equal(dump.includes(body.token), false);
  assert.equal(dump.includes(accessTokensDb.hashAccessToken(body.token)), false);
  assert.equal(dump.includes(body.tokenPrefix), false);

  const revokeRequest = () =>
    makeRequest(`http://localhost/api/cli/tokens/${body.id}`, {
      method: "DELETE",
      bearer: adminToken.secret,
      stamp,
    });
  const revoked = await tokenByIdRoute.DELETE(await revokeRequest(), {
    params: Promise.resolve({ id: body.id }),
  });
  assert.equal(revoked.status, 200);
  const again = await tokenByIdRoute.DELETE(await revokeRequest(), {
    params: Promise.resolve({ id: body.id }),
  });
  assert.equal(again.status, 404);
  const revokeEvents = events("accessToken.revoke");
  assert.equal(revokeEvents.length, 1);
  assert.equal(revokeEvents[0].target, body.id);
});

test("CLI access token revoke by display prefix audits the token id, never the prefix", async () => {
  const stamp = { kind: "management_key", id: adminToken.id, label: "access-token:admin" };
  const created = accessTokensDb.createAccessToken({ name: "revoke-by-prefix", scope: "read" });
  const prefix = created.record.tokenPrefix;
  const before = events("accessToken.revoke").length;
  const revoked = await tokenByIdRoute.DELETE(
    await makeRequest(`http://localhost/api/cli/tokens/${prefix}`, {
      method: "DELETE",
      bearer: adminToken.secret,
      stamp,
    }),
    { params: Promise.resolve({ id: prefix }) }
  );
  assert.equal(revoked.status, 200);
  const revokeEvents = events("accessToken.revoke");
  assert.equal(revokeEvents.length, before + 1);
  const event = revokeEvents.find((entry) => entry.target === created.record.id);
  assert.ok(event, "the revoke event must target the token id");
  assert.equal(JSON.stringify(event).includes(prefix), false, "audit row exposed the prefix");
  assert.equal(accessTokensDb.verifyAccessToken(created.secret), null);
});

test("API key permission updates and deletion are audited; a 404 records nothing", async () => {
  const key = await apiKeysDb.createApiKey("audit-permissions", "machine-audit-02", []);
  const patched = await keyByIdRoute.PATCH(
    await makeRequest(`http://localhost/api/keys/${key.id}`, {
      method: "PATCH",
      session: true,
      body: { name: "audit-permissions-renamed", noLog: true },
    }),
    { params: Promise.resolve({ id: key.id }) }
  );
  assert.equal(patched.status, 200);
  const [updateEvent] = events("apiKey.permissions.update");
  assert.ok(updateEvent);
  assert.equal(updateEvent.actor, "admin", "unstamped direct invocation falls back to 'admin'");
  const updateMetadata = metadataOf(updateEvent);
  assert.deepEqual(updateMetadata.changedFields, ["name", "noLog"]);
  assert.equal(updateMetadata.role, null);

  const deleteRequest = (id: string) =>
    makeRequest(`http://localhost/api/keys/${id}`, {
      method: "DELETE",
      session: true,
      stamp: { kind: "dashboard_session", id: "dashboard" },
    });
  const deleted = await keyByIdRoute.DELETE(await deleteRequest(key.id), {
    params: Promise.resolve({ id: key.id }),
  });
  assert.equal(deleted.status, 200);
  const missing = await keyByIdRoute.DELETE(await deleteRequest("missing-key-id"), {
    params: Promise.resolve({ id: "missing-key-id" }),
  });
  assert.equal(missing.status, 404);

  const deleteEvents = events("apiKey.delete");
  assert.equal(deleteEvents.length, 1);
  assert.equal(deleteEvents[0].actor, "dashboard_session:dashboard");
  assert.equal(deleteEvents[0].target, key.id);
  assert.equal(metadataOf(deleteEvents[0]).role, "owner");
  assert.equal(JSON.stringify(compliance.getAuditLog({ limit: 5000 })).includes(key.key), false);
});

interface DeliveryRow {
  event_type: string;
  payload_snapshot: string | null;
}

function budgetDeliveries(webhookId: string): DeliveryRow[] {
  return core
    .getDbInstance()
    .prepare("SELECT event_type, payload_snapshot FROM webhook_deliveries WHERE webhook_id = ?")
    .all(webhookId) as DeliveryRow[];
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("crossing the internal budget warning threshold emits budget.threshold_reached once per period", async () => {
  const webhook = webhooksDb.createWebhook({
    url: "http://127.0.0.1:9/phase8-budget-alert",
    events: ["budget.threshold_reached"],
  });
  const below = await apiKeysDb.createApiKey("audit-budget-below", "machine-audit-03", []);
  const above = await apiKeysDb.createApiKey("audit-budget-above", "machine-audit-03", []);

  costRules.setBudget(below.id, { dailyLimitUsd: 1, warningThreshold: 0.5 });
  costRules.recordCost(below.id, 0.1);
  assert.equal(costRules.checkBudget(below.id).warningReached, false);

  costRules.setBudget(above.id, { dailyLimitUsd: 1, warningThreshold: 0.5 });
  costRules.recordCost(above.id, 0.75);
  assert.equal(costRules.checkBudget(above.id).warningReached, true);
  assert.equal(costRules.checkBudget(above.id).warningReached, true);

  assert.equal(
    await waitFor(() => budgetDeliveries(webhook.id).length >= 1, 15_000),
    true,
    "budget.threshold_reached was never dispatched"
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rows = budgetDeliveries(webhook.id);
  assert.equal(rows.length, 1, "the alert must be emitted once per budget period");
  assert.equal(rows[0].event_type, "budget.threshold_reached");
  const payload = JSON.parse(String(rows[0].payload_snapshot)) as {
    event: string;
    data: Record<string, unknown>;
  };
  assert.equal(payload.event, "budget.threshold_reached");
  assert.equal(payload.data.source, "internal_budget");
  assert.equal(payload.data.apiKeyId, above.id);
  assert.equal(payload.data.limitUsd, 1);
  assert.equal(payload.data.percent, 75);
  assert.equal(payload.data.resetInterval, "daily");
  assert.equal(JSON.stringify(payload).includes(above.key), false);
});
