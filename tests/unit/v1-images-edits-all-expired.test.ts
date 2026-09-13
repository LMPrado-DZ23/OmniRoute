/**
 * Finding F-6 (image edits): every credential branch of POST /v1/images/edits (Codex, fal,
 * Adobe Firefly, OpenRouter, custom OpenAI-compatible nodes) checked the credential lookup only for
 * `allRateLimited`. When every connection of the provider is in a terminal state, the lookup returns
 * `{ allExpired: true, expiredCount, expiredStatus }`, which those branches passed on as if it were
 * credentials. The chat path answers 401 (402 for credits_exhausted) with a reconnect hint; the
 * edit route must answer the same way and never reach the upstream provider. Upstream fetches are
 * captured by a stub, so nothing leaves the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-edits-all-expired-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "edits-all-expired-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const originalFetch = globalThis.fetch;
let upstreamCalls: string[] = [];

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const REF_DATA_URL = `data:image/png;base64,${Buffer.from(VALID_PNG_BYTES).toString("base64")}`;

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

function codexEditRequest() {
  const formData = new FormData();
  formData.set("prompt", "make it brighter");
  formData.set("model", "codex/gpt-5.6-sol");
  formData.set("image", new File([VALID_PNG_BYTES], "reference.png", { type: "image/png" }));
  return new Request("http://localhost/api/v1/images/edits", { method: "POST", body: formData });
}

function openRouterEditRequest() {
  return new Request("http://localhost/api/v1/images/edits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "openrouter/google/gemini-3.1-flash-image-preview",
      prompt: "add a red hat",
      images: [REF_DATA_URL],
    }),
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

const BRANCHES = [
  { label: "Codex", provider: "codex", request: codexEditRequest },
  { label: "OpenRouter", provider: "openrouter", request: openRouterEditRequest },
] as const;

for (const branch of BRANCHES) {
  for (const { status, httpStatus, reason } of CASES) {
    test(`${branch.label} image edit answers ${httpStatus} without calling upstream when every connection is ${status}`, async () => {
      await seedTerminalConnection(branch.provider, status);

      const res = await imageEditRoute.POST(branch.request());

      assert.equal(res.status, httpStatus, `Expected ${httpStatus}, got ${res.status}`);
      const body = await res.json();
      assert.match(String(body.error?.message), reason);
      assert.match(String(body.error?.message), /reconnect/);
      assert.deepEqual(upstreamCalls, [], "no request may reach the upstream provider");
    });
  }
}
