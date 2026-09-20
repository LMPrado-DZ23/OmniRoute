/**
 * Workspace / project budget roll-up (docs/architecture/WORKSPACES_RBAC.md, section 3.4).
 *
 * Roll-up rule
 *   spend(project, window)   = sum of spend(key, window) over the keys assigned to the project
 *   spend(workspace, window) = sum of spend(key, window) over the keys of all its projects
 * where spend(key, window) is the SAME ledger the per-key budget reads (`domain_cost_history`
 * plus the not-yet-flushed spend batch). Keys with no project never count anywhere. Each
 * level uses its own interval (daily / weekly / monthly, UTC, reset 00:00), so the windows of
 * a project and its workspace may differ.
 *
 * Enforcement order: key -> project -> workspace, most specific first; the first `deny` wins.
 * A level denies when its rolled-up spend is AT OR ABOVE its limit (`evaluateBudget`). So a
 * key with budget left is still refused once its project or workspace is exhausted: a child
 * can never spend past its parent. A threshold alert (`budget.threshold_reached`) fires once
 * per level and budget period, for every level at or above its warning threshold.
 *
 * A key with no project (every key that existed before migration 178) skips all of this.
 */
import { getBudgetWindow } from "@/domain/costRules";
import {
  claimWarningPeriod,
  getKeyHierarchy,
  listProjectApiKeyIds,
  listWorkspaceApiKeyIds,
  type HierarchyBudget,
} from "@/lib/db/workspaces";
import { loadCostTotalForKeys } from "@/lib/db/domainState";
import { spendBatchWriter } from "@/lib/spend/batchWriter";
import { notifyHierarchyBudgetThresholdReached } from "@/lib/usage/budgetAlerts";
import {
  evaluateBudget,
  type BudgetDecision,
  type InternalBudgetLimit,
} from "@/lib/usage/budgetGuard";

export type HierarchyLevel = "project" | "workspace";

export interface LevelInput {
  level: HierarchyLevel;
  id: string;
  budget: HierarchyBudget;
  spendUsd: number;
}

export interface LevelEvaluation {
  level: HierarchyLevel;
  id: string;
  decision: BudgetDecision;
  spendUsd: number;
  limitUsd: number | null;
  remainingUsd: number | null;
  reason: string;
}

export interface HierarchyVerdict {
  allowed: boolean;
  /** The level that denied, `null` when allowed. */
  deniedBy: HierarchyLevel | null;
  reason: string | null;
  levels: LevelEvaluation[];
}

/**
 * Sum of the per-key ledger over `apiKeyIds` since `sinceMs`.
 *
 * The committed half is ONE query for the whole set rather than one per key. This runs on
 * every request that carries a project-scoped key, and the per-key shape meant a workspace
 * with 100 keys cost 100 round-trips through `prepare()` to answer a single budget
 * question. The pending half still walks the in-memory write buffer, which is a JS loop
 * over unflushed entries and never touches SQLite.
 *
 * `spendOf` stays for the tests that inject a counting stub: passing it keeps the old
 * per-key path, so a caller that wants to observe each lookup still can.
 */
export function rollUpSpend(
  apiKeyIds: readonly string[],
  sinceMs: number,
  spendOf?: (apiKeyId: string, sinceMs: number) => number
): number {
  if (spendOf) {
    return apiKeyIds.reduce((total, apiKeyId) => total + spendOf(apiKeyId, sinceMs), 0);
  }
  const committed = loadCostTotalForKeys(apiKeyIds, sinceMs);
  const pending = apiKeyIds.reduce(
    (total, apiKeyId) => total + spendBatchWriter.getPendingCostTotal(apiKeyId, sinceMs),
    0
  );
  return committed + pending;
}

export function toInternalLimit(
  level: HierarchyLevel,
  id: string,
  budget: HierarchyBudget
): InternalBudgetLimit | undefined {
  if (budget.limitUsd === null) return undefined;
  return {
    id: `${level}:${id}`,
    scope: level,
    ...(level === "project" ? { projectId: id } : { workspaceId: id }),
    period: budget.interval,
    limitType: "currency",
    limitValue: budget.limitUsd,
    warningThreshold: budget.warningThreshold,
    enabled: true,
  };
}

function levelLabel(level: HierarchyLevel): string {
  return level === "project" ? "Project" : "Workspace";
}

