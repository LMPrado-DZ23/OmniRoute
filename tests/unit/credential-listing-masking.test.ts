/**
 * Phase 8 — credential listing/detail endpoints never return a full secret after creation.
 *
 *   - OmniRoute API keys: full value only in the create response (reveal-once, #7).
 *   - CLI access tokens: secret only in the create response; listings carry neither the
 *     secret nor its hash.
 *   - Provider connections: masked for every caller by default. `ALLOW_API_KEY_REVEAL=true`
 *     (documented dashboard-UI opt-in) reveals only to a dashboard caller; a programmatic
 *     credential (Bearer API key / `oma_` token, x-api-key, loopback CLI token) stays masked,
 *     and every reveal is audited without the credential itself.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-credential-listing-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "credential-listing-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "credential-listing-jwt-secret";
process.env.INITIAL_PASSWORD = "credential-listing-password";
process.env.APP_LOG_TO_FILE = "false";
delete process.env.ALLOW_API_KEY_REVEAL;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../src/lib/db/accessTokens.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const keysRoute = await import("../../src/app/api/keys/route.ts");
const keyByIdRoute = await import("../../src/app/api/keys/[id]/route.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const providerByIdRoute = await import("../../src/app/api/providers/[id]/route.ts");
const tokensRoute = await import("../../src/app/api/cli/tokens/route.ts");

const PROVIDER_SECRET = "sk-phase8-listing-provider-secret-abcdefghijklmnop";
const createdSecrets: string[] = [PROVIDER_SECRET];

let manageKey = "";
let readToken = "";
let connectionId = "";

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

type Caller = "session" | "manage-key" | "read-token";

async function request(
  url: string,
  caller: Caller,
  init: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}
): Promise<Request> {
  const headers = new Headers(init.headers);
  if (caller === "session") headers.set("cookie", await sessionCookie());
  if (caller === "manage-key") headers.set("authorization", `Bearer ${manageKey}`);
  if (caller === "read-token") headers.set("authorization", `Bearer ${readToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function readProviders(
  req: () => Promise<Request>
): Promise<{ list: string; detail: string }> {
  const listResponse = await providersRoute.GET(await req());
  assert.equal(listResponse.status, 200);
  const detailResponse = await providerByIdRoute.GET(
    await req().then((r) => new Request(`http://localhost/api/providers/${connectionId}`, r)),
    { params: Promise.resolve({ id: connectionId }) }
  );
  assert.equal(detailResponse.status, 200);
  return { list: await listResponse.text(), detail: await detailResponse.text() };
}

function revealEvents() {
  return compliance.getAuditLog({ action: "provider.credentials.revealed", limit: 100 });
}

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  await settingsDb.updateSettings({ requireLogin: true });
  const manage = await apiKeysDb.createApiKey("listing-manage", "machine-listing-01", ["manage"]);
  manageKey = manage.key;
  const token = accessTokensDb.createAccessToken({
    name: "listing-read",
    scope: "read",
    expiresAt: null,
  });
  readToken = token.secret;
  createdSecrets.push(manageKey, readToken);
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Listing OpenAI",
    apiKey: PROVIDER_SECRET,
  });
  connectionId = String(connection.id);
});

test.after(() => {
  delete process.env.ALLOW_API_KEY_REVEAL;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("API keys: the full value appears only in the create response", async () => {
  const created = await keysRoute.POST(
    await request("http://localhost/api/keys", "session", {
      method: "POST",
      body: { name: "listing-created" },
    })
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { id: string; key: string };
  assert.equal(typeof createdBody.key, "string");
  assert.ok(createdBody.key.length > 12);
  createdSecrets.push(createdBody.key);

  for (const caller of ["session", "manage-key", "read-token"] as const) {
    const list = await keysRoute.GET(await request("http://localhost/api/keys", caller));
    assert.equal(list.status, 200, caller);
    const listText = await list.text();
    assert.equal(listText.includes(createdBody.key), false, `${caller}: list exposed the key`);
    assert.equal(listText.includes(manageKey), false, `${caller}: list exposed the manage key`);

    const detail = await keyByIdRoute.GET(
      await request(`http://localhost/api/keys/${createdBody.id}`, caller),
      { params: Promise.resolve({ id: createdBody.id }) }
    );
    assert.equal(detail.status, 200, caller);
    const detailBody = (await detail.json()) as { key: string | null };
    assert.notEqual(detailBody.key, createdBody.key);
    assert.match(String(detailBody.key), /\*\*\*\*/);
  }
});

