// Regression: POST /api/oauth/codex/import with a body that fails the Zod schema.
//
// The route read `parsed.error.errors[0]`. Zod v4 removed `ZodError.errors` (it is
// `issues`), so a schema failure threw a TypeError inside the handler instead of
// answering 400. The schema also used `errorMap`, which Zod v4 ignores, so the
// intended message ("accounts must be an object or an array of objects") never
// reached the client.
//
// DB handles are released in test.after (unreleased SQLite handles hang node:test).

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-import-invalid-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/oauth/codex/import/route.ts");

beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({ requireLogin: false });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function postImport(body: unknown): Promise<{ status: number; body: { error?: unknown } }> {
  const request = new Request("http://localhost/api/oauth/codex/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await route.POST(request);
  return { status: response.status, body: (await response.json()) as { error?: unknown } };
}

const ACCOUNTS_MESSAGE = "accounts must be an object or an array of objects";

test("import: `accounts` of the wrong type answers 400 with the schema message", async () => {
  const { status, body } = await postImport({ accounts: "not-an-object" });
  assert.equal(status, 400);
  assert.equal(body.error, ACCOUNTS_MESSAGE);
});

test("import: a missing `accounts` field answers 400, not a handler crash", async () => {
  const { status, body } = await postImport({});
  assert.equal(status, 400);
  assert.equal(typeof body.error, "string");
  assert.ok((body.error as string).length > 0);
});

test("import: `accounts` as a number answers 400 with the schema message", async () => {
  const { status, body } = await postImport({ accounts: 42 });
  assert.equal(status, 400);
  assert.equal(body.error, ACCOUNTS_MESSAGE);
});
