/**
 * Finding F-6 (web fetch): /v1/web/fetch resolves provider credentials through a cast that hid the
 * credential lookup's `{ allExpired: true, expiredCount, expiredStatus }` verdict. That object is
 * truthy and is not rate-limited, so auto-select picked a provider whose every connection is in a
 * terminal state, the fallback walk could pick it too, and an explicit request sent the verdict to
 * the handler as if it were credentials. An expired pool must be skipped during auto-select (like a
 * rate-limited one), and an explicit request, or an auto-select with nothing else usable, must get
 * the chat path's 401/402 reconnect answer. Upstream fetches are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-web-fetch-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const webFetchRoute = await import("../../src/app/api/v1/web/fetch/route.ts");

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

function postWebFetch(body: Record<string, unknown>) {
  return webFetchRoute.POST(
    new Request("http://localhost/api/v1/web/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", ...body }),
    })
  );
}

function stubUpstream() {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("r.jina.ai")) {
      return new Response(JSON.stringify({ data: { content: "jina content", links: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "stubbed upstream" }), { status: 500 });
  };
  return calls;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("auto-select skips an all-expired firecrawl pool and uses jina-reader", async () => {
  await seedConnection("firecrawl", "expired");
  await seedConnection("jina-reader");
  const calls = stubUpstream();

  const response = await postWebFetch({});
  const body = await response.json();

  assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
  assert.equal(body.provider, "jina-reader");
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
  test(`explicit firecrawl with an all-${status} pool answers ${httpStatus} without calling upstream or falling back`, async () => {
    await seedConnection("firecrawl", status);
    await seedConnection("jina-reader");
    const calls = stubUpstream();

    const response = await postWebFetch({ provider: "firecrawl" });
    const body = await response.json();

    assert.equal(response.status, httpStatus, `Expected ${httpStatus}, got ${response.status}`);
    assert.match(String(body.error?.message), reason);
    assert.match(String(body.error?.message), /reconnect/);
    assert.deepEqual(calls, [], "no upstream request and no fallback for an explicit provider");
  });
}

test("auto-select with only an all-expired pool answers 401 with a reconnect hint instead of 'not configured'", async () => {
  await seedConnection("firecrawl", "banned");
  const calls = stubUpstream();

  const response = await postWebFetch({});
  const body = await response.json();

  assert.equal(response.status, 401, `Expected 401, got ${response.status}`);
  assert.match(String(body.error?.message), /banned by upstream/);
  assert.match(String(body.error?.message), /reconnect/);
  assert.deepEqual(calls, [], "no request may reach an upstream provider");
});
