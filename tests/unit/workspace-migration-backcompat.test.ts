/**
 * Migration 178 (workspaces / projects / members, nullable api_keys.project_id) and the
 * backwards-compatibility guarantee: an installation with no workspace behaves exactly as
 * before.
 *
 *   1. Fresh install: the runner applies 178 and every object it declares exists.
 *   2. Upgrade from the previous schema (177): this database is first put back to the exact
 *      pre-178 shape (178's objects removed, its ledger row deleted), seeded with keys,
 *      budgets and spend, then migrated. Existing rows are byte-for-byte unchanged apart from
 *      the new NULL column, and a second run applies nothing.
 *   3. The EXISTING per-key budget behaviour (checkBudget / policy engine) is exercised
 *      against the migrated schema with no workspace configured and must match the pre-178
 *      contract: allowed under the limit, warning at the threshold, denied strictly above.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-workspace-migration-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "workspace-migration-api-key-secret";
process.env.APP_LOG_TO_FILE = "false";

const core = await import("../../src/lib/db/core.ts");
const runner = await import("../../src/lib/db/migrationRunner.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const costRules = await import("../../src/domain/costRules.ts");
const policyEngine = await import("../../src/domain/policyEngine.ts");
const rollup = await import("../../src/lib/usage/workspaceBudgets.ts");
// After every import: open-sse's proxyFetch replaces globalThis.fetch at import time.
const { blockOutboundFetch } = await import("./_helpers/blockOutboundFetch.ts");
const network = blockOutboundFetch();

const MIGRATION_TABLES = ["workspaces", "projects", "workspace_members"];
const MIGRATION_INDEXES = [
  "idx_workspaces_name",
  "idx_projects_workspace_name",
  "idx_workspace_members_principal",
  "idx_api_keys_project_id",
];

function db() {
  return core.getDbInstance();
}

function objectExists(type: "table" | "index", name: string): boolean {
  return Boolean(
    db().prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name)
  );
}

function apiKeyColumns(): string[] {
  return (db().prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

function ledgerHas(version: string): boolean {
  return Boolean(
    db().prepare("SELECT 1 FROM _omniroute_migrations WHERE version = ?").get(version)
  );
}

/** Put this throwaway database back to the pre-178 schema (test fixture, never a migration). */
function rewindTo177(): void {
  for (const index of MIGRATION_INDEXES) db().exec(`DROP INDEX IF EXISTS ${index}`);
  db().exec("ALTER TABLE api_keys DROP COLUMN project_id");
  for (const table of MIGRATION_TABLES) db().exec(`DROP TABLE IF EXISTS ${table}`);
  db().prepare("DELETE FROM _omniroute_migrations WHERE version = '178'").run();
}

test.before(() => {
  assert.ok(network.isLive(), "the throwing fetch stub must be the live globalThis.fetch");
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
});

test.after(() => {
  costRules.resetCostData();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("fresh install: migration 178 is applied and declares only additive objects", () => {
  assert.equal(ledgerHas("178"), true);
  for (const table of MIGRATION_TABLES) assert.equal(objectExists("table", table), true, table);
  for (const index of MIGRATION_INDEXES) assert.equal(objectExists("index", index), true, index);
  assert.ok(apiKeyColumns().includes("project_id"));
  const file = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/migrations/178_workspaces_projects.sql"),
    "utf8"
  );
  const statements = file.replace(/--.*$/gm, "").toUpperCase();
  assert.doesNotMatch(statements, /\b(DROP|TRUNCATE|DELETE|UPDATE|RENAME)\b/);
  assert.doesNotMatch(statements, /ALTER\s+TABLE\s+\w+\s+(?!ADD\s+COLUMN)/);
});

test("upgrade from the previous schema: rows are preserved, the new column is NULL, rerun is a no-op", async () => {
  const before = await apiKeysDb.createApiKey("pre-178-key", "machine-migration-01", ["manage"]);
  costRules.setBudget(before.id, { dailyLimitUsd: 3, resetInterval: "daily" });
  costRules.recordCost(before.id, 1.25);
  rewindTo177();
  assert.equal(apiKeyColumns().includes("project_id"), false);
  assert.equal(objectExists("table", "workspaces"), false);

  const snapshot = JSON.stringify(db().prepare("SELECT * FROM api_keys ORDER BY id").all());
  const budgetRows = JSON.stringify(db().prepare("SELECT * FROM domain_budgets ORDER BY 1").all());

  const applied = runner.runMigrations(db());
  assert.equal(applied, 1, "exactly one pending migration: 178");
  assert.equal(ledgerHas("178"), true);
  for (const table of MIGRATION_TABLES) assert.equal(objectExists("table", table), true, table);

  const rows = db().prepare("SELECT * FROM api_keys ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
  assert.ok(rows.every((row) => row.project_id === null));
  const withoutNewColumn = rows.map(({ project_id: _projectId, ...rest }) => rest);
  assert.equal(JSON.stringify(withoutNewColumn), snapshot, "existing api_keys rows unchanged");
  assert.equal(
    JSON.stringify(db().prepare("SELECT * FROM domain_budgets ORDER BY 1").all()),
    budgetRows,
    "existing budgets unchanged"
  );
  assert.equal(runner.runMigrations(db()), 0, "idempotent");
});

test("existing per-key budget behaviour is unchanged on the migrated schema with no workspace", async () => {
  costRules.resetCostData();
  const k = await apiKeysDb.createApiKey("compat-key", "machine-migration-01", []);
  costRules.setBudget(k.id, { dailyLimitUsd: 10, warningThreshold: 0.8, resetInterval: "daily" });

  const expectations: Array<[number, boolean, boolean]> = [
    // [cumulative spend, allowed, warningReached] — the pre-178 contract of checkBudget
    [5, true, false],
    [8, true, true],
    [10, true, true], // exactly at the limit: still allowed (checkBudget denies strictly above)
    [10.01, false, true],
  ];
  let spent = 0;
  for (const [target, allowed, warning] of expectations) {
    costRules.recordCost(k.id, target - spent);
    spent = target;
    const own = costRules.checkBudget(k.id);
    assert.equal(own.allowed, allowed, `checkBudget at $${target}`);
    assert.equal(own.warningReached, warning, `warning at $${target}`);
    assert.deepEqual(rollup.checkHierarchyBudget(k.id).levels, [], "no hierarchy for this key");
    const policy = policyEngine.evaluateRequest({ model: "gpt-4o-mini", apiKeyId: k.id });
    assert.equal(policy.allowed, allowed, `policy engine at $${target}`);
    if (!allowed) assert.match(policy.reason ?? "", /^Budget exceeded: Daily budget exceeded/);
  }

  const unbudgeted = await apiKeysDb.createApiKey("compat-unbudgeted", "machine-migration-01", []);
  costRules.recordCost(unbudgeted.id, 999);
  assert.equal(costRules.checkBudget(unbudgeted.id).allowed, true);
  assert.equal(policyEngine.evaluateRequest({ model: "m", apiKeyId: unbudgeted.id }).allowed, true);
});

test("no outbound network request was attempted", () => {
  assert.deepEqual(network.attempts, []);
});
