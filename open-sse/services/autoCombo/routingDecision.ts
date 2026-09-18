/**
 * Routing decisions for auto combos: the router contract in `@/shared/contracts/routing`.
 *
 * `previewRoutingDecision` answers "which provider would serve this request, and why" with the
 * selection code live traffic runs (`selectProviderWithTrace`), against copies of the live
 * self-healing and rotator state and with exploration off. A preview therefore never calls an
 * upstream provider and never changes routing state. `buildRoutingDecision` turns a selection,
 * live or preview, into a `RoutingDecision`.
 *
 * Decisions carry routing metadata only: no prompts, bodies, credentials or connection ids.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  RoutingCandidate,
  RoutingCircuitState,
  RoutingDecision,
  RoutingExclusionReason,
  RoutingFactor,
  RoutingQuotaState,
  RoutingRequest,
} from "@/shared/contracts/routing";
import type { ProviderCandidate, ScoredProvider, ScoringWeights } from "./scoring";
import {
  BudgetExceededError,
  describeRotation,
  estimateAutoRequestCostUsd,
  previewSelectionDeps,
  selectProviderWithTrace,
  type AutoComboConfig,
  type AutoSelectionTrace,
  type SelectionResult,
} from "./engine";

/** A scoring candidate plus the availability facts the engine does not score. */
export interface DecisionCandidateInput extends ProviderCandidate {
  /** Hard quota cutoff: the account must not be routed (live `quotaCutoffBlocked`). */
  quotaCutoffBlocked?: boolean;
  /** False when there is no quota signal; `quotaRemaining` is then only a neutral default. */
  quotaKnown?: boolean;
  /** False when the provider does not offer the model. */
  modelAvailable?: boolean;
  /** Capabilities the model supports (tools, vision, ...). Undeclared means not checked. */
  capabilities?: readonly string[];
}

export interface RoutingDecisionClock {
  now(): number;
  newDecisionId(): string;
}

const systemClock: RoutingDecisionClock = {
  now: () => Date.now(),
  newDecisionId: () => `rd_${randomUUID()}`,
};

/** Below this remaining percentage a known quota reads as "low". */
const LOW_QUOTA_PERCENT = 20;

/**
 * Content hash of every policy input that can change which candidate wins: the combo name (it
 * selects the rotation tier profile), candidate pool, weights, mode pack, budget, exploration
 * rate and router strategy. Two decisions with the same version ran under the same policy.
 */
export function computeRoutingPolicyVersion(config: AutoComboConfig): string {
  const weights = Object.entries(config.weights)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const policy = {
    name: config.name,
    candidatePool: [...config.candidatePool].sort(),
    weights,
    modePack: config.modePack ?? null,
    budgetCap: config.budgetCap ?? null,
    budgetFallback: config.budgetFallback ?? "cheapest",
    explorationRate: config.explorationRate,
    routerStrategy: config.routerStrategy ?? "rules",
  };
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return `rp_${digest.slice(0, 16)}`;
}

function missingCapability(candidate: DecisionCandidateInput, required?: string[]): boolean {
  const supported = candidate.capabilities;
  if (!required?.length || !supported) return false;
  return required.some((capability) => !supported.includes(capability));
}

/** Reasons a candidate cannot be routed at all, checked before the engine scores anything. */
export function hardExclusionReasons(
  candidate: DecisionCandidateInput,
  request: RoutingRequest
): RoutingExclusionReason[] {
  const reasons: RoutingExclusionReason[] = [];
  if (candidate.modelAvailable === false) reasons.push("model_not_found");
  if (missingCapability(candidate, request.capabilities)) reasons.push("capability_missing");
  if (candidate.quotaCutoffBlocked === true) reasons.push("quota_exhausted");
  const maxCost = request.budget?.maxCost;
  if (maxCost !== undefined && estimateAutoRequestCostUsd(candidate.costPer1MTokens) > maxCost) {
    reasons.push("cost_over_budget");
  }
  const maxLatencyMs = request.budget?.maxLatencyMs;
  if (maxLatencyMs !== undefined && candidate.p95LatencyMs > maxLatencyMs) {
    reasons.push("latency_over_budget");
  }
  return reasons;
}

function quotaStateOf(candidate: DecisionCandidateInput): RoutingQuotaState {
  if (candidate.quotaCutoffBlocked === true) return "exhausted";
  if (candidate.quotaKnown === false) return "unknown";
  if (candidate.quotaRemaining <= 0) return "exhausted";
  return candidate.quotaRemaining < LOW_QUOTA_PERCENT ? "low" : "available";
}

