/**
 * Live routing decisions for the `auto` combo strategy.
 *
 * The scoring engine's pick is recorded as a `RoutingDecision` (candidates, scores, exclusion
 * reasons, policy version) under the request id, so a live request can be explained after it ran.
 * The failover chain is kept inside the request cost budget: the budget cap applied to the first
 * pick also applies to every later attempt.
 */
import type { RoutingDecision } from "@/shared/contracts/routing";
import { getRequestId } from "@/shared/utils/requestId";
import {
  BudgetExceededError,
  estimateAutoRequestCostUsd,
  previewSelectionDeps,
  selectProviderWithTrace,
  type AutoComboConfig,
  type SelectionResult,
} from "../autoCombo/engine.ts";
import {
  buildRoutingDecision,
  type BuildRoutingDecisionInput,
  type DecisionCandidateInput,
  type StrategySelection,
} from "../autoCombo/routingDecision.ts";
import { recordRoutingDecision } from "../routing/decisionStore.ts";

export interface AutoDecisionContext {
  config: AutoComboConfig;
  /** Every built candidate, including the ones a quota cutoff blocked. */
  candidates: DecisionCandidateInput[];
  /** The candidates the engine may pick from. */
  routableCandidates: DecisionCandidateInput[];
  taskType: string;
  body: Record<string, unknown>;
}

function requestProtocol(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) return "messages";
  return body.input !== undefined ? "responses" : "unknown";
}

function recordDecision(
  context: AutoDecisionContext,
  selection: Pick<BuildRoutingDecisionInput, "outcome" | "budgetExceeded" | "strategySelection">
): RoutingDecision {
  const decision = buildRoutingDecision({
    request: {
      requestId: getRequestId() ?? "",
      model: context.config.name,
      protocol: requestProtocol(context.body),
      stream: context.body.stream === true,
    },
    config: context.config,
    candidates: context.candidates,
    liveRequestExecuted: true,
    ...selection,
  });
  recordRoutingDecision(decision);
  return decision;
}

/**
 * Live scoring-engine selection plus its recorded decision. A strict budget cap that refuses
 * every candidate is returned as `budgetError` (the caller answers 402), still with a decision.
 */
export function selectAutoProviderWithDecision(
  context: AutoDecisionContext
):
  | { selection: SelectionResult; decision: RoutingDecision }
  | { budgetError: BudgetExceededError; decision: RoutingDecision } {
  try {
    const outcome = selectProviderWithTrace(
      context.config,
      context.routableCandidates,
      context.taskType
    );
    return { selection: outcome.selection, decision: recordDecision(context, { outcome }) };
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    return {
      budgetError: error,
      decision: recordDecision(context, { outcome: null, budgetExceeded: true }),
    };
  }
}

/**
 * Record the decision of an explicit router strategy (cost, latency, lkgp, ...). The candidates
 * are scored with preview deps, so explaining the choice does not advance rotation or change
 * self-healing state.
 */
export function recordExplicitStrategyDecision(
  context: AutoDecisionContext & { selection: StrategySelection }
): RoutingDecision {
  let outcome: BuildRoutingDecisionInput["outcome"] = null;
  try {
    outcome = selectProviderWithTrace(
      context.config,
      context.routableCandidates,
      context.taskType,
      undefined,
      previewSelectionDeps()
    );
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
  }
  const { strategy, provider, model, connectionId } = context.selection;
  return recordDecision(context, {
    outcome,
    strategySelection: { strategy, provider, model, connectionId },
  });
}

/**
 * Keep the failover chain inside the request cost budget. With `budgetFallback: "strict"`,
 * targets whose estimated request cost exceeds `budgetCap` are dropped (unless that would leave
 * nothing, in which case the engine has already refused the request); otherwise they move behind
 * the in-budget targets. Targets without a known price are treated as in budget.
 */
export function orderTargetsByCostBudget<T extends { executionKey: string }>(
  targets: T[],
  candidates: ReadonlyArray<{ executionKey: string; costPer1MTokens: number }>,
  budgetCap: number | null | undefined,
  budgetFallback: "cheapest" | "strict" | null | undefined
): T[] {
  if (!budgetCap) return targets;
  const costByKey = new Map(
    candidates.map((c) => [c.executionKey, estimateAutoRequestCostUsd(c.costPer1MTokens)])
  );
  const overBudget = (target: T) => (costByKey.get(target.executionKey) ?? 0) > budgetCap;
  const withinBudget = targets.filter((target) => !overBudget(target));
  if (budgetFallback === "strict") return withinBudget.length > 0 ? withinBudget : targets;
  return [...withinBudget, ...targets.filter(overBudget)];
}
