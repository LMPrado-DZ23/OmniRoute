/**
 * Finding F-6 (search): /v1/search resolves provider credentials and skips only rate-limited stubs.
 * When every connection of a provider is in a terminal state, the credential lookup returns
 * `{ allExpired: true, expiredCount, expiredStatus }`, which is truthy and not rate-limited, so
 * auto-select picked that provider as if it were credentialed and an explicit request sent the
 * verdict to the search handler. An expired pool must be skipped during auto-select, and an explicit
 * request must get the chat path's 401/402 reconnect answer. Upstream fetches are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-search-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const searchRoute = await import("../../src/app/api/v1/search/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, testStatus = "active") {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${testStatus}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: `${provider}-${testStatus}-key`,
    isActive: true,
    testStatus,
    ...(testStatus === "active" ? {} : { backoffLevel: 4 }),
    providerSpecificData: {},
  });
  if (testStatus !== "active") {
    const credentials = await auth.getProviderCredentials(provider);
    assert.equal(
      credentials?.allExpired,
      true,
      `precondition: a ${testStatus} ${provider} pool makes the credential lookup report allExpired`
    );
  }
}

function stubUpstream() {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://api.linkup.so/")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              name: "Linkup result",
              url: "https://example.com/article",
              content: "Linkup snippet",
              type: "web",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "stubbed upstream" }), { status: 500 });
  };
  return calls;
}

function postSearch(body: Record<string, unknown>) {
  return searchRoute.POST(
    new Request("http://localhost/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "omniroute search",
        max_results: 1,
        search_type: "web",
        ...body,
      }),
    })
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("auto-select skips an all-expired firecrawl pool and searches with linkup", async () => {
  await seedConnection("firecrawl", "expired");
  await seedConnection("linkup-search");
  const calls = stubUpstream();

  const response = await postSearch({});
  const body = await response.json();

  assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
  assert.equal(body.provider, "linkup-search");
  assert.equal(
    calls.some((u) => u.includes("api.firecrawl.dev")),
    false,
    "the expired firecrawl pool must never be called"
  );
});

for (const { status, httpStatus, reason } of [
  { status: "expired", httpStatus: 401, reason: /authentication expired/ },
  { status: "credits_exhausted", httpStatus: 402, reason: /credits exhausted/ },
] as const) {
  test(`explicit firecrawl search with an all-${status} pool answers ${httpStatus} without calling upstream`, async () => {
    await seedConnection("firecrawl", status);
    const calls = stubUpstream();

    const response = await postSearch({ provider: "firecrawl" });
    const body = await response.json();

    assert.equal(response.status, httpStatus, `Expected ${httpStatus}, got ${response.status}`);
    assert.match(String(body.error?.message), reason);
    assert.match(String(body.error?.message), /reconnect/);
    assert.deepEqual(calls, [], "no request may reach an upstream provider");
  });
}
