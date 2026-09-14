/**
 * PUT /api/settings/cache-config and POST /api/settings/models-dev validate their body with
 * validateBody(), then returned `validation.response` on failure. A validation failure has no
 * `response` (only `error: { message, details }`), so the handler returned undefined and an invalid
 * body became a server error instead of a 400 that names the offending field. Both routes must
 * answer 400 with the validation details, and valid requests must keep working.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-validation-400-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const cacheConfigRoute = await import("../../src/app/api/settings/cache-config/route.ts");
const modelsDevRoute = await import("../../src/app/api/settings/models-dev/route.ts");

const originalFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = (async () => {
    throw new Error("settings validation tests must not call any upstream");
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectValidation400(response: Response | undefined) {
  assert.ok(response, "the handler must return a response for an invalid body");
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: { message?: string; details?: unknown[] } };
  assert.equal(body.error?.message, "Invalid request");
  assert.ok(
    Array.isArray(body.error?.details) && body.error.details.length > 0,
    "details must name the field"
  );
}

test("PUT /api/settings/cache-config answers 400 for an invalid body", async () => {
  const response = await cacheConfigRoute.PUT(
    jsonRequest("http://localhost/api/settings/cache-config", "PUT", {
      modelCatalogCacheTtlMs: "not-a-number",
    }) as never
  );
  await expectValidation400(response);
});

test("PUT /api/settings/cache-config still accepts a valid update", async () => {
  const response = await cacheConfigRoute.PUT(
    jsonRequest("http://localhost/api/settings/cache-config", "PUT", {
      modelCatalogCacheTtlMs: 4242,
    }) as never
  );
  assert.equal(response.status, 200);
});

test("POST /api/settings/models-dev answers 400 for an unknown action", async () => {
  const response = await modelsDevRoute.POST(
    jsonRequest("http://localhost/api/settings/models-dev", "POST", {
      action: "not-an-action",
    }) as never
  );
  await expectValidation400(response);
});
