/**
 * Phase 8 — resource authorization matrix at the ROUTE HANDLER level:
 *   principal (7) × resource route (4) × resource state (owned / foreign / nonexistent).
 *
 * OmniRoute is single-tenant today (no workspace ownership column), so "foreign" means an id
 * that EXISTS but is not addressable through this collection: another collection's id, or an
 * already-revoked CLI token. Invariants:
 *   - an unauthorized principal gets the identical status + body for owned, foreign and
 *     nonexistent ids (auth is decided before any lookup, so existence never leaks);
 *   - an authorized principal gets the success status for an owned resource and the identical
 *     404 status + body for foreign and nonexistent ids;
 *   - no response body and no audit-log row contains a full credential.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-resource-matrix-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "resource-matrix-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "resource-matrix-jwt-secret";
process.env.INITIAL_PASSWORD = "resource-matrix-password";
process.env.APP_LOG_TO_FILE = "false";
delete process.env.ALLOW_API_KEY_REVEAL;
delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
delete process.env.OMNIROUTE_DISABLE_CLI_TOKEN;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../../src/lib/db/accessTokens.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const compliance = await import("../../../src/lib/compliance/index.ts");
const keyByIdRoute = await import("../../../src/app/api/keys/[id]/route.ts");
const providerByIdRoute = await import("../../../src/app/api/providers/[id]/route.ts");
const tokenByIdRoute = await import("../../../src/app/api/cli/tokens/[id]/route.ts");
const { inferRequiredScope } = await import("../../../src/server/authz/accessScopes.ts");
const { scopeSatisfies } = await import("../../../src/lib/accessTokens/scopes.ts");

type Principal =
  | "owner-session"
  | "admin-api-key"
  | "admin-token"
  | "operator-token"
  | "viewer-token"
  | "client-api-key"
  | "anonymous";

const PRINCIPALS: readonly Principal[] = [
  "owner-session",
  "admin-api-key",
  "admin-token",
  "operator-token",
  "viewer-token",
  "client-api-key",
  "anonymous",
];

const TOKEN_SCOPE = {
  "admin-token": "admin",
  "operator-token": "write",
  "viewer-token": "read",
} as const;
const PROVIDER_SECRET = "sk-phase8-resource-matrix-provider-secret-0123456789";

const secrets = new Map<Principal, string>();
const allSecrets: string[] = [PROVIDER_SECRET];
const observedTexts: string[] = [];

let targetKeyId = "";
let providerConnectionId = "";
let revokedTokenId = "";

interface Observed {
  status: number;
  body: unknown;
}

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

interface ResourceCase {
  label: string;
  method: "GET" | "PATCH" | "DELETE";
  collection: string;
  successStatus: number;
  body?: Record<string, unknown>;
  handler: Handler;
  owned: () => string;
  foreign: () => string;
}

function isAuthorized(principal: Principal, method: string, routePath: string): boolean {
  if (principal === "owner-session" || principal === "admin-api-key") return true;
  if (
    principal === "admin-token" ||
    principal === "operator-token" ||
    principal === "viewer-token"
  ) {
    return scopeSatisfies(TOKEN_SCOPE[principal], inferRequiredScope(method, routePath));
  }
  return false;
}

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

async function call(caseDef: ResourceCase, principal: Principal, id: string): Promise<Observed> {
  const headers = new Headers({ "x-request-id": `req-${principal}-${caseDef.label}` });
  if (principal === "owner-session") headers.set("cookie", await sessionCookie());
  const secret = secrets.get(principal);
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  let body: string | undefined;
  if (caseDef.body) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(caseDef.body);
  }
  const request = new Request(`http://localhost${caseDef.collection}/${encodeURIComponent(id)}`, {
    method: caseDef.method,
    headers,
    body,
  });
  const response = await caseDef.handler(request, { params: Promise.resolve({ id }) });
  const text = await response.text();
  observedTexts.push(text);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON body is compared verbatim
  }
  return { status: response.status, body: parsed };
}

/**
 * `requestId` is a fresh per-request correlation id in error envelopes (createErrorResponse);
 * it is independent of the addressed resource, so it is the only field ignored.
 */
function withoutRequestId(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { requestId: _requestId, ...rest } = body as Record<string, unknown>;
  return rest;
}

function sameResponse(a: Observed, b: Observed): boolean {
  return (
    a.status === b.status &&
    JSON.stringify(withoutRequestId(a.body)) === JSON.stringify(withoutRequestId(b.body))
  );
}

function freshToken(): string {
  return accessTokensDb.createAccessToken({ name: "matrix-owned", scope: "read", expiresAt: null })
    .record.id;
}