/** Evaluate every level in order (project, then workspace). Pure. */
export function evaluateHierarchy(levels: readonly LevelInput[]): HierarchyVerdict {
  const evaluations = levels.map((input): LevelEvaluation => {
    const limit = toInternalLimit(input.level, input.id, input.budget);
    const result = evaluateBudget(limit, {
      currency: input.spendUsd,
      tokens: 0,
      requests: 0,
    });
    return {
      level: input.level,
      id: input.id,
      decision: result.decision,
      spendUsd: input.spendUsd,
      limitUsd: input.budget.limitUsd,
      remainingUsd: limit ? (result.remaining ?? 0) : null,
      reason: result.reason,
    };
  });
  const denied = evaluations.find((evaluation) => evaluation.decision === "deny");
  if (!denied) return { allowed: true, deniedBy: null, reason: null, levels: evaluations };
  return {
    allowed: false,
    deniedBy: denied.level,
    reason: `${levelLabel(denied.level)} ${denied.reason.charAt(0).toLowerCase()}${denied.reason.slice(1)} ($${denied.spendUsd.toFixed(4)} / $${(denied.limitUsd ?? 0).toFixed(2)})`,
    levels: evaluations,
  };
}

/**
 * Configuration rule for "a child larger than its parent": a project limit may not exceed
 * its workspace limit when both are set on the same interval (the extra room could never be
 * spent). Different intervals are not comparable and are allowed; the runtime roll-up still
 * caps the child at its parent.
 */
export function childBudgetExceedsParent(child: HierarchyBudget, parent: HierarchyBudget): boolean {
  return (
    child.limitUsd !== null &&
    parent.limitUsd !== null &&
    child.interval === parent.interval &&
    child.limitUsd > parent.limitUsd
  );
}

interface LevelSnapshot extends LevelInput {
  periodStartAt: number;
  nextResetAt: number;
  workspaceId: string;
}

function snapshotLevel(
  level: HierarchyLevel,
  id: string,
  workspaceId: string,
  budget: HierarchyBudget,
  now: number
): LevelSnapshot {
  const window = getBudgetWindow(budget.interval, "00:00", now);
  const keys = level === "project" ? listProjectApiKeyIds(id) : listWorkspaceApiKeyIds(id);
  return {
    level,
    id,
    workspaceId,
    budget,
    spendUsd: budget.limitUsd === null ? 0 : rollUpSpend(keys, window.periodStartAt),
    periodStartAt: window.periodStartAt,
    nextResetAt: window.nextResetAt,
  };
}

/** Current spend and verdict for one project and its workspace. */
export function snapshotHierarchy(
  projectId: string,
  projectBudget: HierarchyBudget,
  workspaceId: string,
  workspaceBudget: HierarchyBudget,
  now = Date.now()
): LevelSnapshot[] {
  return [
    snapshotLevel("project", projectId, workspaceId, projectBudget, now),
    snapshotLevel("workspace", workspaceId, workspaceId, workspaceBudget, now),
  ];
}

/** Spend of one level in its current window, with the evaluation. For the management API. */
export function describeLevel(
  level: HierarchyLevel,
  id: string,
  budget: HierarchyBudget,
  now = Date.now()
): LevelEvaluation & { periodStartAt: number; nextResetAt: number } {
  const window = getBudgetWindow(budget.interval, "00:00", now);
  const keys = level === "project" ? listProjectApiKeyIds(id) : listWorkspaceApiKeyIds(id);
  const spendUsd = rollUpSpend(keys, window.periodStartAt);
  const [evaluation] = evaluateHierarchy([{ level, id, budget, spendUsd }]).levels;
  return { ...evaluation, periodStartAt: window.periodStartAt, nextResetAt: window.nextResetAt };
}

function alertCrossedLevels(snapshots: readonly LevelSnapshot[], verdict: HierarchyVerdict): void {
  verdict.levels.forEach((evaluation, index) => {
    if (evaluation.decision === "allow" || evaluation.limitUsd === null) return;
    const snapshot = snapshots[index];
    const table = snapshot.level === "project" ? "projects" : "workspaces";
    if (!claimWarningPeriod(table, snapshot.id, snapshot.periodStartAt)) return;
    notifyHierarchyBudgetThresholdReached({
      level: snapshot.level,
      id: snapshot.id,
      workspaceId: snapshot.workspaceId,
      resetInterval: snapshot.budget.interval,
      spendUsd: snapshot.spendUsd,
      limitUsd: evaluation.limitUsd,
      warningThreshold: snapshot.budget.warningThreshold,
      nextResetAt: snapshot.nextResetAt,
    });
  });
}

/**
 * Enforce the project and workspace budgets for a request made with `apiKeyId`. Runs AFTER
 * the per-key `checkBudget` (the most specific level). A key with no project is allowed
 * without any further read.
 */
export function checkHierarchyBudget(apiKeyId: string, now = Date.now()): HierarchyVerdict {
  const hierarchy = getKeyHierarchy(apiKeyId);
  if (!hierarchy) return { allowed: true, deniedBy: null, reason: null, levels: [] };
  const snapshots = snapshotHierarchy(
    hierarchy.project.id,
    hierarchy.project.budget,
    hierarchy.workspace.id,
    hierarchy.workspace.budget,
    now
  );
  const verdict = evaluateHierarchy(snapshots);
  alertCrossedLevels(snapshots, verdict);
  return verdict;
}
