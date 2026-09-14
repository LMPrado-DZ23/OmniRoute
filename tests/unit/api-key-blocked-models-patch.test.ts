/**
 * PATCH /api/keys/[id] reads `blockedModels` from the validated body and passes it to
 * updateApiKeyPermissions, and the API manager page sends it. But updateKeyPermissionsSchema did not
 * declare the field, so Zod stripped it: a request that only changed blocked models failed the
 * "at least one field" check, and blocked models sent with other fields were silently dropped.
 * Blocked models must be saved, and an empty update must still be rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-blocked-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret-blocked-models";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const keyRoute = await import("../../src/app/api/keys/[id]/route.ts");

const MACHINE_ID = "1234567890abcdef";

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function patch(id: string, body: unknown) {
  return keyRoute.PATCH(
    new Request(`http://localhost/api/keys/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

test("PATCH saves blockedModels sent on their own", async () => {
  const created = await apiKeysDb.createApiKey("Blocked models only", MACHINE_ID);

  const res = await patch(created.id, { blockedModels: ["openai/gpt-4o"] });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);

  const stored = await apiKeysDb.getApiKeyById(created.id);
  assert.deepEqual(stored?.blockedModels, ["openai/gpt-4o"]);
});

test("PATCH saves blockedModels sent together with other fields", async () => {
  const created = await apiKeysDb.createApiKey("Blocked models and noLog", MACHINE_ID);

  const res = await patch(created.id, { noLog: true, blockedModels: ["anthropic/claude-opus-4"] });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);

  const stored = await apiKeysDb.getApiKeyById(created.id);
  assert.equal(stored?.noLog, true);
  assert.deepEqual(stored?.blockedModels, ["anthropic/claude-opus-4"]);
});

test("PATCH still rejects an update with no fields", async () => {
  const created = await apiKeysDb.createApiKey("No fields", MACHINE_ID);

  const res = await patch(created.id, {});
  assert.equal(res.status, 400);
});
