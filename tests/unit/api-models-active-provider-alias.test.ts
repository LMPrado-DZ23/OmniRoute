/**
 * /api/models (default path, no `all=true`) lists a static model only when an active
 * connection can serve it. Connections are stored under the provider id (`aimlapi`)
 * while static models are keyed by the provider alias (`aiml`), so the route registers
 * each connection under both keys. Connection rows reach the route as
 * Record<string, unknown>; the id/alias registration must keep working for the text
 * `provider` and `id` columns the database returns.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-models-alias-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/models/route.ts");

type ModelRow = { provider: string; model: string; fullModel: string; available: boolean };

beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({ hidePaidModels: false });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function fetchActiveModels(): Promise<ModelRow[]> {
  const res = await modelsRoute.GET(new Request("http://localhost/api/models"));
  assert.equal(res.status, 200);
  return ((await res.json()) as { models: ModelRow[] }).models;
}

const ALIAS_MODEL = "aiml/gpt-4o";

test("without a connection the default path leaves the alias-keyed model out", async () => {
  const models = await fetchActiveModels();
  assert.equal(
    models.some((m) => m.fullModel === ALIAS_MODEL),
    false
  );
});

test("an active connection stored under the provider id activates its alias-keyed models", async () => {
  await providersDb.createProviderConnection({
    provider: "aimlapi",
    authType: "apikey",
    name: "aimlapi-main",
    apiKey: "sk-test",
    isActive: true,
  });
  const row = (await fetchActiveModels()).find((m) => m.fullModel === ALIAS_MODEL);
  assert.ok(row, `${ALIAS_MODEL} must be listed once an aimlapi connection is active`);
  assert.equal(row.available, true);
});

test("an inactive connection does not activate the alias", async () => {
  await providersDb.createProviderConnection({
    provider: "aimlapi",
    authType: "apikey",
    name: "aimlapi-disabled",
    apiKey: "sk-test",
    isActive: false,
  });
  const models = await fetchActiveModels();
  assert.equal(
    models.some((m) => m.fullModel === ALIAS_MODEL),
    false
  );
});
