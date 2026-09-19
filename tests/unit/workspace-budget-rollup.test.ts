/**
 * Workspace -> project -> key budget roll-up (src/lib/usage/workspaceBudgets.ts).
 *
 *   - spend(project)   = sum of its keys' spend; spend(workspace) = sum over all its projects;
 *   - a level denies at or above its limit; order is key -> project -> workspace, first deny
 *     wins, so a key with budget left is refused once its project or workspace is exhausted;
 *   - the threshold alert is claimed once per level and budget period;
 *   - a project limit above its workspace limit on the same interval is a config error.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-workspace-rollup-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "workspace-rollup-api-key-secret";
process.env.APP_LOG_TO_FILE = "false";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const workspacesDb = await import("../../src/lib/db/workspaces.ts");
const costRules = await import("../../src/domain/costRules.ts");
const policyEngine = await import("../../src/domain/policyEngine.ts");
const rollup = await import("../../src/lib/usage/workspaceBudgets.ts");
// After every import: open-sse's proxyFetch replaces globalThis.fetch at import time.
const { blockOutboundFetch } = await import("./_helpers/blockOutboundFetch.ts");
const network = blockOutboundFetch();

type Budget = {
  limitUsd: number | null;
  interval: "daily" | "weekly" | "monthly";
  warningThreshold: number;
};

const monthly = (limitUsd: number | null): Budget => ({
  limitUsd,
  interval: "monthly",
  warningThreshold: 0.8,
});

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

// ── Pure rules ────────────────────────────────────────────────────────────────

test("rollUpSpend sums every key's spend in the window and nothing else", () => {
  const ledger: Record<string, number> = { a: 1.25, b: 2.5, c: 100 };
  const seen: number[] = [];
  const total = rollup.rollUpSpend(["a", "b"], 42, (id, since) => {
    seen.push(since);
    return ledger[id];
  });
  assert.equal(total, 3.75);
  assert.deepEqual(seen, [42, 42]);
  assert.equal(
    rollup.rollUpSpend([], 0, () => 1),
    0
  );
});

test("evaluateHierarchy: a level denies AT its limit, warns at the threshold, allows below", () => {
  const at = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(10), spendUsd: 10 },
  ]);
  assert.equal(at.allowed, false);
  assert.equal(at.deniedBy, "project");
  assert.match(at.reason ?? "", /^Project internal budget exhausted/);

  const warn = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(10), spendUsd: 8 },
  ]);
  assert.equal(warn.allowed, true);
  assert.equal(warn.levels[0].decision, "warn");
  assert.equal(warn.levels[0].remainingUsd, 2);

  const below = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(10), spendUsd: 7.99 },
  ]);
  assert.equal(below.levels[0].decision, "allow");
});

test("evaluateHierarchy: no budget at a level never denies and reports no remaining", () => {
  const verdict = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(null), spendUsd: 1_000_000 },
    { level: "workspace", id: "w", budget: monthly(null), spendUsd: 1_000_000 },
  ]);
  assert.equal(verdict.allowed, true);
  assert.deepEqual(
    verdict.levels.map((l) => [l.decision, l.remainingUsd]),
    [
      ["allow", null],
      ["allow", null],
    ]
  );
});

test("evaluateHierarchy: most specific first — the project wins when both levels deny", () => {
  const both = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(5), spendUsd: 6 },
    { level: "workspace", id: "w", budget: monthly(5), spendUsd: 6 },
  ]);
  assert.equal(both.deniedBy, "project");
  const parentOnly = rollup.evaluateHierarchy([
    { level: "project", id: "p", budget: monthly(50), spendUsd: 6 },
    { level: "workspace", id: "w", budget: monthly(5), spendUsd: 6 },
  ]);
  assert.equal(parentOnly.allowed, false);
  assert.equal(parentOnly.deniedBy, "workspace");
  assert.match(parentOnly.reason ?? "", /^Workspace internal budget exhausted/);
});

test("toInternalLimit maps a level onto the budgetGuard model with the new scopes", () => {
  assert.equal(rollup.toInternalLimit("project", "p1", monthly(null)), undefined);
  assert.deepEqual(rollup.toInternalLimit("workspace", "w1", monthly(20)), {
    id: "workspace:w1",
    scope: "workspace",
    workspaceId: "w1",
    period: "monthly",
    limitType: "currency",
    limitValue: 20,
    warningThreshold: 0.8,
    enabled: true,
  });
  assert.equal(rollup.toInternalLimit("project", "p1", monthly(3))?.projectId, "p1");
});

test("childBudgetExceedsParent: only a larger limit on the SAME interval is a config error", () => {
  assert.equal(rollup.childBudgetExceedsParent(monthly(11), monthly(10)), true);
  assert.equal(rollup.childBudgetExceedsParent(monthly(10), monthly(10)), false);
  assert.equal(rollup.childBudgetExceedsParent(monthly(null), monthly(10)), false);
  assert.equal(rollup.childBudgetExceedsParent(monthly(11), monthly(null)), false);
  assert.equal(
    rollup.childBudgetExceedsParent({ ...monthly(50), interval: "daily" }, monthly(10)),
    false,
    "different intervals are not comparable; the runtime roll-up still caps the child"
  );
});

// ── Against the migrated database ─────────────────────────────────────────────

async function key(name: string): Promise<string> {
  return (await apiKeysDb.createApiKey(name, "machine-rollup-01", [])).id;
}

test("roll-up against the ledger: project = sum of its keys, workspace = sum of its projects", async () => {
  const workspace = workspacesDb.createWorkspace(
    { name: "rollup-sum", budget: monthly(100) },
    "owner",
    null
  );
  const alpha = workspacesDb.createProject(workspace.id, { name: "alpha", budget: monthly(60) });
  const beta = workspacesDb.createProject(workspace.id, { name: "beta", budget: monthly(60) });
  const [k1, k2, k3, loose] = [await key("r1"), await key("r2"), await key("r3"), await key("r4")];
  workspacesDb.setProjectApiKeys(alpha.id, [k1, k2]);
  workspacesDb.setProjectApiKeys(beta.id, [k3]);
  costRules.recordCost(k1, 1.5);
  costRules.recordCost(k2, 2.25);
  costRules.recordCost(k3, 4);
  costRules.recordCost(loose, 50); // no project: never rolls up anywhere

  assert.equal(rollup.describeLevel("project", alpha.id, alpha.budget).spendUsd, 3.75);
  assert.equal(rollup.describeLevel("project", beta.id, beta.budget).spendUsd, 4);
  assert.equal(rollup.describeLevel("workspace", workspace.id, workspace.budget).spendUsd, 7.75);

  const verdict = rollup.checkHierarchyBudget(k1);
  assert.equal(verdict.allowed, true);
  assert.deepEqual(
    verdict.levels.map((l) => [l.level, l.spendUsd]),
    [
      ["project", 3.75],
      ["workspace", 7.75],
    ]
  );
});

test("a key with budget left is refused once its WORKSPACE is exhausted by a sibling project", async () => {
  const workspace = workspacesDb.createWorkspace(
    { name: "rollup-parent", budget: monthly(10) },
    "owner",
    null
  );
  const small = workspacesDb.createProject(workspace.id, { name: "small", budget: monthly(8) });
  const heavy = workspacesDb.createProject(workspace.id, { name: "heavy", budget: monthly(10) });
  const light = await key("light");
  const hog = await key("hog");
  workspacesDb.setProjectApiKeys(small.id, [light]);
  workspacesDb.setProjectApiKeys(heavy.id, [hog]);
  costRules.setBudget(light, { monthlyLimitUsd: 100, resetInterval: "monthly" });

  costRules.recordCost(light, 1);
  costRules.recordCost(hog, 8.99);
  assert.equal(
    rollup.checkHierarchyBudget(light).allowed,
    true,
    "9.99 < 10: still under the parent"
  );

  costRules.recordCost(hog, 0.01);
  assert.equal(costRules.checkBudget(light).allowed, true, "the key's own budget is untouched");
  const verdict = rollup.checkHierarchyBudget(light);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.deniedBy, "workspace");
  assert.equal(verdict.levels[0].decision, "allow", "its project (1 / 8) is fine");

  const policy = policyEngine.evaluateRequest({ model: "gpt-4o-mini", apiKeyId: light });
  assert.equal(policy.allowed, false);
  assert.equal(policy.policyPhase, "budget");
  assert.match(policy.reason ?? "", /Workspace internal budget exhausted/);
});

test("order key -> project -> workspace: the key's own budget is checked first", async () => {
  const workspace = workspacesDb.createWorkspace(
    { name: "rollup-order", budget: monthly(1) },
    "owner",
    null
  );
  const project = workspacesDb.createProject(workspace.id, { name: "p", budget: monthly(1) });
  const k = await key("order");
  workspacesDb.setProjectApiKeys(project.id, [k]);
  costRules.setBudget(k, { dailyLimitUsd: 0.5, resetInterval: "daily" });
  costRules.recordCost(k, 2);

  const policy = policyEngine.evaluateRequest({ model: "gpt-4o-mini", apiKeyId: k });
  assert.equal(policy.allowed, false);
  assert.match(
    policy.reason ?? "",
    /Daily budget exceeded/,
    "key level answers before the project"
  );
  assert.equal(rollup.checkHierarchyBudget(k).deniedBy, "project", "then project before workspace");
});

test("the threshold alert is claimed once per level and period, and re-armed by a budget change", async () => {
  const workspace = workspacesDb.createWorkspace(
    { name: "rollup-alert", budget: monthly(10) },
    "owner",
    null
  );
  const project = workspacesDb.createProject(workspace.id, { name: "p", budget: monthly(10) });
  const k = await key("alert");
  workspacesDb.setProjectApiKeys(project.id, [k]);
  costRules.recordCost(k, 8.5); // 85% of both levels: warn

  assert.equal(workspacesDb.readWarningPeriod("projects", project.id), null);
  const verdict = rollup.checkHierarchyBudget(k);
  assert.equal(verdict.allowed, true);
  const period = workspacesDb.readWarningPeriod("projects", project.id);
  assert.equal(typeof period, "number");
  assert.equal(workspacesDb.readWarningPeriod("workspaces", workspace.id), period);
  assert.equal(workspacesDb.claimWarningPeriod("projects", project.id, period as number), false);

  workspacesDb.updateProject(workspace.id, project.id, { budget: { limitUsd: 9 } });
  assert.equal(workspacesDb.readWarningPeriod("projects", project.id), null, "new budget re-arms");
  assert.equal(workspacesDb.readWarningPeriod("workspaces", workspace.id), period);
});

test("a key with no project skips the hierarchy entirely", async () => {
  const k = await key("loose-only");
  costRules.recordCost(k, 1_000);
  assert.deepEqual(rollup.checkHierarchyBudget(k), {
    allowed: true,
    deniedBy: null,
    reason: null,
    levels: [],
  });
});

test("no outbound network request was attempted", () => {
  assert.deepEqual(network.attempts, []);
});
