/**
 * Finding F-6 (image generation, model-routed): POST /v1/images/generations checked the credential
 * lookup only for `allRateLimited`. When every connection of the provider is in a terminal state, the
 * lookup returns `{ allExpired: true, expiredCount, expiredStatus }`; the route handed that verdict to
 * the image credential-retry loop, which skips it and ends in the generic 401 "Authentication failed
 * for all eligible image-provider accounts" — credits_exhausted never became 402 and nothing said the
 * account needs reconnecting. The route must answer like the chat path and never reach upstream.
 * Upstream fetches are captured by a stub, so nothing leaves the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-gen-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "image-gen-expired-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

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
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedTerminalConnection(provider: string, testStatus: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${testStatus}`,
    apiKey: `sk-${provider}-${testStatus}-${Math.random().toString(16).slice(2, 10)}`,
    isActive: true,
    testStatus,
    backoffLevel: 4,
    providerSpecificData: {},
  });
  const credentials = await auth.getProviderCredentials(provider);
  assert.equal(
    credentials?.allExpired,
    true,
    `precondition: a ${testStatus} ${provider} pool makes the credential lookup report allExpired`
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

for (const { status, httpStatus, reason } of [
  { status: "expired", httpStatus: 401, reason: /authentication expired/ },
  { status: "banned", httpStatus: 401, reason: /banned by upstream/ },
  { status: "credits_exhausted", httpStatus: 402, reason: /credits exhausted/ },
] as const) {
  test(`image generation answers ${httpStatus} without calling upstream when every openai connection is ${status}`, async () => {
    await seedTerminalConnection("openai", status);

    const res = await imageRoute.POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-image-2", prompt: "draw a lighthouse" }),
      })
    );

    assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error?.message), reason);
    assert.match(String(body.error?.message), /reconnect/);
    assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
  });
}