const CASES: readonly ResourceCase[] = [
  {
    label: "GET key detail",
    method: "GET",
    collection: "/api/keys",
    successStatus: 200,
    handler: keyByIdRoute.GET,
    owned: () => targetKeyId,
    foreign: () => providerConnectionId,
  },
  {
    label: "PATCH key permissions",
    method: "PATCH",
    collection: "/api/keys",
    successStatus: 200,
    body: { name: "matrix-renamed" },
    handler: keyByIdRoute.PATCH,
    owned: () => targetKeyId,
    foreign: () => providerConnectionId,
  },
  {
    label: "GET provider connection",
    method: "GET",
    collection: "/api/providers",
    successStatus: 200,
    handler: providerByIdRoute.GET,
    owned: () => providerConnectionId,
    foreign: () => targetKeyId,
  },
  {
    label: "DELETE CLI access token",
    method: "DELETE",
    collection: "/api/cli/tokens",
    successStatus: 200,
    handler: tokenByIdRoute.DELETE,
    owned: freshToken,
    foreign: () => revokedTokenId,
  },
];

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  await settingsDb.updateSettings({ requireLogin: true });
  const machine = "machine-resource-01";
  const manage = await apiKeysDb.createApiKey("matrix-manage", machine, ["manage"]);
  const client = await apiKeysDb.createApiKey("matrix-client", machine, []);
  const target = await apiKeysDb.createApiKey("matrix-target", machine, []);
  secrets.set("admin-api-key", manage.key);
  secrets.set("client-api-key", client.key);
  allSecrets.push(manage.key, client.key, target.key);
  targetKeyId = target.id;
  for (const principal of ["admin-token", "operator-token", "viewer-token"] as const) {
    const { secret } = accessTokensDb.createAccessToken({
      name: principal,
      scope: TOKEN_SCOPE[principal],
      expiresAt: null,
    });
    secrets.set(principal, secret);
    allSecrets.push(secret);
  }
  const revoked = accessTokensDb.createAccessToken({
    name: "matrix-revoked",
    scope: "read",
    expiresAt: null,
  });
  allSecrets.push(revoked.secret);
  revokedTokenId = revoked.record.id;
  assert.equal(accessTokensDb.revokeAccessToken(revokedTokenId), true);
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Matrix OpenAI",
    apiKey: PROVIDER_SECRET,
  });
  providerConnectionId = String(connection.id);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const caseDef of CASES) {
  test(`resource matrix ${caseDef.label} (${PRINCIPALS.length} principals × 3 states)`, async () => {
    const failures: string[] = [];
    for (const principal of PRINCIPALS) {
      const owned = await call(caseDef, principal, caseDef.owned());
      const foreign = await call(caseDef, principal, caseDef.foreign());
      const missing = await call(caseDef, principal, `missing-${crypto.randomUUID()}`);
      const routePath = `${caseDef.collection}/x`;
      const cell = `${principal}`;
      if (isAuthorized(principal, caseDef.method, routePath)) {
        if (owned.status !== caseDef.successStatus) {
          failures.push(`${cell}: owned expected ${caseDef.successStatus}, got ${owned.status}`);
        }
        if (foreign.status !== 404)
          failures.push(`${cell}: foreign expected 404, got ${foreign.status}`);
        if (!sameResponse(foreign, missing)) {
          failures.push(
            `${cell}: foreign ${JSON.stringify(foreign)} distinguishable from nonexistent ${JSON.stringify(missing)}`
          );
        }
      } else {
        if (![401, 403].includes(owned.status)) {
          failures.push(`${cell}: unauthorized expected 401/403, got ${owned.status}`);
        }
        if (!sameResponse(owned, foreign) || !sameResponse(foreign, missing)) {
          failures.push(
            `${cell}: unauthorized responses differ — owned ${JSON.stringify(owned)}, foreign ${JSON.stringify(foreign)}, nonexistent ${JSON.stringify(missing)}`
          );
        }
      }
    }
    assert.deepEqual(failures, [], `resource matrix deviations:\n${failures.join("\n")}`);
  });
}

test("no response body or audit-log row contains a full credential", () => {
  assert.ok(observedTexts.length >= CASES.length * PRINCIPALS.length * 3);
  const auditDump = JSON.stringify(compliance.getAuditLog({ limit: 5000 }));
  for (const secret of allSecrets) {
    const fingerprint = `${secret.slice(0, 6)}…(${secret.length})`;
    assert.equal(
      observedTexts.some((text) => text.includes(secret)),
      false,
      `a response exposed ${fingerprint}`
    );
    assert.equal(auditDump.includes(secret), false, `the audit log exposed ${fingerprint}`);
  }
});