function circuitStateOf(candidate: ProviderCandidate): RoutingCircuitState {
  if (candidate.circuitBreakerState === "OPEN") return "open";
  return candidate.circuitBreakerState === "HALF_OPEN" ? "half_open" : "closed";
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function toRoutingFactors(
  scored: ScoredProvider | undefined,
  weights: ScoringWeights | undefined
): RoutingFactor[] {
  if (!scored || !weights) return [];
  const weightByName = new Map<string, number | undefined>(Object.entries(weights));
  return Object.entries(scored.factors)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => {
      const weight = weightByName.get(name) ?? 0;
      return { name, value: roundScore(value), weight, contribution: roundScore(value * weight) };
    });
}

function candidateKey(entry: { provider: string; model: string; connectionId?: string }): string {
  return `${entry.provider}\0${entry.model}\0${entry.connectionId ?? ""}`;
}

/** A selection already made by a router strategy other than the scoring engine. */
export interface StrategySelection {
  strategy: string;
  provider: string;
  model: string;
  connectionId?: string;
}

export interface BuildRoutingDecisionInput {
  request: RoutingRequest;
  config: AutoComboConfig;
  /** Every candidate the router considered, including the ones cut before scoring. */
  candidates: DecisionCandidateInput[];
  /** Engine run over the routable candidates; null when none was routable. */
  outcome: { selection: SelectionResult; trace: AutoSelectionTrace } | null;
  /** True when a strict budget cap refused every routable candidate. */
  budgetExceeded?: boolean;
  /** Overrides the engine's pick when an explicit router strategy chose the candidate. */
  strategySelection?: StrategySelection;
  liveRequestExecuted: boolean;
}

function engineExclusionReasons(
  candidate: DecisionCandidateInput,
  input: BuildRoutingDecisionInput,
  eligibleKeys: Set<string>
): RoutingExclusionReason[] {
  const hard = hardExclusionReasons(candidate, input.request);
  if (hard.length > 0) return hard;
  if (input.budgetExceeded) return ["cost_over_budget"];
  if (!input.outcome || eligibleKeys.has(candidateKey(candidate))) return [];
  return [input.outcome.trace.excludedProviders.get(candidate.provider) ?? "self_healing_excluded"];
}

function toRoutingCandidate(
  candidate: DecisionCandidateInput,
  input: BuildRoutingDecisionInput,
  scoredByKey: Map<string, ScoredProvider>,
  eligibleKeys: Set<string>
): RoutingCandidate {
  const scored = scoredByKey.get(candidateKey(candidate));
  const exclusionReasons = engineExclusionReasons(candidate, input, eligibleKeys);
  return {
    providerId: candidate.provider,
    modelId: candidate.model,
    score: roundScore(scored?.score ?? 0),
    factors: toRoutingFactors(scored, input.outcome?.trace.weights),
    eligible: exclusionReasons.length === 0 && input.outcome !== null,
    exclusionReasons,
    quota: quotaStateOf(candidate),
    circuit: circuitStateOf(candidate),
    estimatedCostUsd: Number.isFinite(candidate.costPer1MTokens)
      ? roundScore(estimateAutoRequestCostUsd(candidate.costPer1MTokens))
      : null,
    estimatedLatencyMs: Number.isFinite(candidate.p95LatencyMs) ? candidate.p95LatencyMs : null,
  };
}

function selectionModeOf(input: BuildRoutingDecisionInput): RoutingDecision["selectionMode"] {
  if (!input.outcome || input.strategySelection || input.budgetExceeded) return undefined;
  if (input.outcome.selection.isExploration) return "exploration";
  return describeRotation(input.outcome.trace.eligible);
}

interface DecisionEntry {
  key: string;
  candidate: DecisionCandidateInput;
  routing: RoutingCandidate;
}

function isStrategyPick(candidate: DecisionCandidateInput, pick: StrategySelection): boolean {
  if (candidate.provider !== pick.provider || candidate.model !== pick.model) return false;
  return !pick.connectionId || (candidate.connectionId ?? "") === pick.connectionId;
}

/**
 * The candidate an explicit router strategy picked. The strategy chooses among the routable
 * candidates on its own rules, so the scoring pass run only to explain the decision does not get
 * to exclude its pick: a pick without a hard exclusion is reported eligible. A pick without a
 * connection id matches the best-ranked candidate with its provider and model.
 */
