/**
 * Live routing decisions for the `auto` combo strategy.
 *
 * The scoring engine's pick is recorded as a `RoutingDecision` (candidates, scores, exclusion
 * reasons, policy version) under the request id, so a live request can be explained after it ran.
 * On the scoring-engine ("rules") path the failover chain is kept inside the request cost budget:
 * the budget cap applied to the first pick also applies to every later attempt. Explicit router
 * strategies ignore the budget cap, as they did before decisions were recorded.
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
  summarizeRoutingDecision,
} from "../autoCombo/routingDecision.ts";
import {
  MAX_CANDIDATES_WITH_FACTORS,
  MAX_STORED_CANDIDATES,
  recordRoutingDecision,
} from "../routing/decisionStore.ts";
import type { ComboLogger } from "./types.ts";

export interface AutoDecisionContext {
  config: AutoComboConfig;
  /** Every built candidate, including the ones a quota cutoff blocked. */
  candidates: DecisionCandidateInput[];
  /** The candidates the engine may pick from. */
  routableCandidates: DecisionCandidateInput[];
  taskType: string;
  body: Record<string, unknown>;
}

/**
 * Log a recorded decision. The decision id and policy version are always logged at debug level;
 * with OMNIROUTE_ROUTING_DIAGNOSTICS=1 the counts summary (candidates, eligibility, exclusion
 * reasons) is logged at info level. Neither carries prompts, credentials or connection ids.
 */
export function logRoutingDecision(log: ComboLogger, decision: RoutingDecision): void {
  log.debug?.(
    "COMBO",
    `Routing decision ${decision.decisionId} policy=${decision.policyVersion} request=${decision.requestId || "-"}`
  );
  if (process.env.OMNIROUTE_ROUTING_DIAGNOSTICS !== "1") return;
  log.info("COMBO", "Routing decision diagnostics", summarizeRoutingDecision(decision));
}

function requestProtocol(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) return "messages";
  return body.input !== undefined ? "responses" : "unknown";
}

/**
 * Live recording builds the decision already in the shape the store retains, instead of
 * materialising every candidate with every factor and letting the store drop the rest: an auto
 * combo over the whole catalog considers hundreds of candidates, and the factor breakdown of the
 * ones that are never retained is pure waste on every routed request. The bounds are the store's
 * own, so the stored decision is identical either way.
 */
const LIVE_DECISION_RETENTION = {
  maxCandidates: MAX_STORED_CANDIDATES,
  maxCandidatesWithFactors: MAX_CANDIDATES_WITH_FACTORS,
} as const;

function recordDecision(
  context: AutoDecisionContext,
  selection: Pick<BuildRoutingDecisionInput, "outcome" | "budgetExceeded" | "strategySelection">
): RoutingDecision {
  const decision = buildRoutingDecision({
    retention: LIVE_DECISION_RETENTION,
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
 * Keep the failover chain of a scoring-engine ("rules") selection inside the request cost budget.
 * The estimate is per attempt (1K tokens at the candidate's price), not cumulative spend. With
 * `budgetFallback: "strict"`,
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