test("CLI access tokens: the secret appears only in the create response, never its hash", async () => {
  const created = await tokensRoute.POST(
    await request("http://localhost/api/cli/tokens", "session", {
      method: "POST",
      body: { name: "listing-created-token", scope: "write" },
    })
  );
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { token: string; id: string };
  assert.match(createdBody.token, /^oma_/);
  createdSecrets.push(createdBody.token);

  const list = await tokensRoute.GET(await request("http://localhost/api/cli/tokens", "session"));
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.ok(listText.includes(createdBody.id));
  for (const secret of [createdBody.token, readToken]) {
    assert.equal(listText.includes(secret), false, "token listing exposed a secret");
    assert.equal(
      listText.includes(accessTokensDb.hashAccessToken(secret)),
      false,
      "token listing exposed a secret hash"
    );
  }
});

test("provider credentials are masked in list and detail for every caller by default", async () => {
  for (const caller of ["session", "manage-key", "read-token"] as const) {
    const { list, detail } = await readProviders(() =>
      request("http://localhost/api/providers", caller)
    );
    assert.equal(list.includes(PROVIDER_SECRET), false, `${caller}: list exposed the credential`);
    assert.equal(detail.includes(PROVIDER_SECRET), false, `${caller}: detail exposed it`);
    assert.match(detail, /sk-phase\*\*\*\*mnop/);
  }
  assert.equal(revealEvents().length, 0);
});

test("ALLOW_API_KEY_REVEAL reveals only to the dashboard, never to programmatic credentials", async () => {
  process.env.ALLOW_API_KEY_REVEAL = "true";
  try {
    const programmatic: Array<[string, () => Promise<Request>]> = [
      ["manage-key", () => request("http://localhost/api/providers", "manage-key")],
      ["read-token", () => request("http://localhost/api/providers", "read-token")],
      [
        "session+bearer",
        () =>
          request("http://localhost/api/providers", "session", {
            headers: { authorization: `Bearer ${manageKey}` },
          }),
      ],
      [
        "session+x-api-key",
        () =>
          request("http://localhost/api/providers", "session", {
            headers: { "x-api-key": manageKey },
          }),
      ],
      [
        "session+stamped-local-cli",
        () =>
          request("http://localhost/api/providers", "session", {
            headers: { "x-omniroute-auth-label": "local-cli-token" },
          }),
      ],
      [
        "session+cli-token-header",
        () =>
          request("http://localhost/api/providers", "session", {
            headers: { "x-omniroute-cli-token": "not-a-real-machine-token" },
          }),
      ],
    ];
    for (const [label, req] of programmatic) {
      const listResponse = await providersRoute.GET(await req());
      const listText = await listResponse.text();
      assert.equal(listText.includes(PROVIDER_SECRET), false, `${label}: list revealed it`);
      const detailResponse = await providerByIdRoute.GET(
        new Request(`http://localhost/api/providers/${connectionId}`, await req()),
        { params: Promise.resolve({ id: connectionId }) }
      );
      const detailText = await detailResponse.text();
      assert.equal(detailText.includes(PROVIDER_SECRET), false, `${label}: detail revealed it`);
    }
    assert.equal(revealEvents().length, 0, "masked responses must not be audited as reveals");

    const { list, detail } = await readProviders(() =>
      request("http://localhost/api/providers", "session")
    );
    assert.ok(list.includes(PROVIDER_SECRET), "dashboard opt-in reveal (list) must keep working");
    assert.ok(
      detail.includes(PROVIDER_SECRET),
      "dashboard opt-in reveal (detail) must keep working"
    );
    const events = revealEvents();
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.resourceType, "provider_credentials");
      assert.ok(JSON.stringify(event.metadata).includes(connectionId));
    }
  } finally {
    delete process.env.ALLOW_API_KEY_REVEAL;
  }
});

test("the audit log never contains a created credential", () => {
  const dump = JSON.stringify(compliance.getAuditLog({ limit: 5000 }));
  for (const secret of createdSecrets) {
    assert.equal(dump.includes(secret), false, `audit log exposed ${secret.slice(0, 6)}…`);
  }
});
