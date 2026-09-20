import type { BudgetResetInterval } from "@/domain/costRules";

/**
 * Budget alert fan-out for the INTERNAL per-API-key budget (`src/domain/costRules.ts`).
 *
 * Emitted once per budget period when projected spend crosses the configured warning
 * threshold (the de-duplication lives in `checkBudget` via `warningPeriodStart`). Delivered as
 * the `budget.threshold_reached` webhook event — deliberately distinct from `quota.exceeded`,
 * which is raised by quota-pool enforcement (`src/lib/quota/enforce.ts`), and from upstream
 * provider quota windows (`src/lib/quota/providerQuotaState.ts`), which OmniRoute only observes.
 *
 * The payload carries identifiers and amounts only (no key material). Delivery is
 * fire-and-forget: a webhook failure never affects the request that crossed the threshold.
 */
interface BudgetThresholdAlert {
  apiKeyId: string;
  resetInterval: BudgetResetInterval;
  projectedSpendUsd: number;
  limitUsd: number;
  warningThreshold: number;
  nextResetAt: number;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function notifyBudgetThresholdReached(alert: BudgetThresholdAlert): void {
  const data = {
    source: "internal_budget",
    apiKeyId: alert.apiKeyId,
    resetInterval: alert.resetInterval,
    projectedSpendUsd: roundTo(alert.projectedSpendUsd, 4),
    limitUsd: alert.limitUsd,
    percent: alert.limitUsd > 0 ? roundTo((alert.projectedSpendUsd / alert.limitUsd) * 100, 1) : 0,
    warningThreshold: alert.warningThreshold,
    nextResetAt: new Date(alert.nextResetAt).toISOString(),
  };
  void import("@/lib/webhookDispatcher")
    .then(({ notifyWebhookEvent }) => notifyWebhookEvent("budget.threshold_reached", data))
    .catch(() => {
      /* webhook delivery is best-effort */
    });
}

interface HierarchyBudgetThresholdAlert {
  level: "project" | "workspace";
  id: string;
  workspaceId: string;
  resetInterval: BudgetResetInterval;
  spendUsd: number;
  limitUsd: number;
  warningThreshold: number;
  nextResetAt: number;
}

/**
 * Same `budget.threshold_reached` event for a project or workspace budget
 * (`src/lib/usage/workspaceBudgets.ts`); `source` tells the levels apart. Once per level and
 * budget period, de-duplicated by `claimWarningPeriod`. Identifiers and amounts only.
 */
export function notifyHierarchyBudgetThresholdReached(alert: HierarchyBudgetThresholdAlert): void {
  const data = {
    source: `${alert.level}_budget`,
    ...(alert.level === "project" ? { projectId: alert.id } : {}),
    workspaceId: alert.workspaceId,
    resetInterval: alert.resetInterval,
    spendUsd: roundTo(alert.spendUsd, 4),
    limitUsd: alert.limitUsd,
    percent: alert.limitUsd > 0 ? roundTo((alert.spendUsd / alert.limitUsd) * 100, 1) : 0,
    warningThreshold: alert.warningThreshold,
    nextResetAt: new Date(alert.nextResetAt).toISOString(),
  };
  void import("@/lib/webhookDispatcher")
    .then(({ notifyWebhookEvent }) => notifyWebhookEvent("budget.threshold_reached", data))
    .catch(() => {
      /* webhook delivery is best-effort */
    });
}
