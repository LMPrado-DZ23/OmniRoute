/**
 * Finding F-6: the provider-scoped v1 image-generation and embeddings routes checked the credential
 * lookup only for the `allRateLimited` sentinel. When every connection of the provider is in a
 * terminal state (expired, banned, credits_exhausted), getProviderCredentialsWithQuotaPreflight
 * returns `{ allExpired: true, expiredCount, expiredStatus }`, and those routes passed that object
 * on as if it were credentials. The chat path answers 401 (402 for credits_exhausted) with a
 * reconnect hint (src/sse/handlers/chatHelpers.ts); these routes must answer the same way and never
 * reach the upstream provider. Upstream fetches are captured by a stub, so nothing leaves the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-all-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "all-expired-test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const providerImageRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");
const providerEmbeddingsRoute =
  await import("../../src/app/api/v1/providers/[provider]/embeddings/route.ts");

const originalFetch = globalThis.fetch;
let upstreamCalls: string[] = [];

async function resetStorage() {
  upstreamCalls = [];
  globalThis.fetch = async (url) => {
    upstreamCalls.push(String(url));
    return new Response(JSON.stringify({ error: { message: "stubbed upstream" } }), {
      status: 500,
    });
  };
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedTerminalConnection(provider: string, testStatus: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${testStatus}`,
    apiKey: `sk-${testStatus}-${Math.random().toString(16).slice(2, 10)}`,
    isActive: true,
    testStatus,
    backoffLevel: 4,
    providerSpecificData: {},
  });
  const credentials = await auth.getProviderCredentials(provider);
  assert.equal(
    credentials?.allExpired,
    true,
    `precondition: a ${testStatus} pool makes the credential lookup report allExpired`
  );
  upstreamCalls = [];
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CASES = [
  { status: "expired", httpStatus: 401, reason: /authentication expired/ },
  { status: "banned", httpStatus: 401, reason: /banned by upstream/ },
  { status: "credits_exhausted", httpStatus: 402, reason: /credits exhausted/ },
] as const;

for (const { status, httpStatus, reason } of CASES) {
  test(`provider image generation answers ${httpStatus} without calling upstream when every connection is ${status}`, async () => {
    await seedTerminalConnection("openai", status);

    const res = await providerImageRoute.POST(
      new Request("http://localhost/api/v1/providers/openai/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1", prompt: "draw a lighthouse" }),
      }),
      { params: Promise.resolve({ provider: "openai" }) }
    );

    assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error?.message), reason);
    assert.match(String(body.error?.message), /reconnect/);
    assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
  });

  test(`provider embeddings answer ${httpStatus} without calling upstream when every connection is ${status}`, async () => {
    await seedTerminalConnection("openai", status);

    const res = await providerEmbeddingsRoute.POST(
      new Request("http://localhost/api/v1/providers/openai/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
      }),
      { params: Promise.resolve({ provider: "openai" }) }
    );

    assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error?.message), reason);
    assert.match(String(body.error?.message), /reconnect/);
    assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
  });
}
