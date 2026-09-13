/**
 * Finding F-6 (single-site routes): POST /v1/classify, /v1/moderations, /v1/ocr and /v1/audio/speech
 * each resolve credentials in one place and checked the lookup only for `allRateLimited`. When every
 * connection of the provider is in a terminal state, the lookup returns
 * `{ allExpired: true, expiredCount, expiredStatus }`, which the routes passed on as if it were
 * credentials. The chat path answers 401 (402 for credits_exhausted) with a reconnect hint; these
 * routes must answer the same way and never reach the upstream provider. Upstream fetches are
 * captured by a stub, so nothing leaves the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-single-site-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "single-site-expired-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const classifyRoute = await import("../../src/app/api/v1/classify/route.ts");
const moderationsRoute = await import("../../src/app/api/v1/moderations/route.ts");
const ocrRoute = await import("../../src/app/api/v1/ocr/route.ts");
const speechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");

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

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

const ROUTES = [
  {
    label: "classify",
    provider: "jina-ai",
    call: () =>
      classifyRoute.POST(
        jsonRequest("http://localhost/api/v1/classify", {
          input: ["a lighthouse on a cliff"],
          labels: ["coast", "kitchen"],
        })
      ),
  },
  {
    label: "moderations",
    provider: "openai",
    call: () =>
      moderationsRoute.POST(
        jsonRequest("http://localhost/api/v1/moderations", { input: "is this text acceptable?" })
      ),
  },
  {
    label: "ocr",
    provider: "mistral",
    call: () =>
      ocrRoute.POST(
        jsonRequest("http://localhost/api/v1/ocr", {
          document: { type: "document_url", document_url: "https://example.com/doc.pdf" },
        })
      ),
  },
  {
    label: "audio speech",
    provider: "openai",
    call: () =>
      speechRoute.POST(
        jsonRequest("http://localhost/api/v1/audio/speech", {
          model: "openai/tts-1",
          input: "hello there",
          voice: "alloy",
        })
      ),
  },
] as const;

for (const route of ROUTES) {
  for (const { status, httpStatus, reason } of CASES) {
    test(`${route.label} answers ${httpStatus} without calling upstream when every connection is ${status}`, async () => {
      await seedTerminalConnection(route.provider, status);

      const res = await route.call();

      assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
      const body = await res.json();
      assert.match(String(body.error?.message), reason);
      assert.match(String(body.error?.message), /reconnect/);
      assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
    });
  }
}