function strategyPickEntry(
  entries: DecisionEntry[],
  input: BuildRoutingDecisionInput,
  pick: StrategySelection
): DecisionEntry | undefined {
  const entry = entries.find(
    (candidateEntry) =>
      isStrategyPick(candidateEntry.candidate, pick) &&
      hardExclusionReasons(candidateEntry.candidate, input.request).length === 0
  );
  if (entry && !entry.routing.eligible) {
    entry.routing = { ...entry.routing, eligible: true, exclusionReasons: [] };
  }
  return entry;
}

function selectedEntry(
  entries: DecisionEntry[],
  input: BuildRoutingDecisionInput
): DecisionEntry | undefined {
  if (input.budgetExceeded) return undefined;
  if (input.strategySelection) return strategyPickEntry(entries, input, input.strategySelection);
  const chosen = input.outcome?.selection;
  if (!chosen) return undefined;
  return entries.find((entry) => entry.key === candidateKey(chosen) && entry.routing.eligible);
}

/** Turn a selection into the shared decision contract. Pure apart from the clock. */
export function buildRoutingDecision(
  input: BuildRoutingDecisionInput,
  clock: RoutingDecisionClock = systemClock
): RoutingDecision {
  const scoredByKey = new Map<string, ScoredProvider>();
  for (const scored of input.outcome?.trace.scored ?? []) {
    if (!scoredByKey.has(candidateKey(scored))) scoredByKey.set(candidateKey(scored), scored);
  }
  const eligibleKeys = new Set((input.outcome?.trace.eligible ?? []).map(candidateKey));
  const entries: DecisionEntry[] = input.candidates.map((candidate) => ({
    key: candidateKey(candidate),
    candidate,
    routing: toRoutingCandidate(candidate, input, scoredByKey, eligibleKeys),
  }));
  entries.sort(
    (a, b) =>
      Number(b.routing.eligible) - Number(a.routing.eligible) || b.routing.score - a.routing.score
  );
  const selected = selectedEntry(entries, input);
  return {
    decisionId: clock.newDecisionId(),
    requestId: input.request.requestId,
    ...(selected ? { selected: selected.routing } : {}),
    candidates: entries.map((entry) => entry.routing),
    policyVersion: computeRoutingPolicyVersion(input.config),
    generatedAt: new Date(clock.now()).toISOString(),
    liveRequestExecuted: input.liveRequestExecuted,
    selectionMode: selectionModeOf(input),
    strategy: input.strategySelection?.strategy ?? "rules",
  };
}

export interface PreviewRoutingDecisionInput {
  request: RoutingRequest;
  config: AutoComboConfig;
  candidates: DecisionCandidateInput[];
  taskType?: string;
}

/**
 * What the live router would decide for these candidates right now, without calling any provider
 * and without changing self-healing, rotation or circuit state.
 */
export function previewRoutingDecision(
  input: PreviewRoutingDecisionInput,
  clock: RoutingDecisionClock = systemClock
): RoutingDecision {
  const routable = input.candidates.filter(
    (candidate) => hardExclusionReasons(candidate, input.request).length === 0
  );
  let outcome: BuildRoutingDecisionInput["outcome"] = null;
  let budgetExceeded = false;
  if (routable.length > 0) {
    try {
      outcome = selectProviderWithTrace(
        input.config,
        routable,
        input.taskType ?? "default",
        undefined,
        previewSelectionDeps()
      );
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      budgetExceeded = true;
    }
  }
  return buildRoutingDecision(
    {
      request: input.request,
      config: input.config,
      candidates: input.candidates,
      outcome,
      budgetExceeded,
      liveRequestExecuted: false,
    },
    clock
  );
}

/** A decision reduced to counts and ids, safe for structured logs. */
export interface RoutingDecisionSummary {
  decisionId: string;
  requestId: string;
  policyVersion: string;
  strategy?: string;
  selectionMode?: RoutingDecision["selectionMode"];
  selected: string | null;
  candidateCount: number;
  eligibleCount: number;
  exclusions: Partial<Record<RoutingExclusionReason, number>>;
}

export function summarizeRoutingDecision(decision: RoutingDecision): RoutingDecisionSummary {
  const exclusions: Partial<Record<RoutingExclusionReason, number>> = {};
  for (const candidate of decision.candidates) {
    for (const reason of candidate.exclusionReasons) {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    }
  }
  return {
    decisionId: decision.decisionId,
    requestId: decision.requestId,
    policyVersion: decision.policyVersion,
    strategy: decision.strategy,
    selectionMode: decision.selectionMode,
    selected: decision.selected
      ? `${decision.selected.providerId}/${decision.selected.modelId}`
      : null,
    candidateCount: decision.candidates.length,
    eligibleCount: decision.candidates.filter((candidate) => candidate.eligible).length,
    exclusions,
  };
}
