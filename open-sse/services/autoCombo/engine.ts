/**
 * Auto-Combo Engine — The `auto` combo type that self-manages provider selection.
 *
 * Features:
 *   - Scoring-based provider selection from candidate pool
 *   - Bandit exploration (configurable rate, default 5%)
 *   - Budget cap enforcement
 *   - Self-healing integration
 *   - Mode pack support
 */

import {
  scorePool,
  DEFAULT_WEIGHTS,
  normalizeScoringWeights,
  type ScoringWeights,
  type ProviderCandidate,
  type ScoredProvider,
} from "./scoring";
import { getTaskFitness } from "./taskFitness";
import { getModePack } from "./modePacks";
import { getSelfHealingManager, type SelfHealingManager } from "./selfHealing";
import { classifyPromptIntent } from "../intentClassifier";
import type { RoutingExclusionReason } from "@/shared/contracts/routing";

export interface AutoComboConfig {
  id: string;
  name: string;
  type: "auto";
  candidatePool: string[]; // provider names (empty = all)
  weights: ScoringWeights;
  modePack?: string;
  budgetCap?: number; // max cost per request in USD
  /**
   * Policy applied when EVERY candidate exceeds `budgetCap` (#3470):
   *   - "cheapest" (default): fall back to the globally cheapest candidate, even
   *     though it still exceeds the cap (existing/legacy behavior).
   *   - "strict": refuse to select — `selectProvider()` throws `BudgetExceededError`
   *     so the caller can surface a clear cost-exceeds-budget response instead of
   *     silently overspending.
   */
  budgetFallback?: "cheapest" | "strict";
  explorationRate: number; // 0.05 = 5% exploratory
  /** If set, RouterStrategy name to use for selection ('rules' | 'cost' | 'latency') */
  routerStrategy?: string;
}

/**
 * Thrown by `selectProvider()` when `budgetFallback: "strict"` is set and no
 * candidate (including the cheapest) fits within `budgetCap` (#3470). Callers
 * should catch this and surface a cost-exceeds-budget response — never let it
 * propagate as an unhandled 500.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly budgetCap: number,
    public readonly cheapestCostUsd: number
  ) {
    super(
      `No candidate fits within the configured budget cap of $${budgetCap.toFixed(4)} ` +
        `(cheapest available candidate costs $${cheapestCostUsd.toFixed(4)})`
    );
    this.name = "BudgetExceededError";
  }
}

export interface SelectionResult {
  provider: string;
  model: string;
  score: number;
  isExploration: boolean;
  factors: Record<string, number>;
  excluded: string[];
  connectionId?: string;
}

type TierName = "top" | "mid" | "rest";

const TIER_PREFERENCES: Record<string, Record<TierName, number>> = {
  smart: { top: 0.5, mid: 0.3, rest: 0.2 },
  fast: { top: 0.3, mid: 0.5, rest: 0.2 },
  cheap: { top: 0.2, mid: 0.3, rest: 0.5 },
  coding: { top: 0.6, mid: 0.25, rest: 0.15 },
  default: { top: 0.45, mid: 0.35, rest: 0.2 },
};

function tierPreferencesForName(name: string): Record<TierName, number> {
  const key = name.toLowerCase();
  if (TIER_PREFERENCES[key]) return TIER_PREFERENCES[key];
  for (const prefix of Object.keys(TIER_PREFERENCES)) {
    if (key.startsWith(`${prefix}-`) || key.includes(prefix)) return TIER_PREFERENCES[prefix];
  }
  return TIER_PREFERENCES.default;
}

const SCORE_EPSILON = 1e-4;
const CLEAR_WINNER_THRESHOLD = 0.1;
/** Request size the budget cap is checked against: cost per 1M tokens → cost of 1K tokens. */
const ESTIMATED_REQUEST_TOKENS = 1000;

class ScoreTierRotator {
  private readonly tierCounters = new Map<TierName, number>();
  private rrCounter = 0;

  constructor(private readonly comboName: string) {}

  /** Independent copy, so a preview can pick without advancing the live counters. */
  clone(): ScoreTierRotator {
    const copy = new ScoreTierRotator(this.comboName);
    for (const [tier, count] of this.tierCounters) copy.tierCounters.set(tier, count);
    copy.rrCounter = this.rrCounter;
    return copy;
  }

  pick(candidates: ScoredProvider[], random: () => number = () => Math.random()): ScoredProvider {
    if (candidates.length === 0) {
      throw new Error(`ScoreTierRotator: no candidates to pick from for combo=${this.comboName}`);
    }
    if (candidates.length === 1) return candidates[0];

    const tiers = groupIntoTiers(candidates);
    const best = candidates[0].score;
    const worst = candidates[candidates.length - 1].score;
    if (tiers.top.length > 0 && best - worst >= CLEAR_WINNER_THRESHOLD) {
      return this.pickFromPool(tiers.top);
    }
    const prefs = tierPreferencesForName(this.comboName);
    const chosen = chooseTierWeighted(
      tiers,
      prefs,
      (pool) => this.pickFromPool(pool),
      () => this.advance(tiers, prefs, candidates),
      random
    );
    return chosen;
  }

  private advance(
    tiers: Record<TierName, ScoredProvider[]>,
    prefs: Record<TierName, number>,
    candidates: ScoredProvider[]
  ): ScoredProvider {
    const order: TierName[] = ["top", "mid", "rest"];
    for (const tier of order) {
      if (tiers[tier].length > 0 && prefs[tier] > 0) {
        const idx = this.tierCounters.get(tier) ?? 0;
        const picked = tiers[tier][idx % tiers[tier].length];
        this.tierCounters.set(tier, idx + 1);
        return picked;
      }
    }
    return tiers.top[0] ?? tiers.mid[0] ?? tiers.rest[0] ?? candidates[0];
  }

  private pickFromPool(pool: ScoredProvider[]): ScoredProvider {
    if (pool.length === 0) throw new Error("pickFromPool: empty pool");
    if (pool.length === 1) return pool[0];
    const picked = pool[this.rrCounter % pool.length];
    this.rrCounter = (this.rrCounter + 1) % pool.length;
    return picked;
  }
}

function groupIntoTiers(candidates: ScoredProvider[]): Record<TierName, ScoredProvider[]> {
  if (candidates.length === 0) return { top: [], mid: [], rest: [] };
  const best = candidates[0].score;
  const worst = candidates[candidates.length - 1].score;
  const range = best - worst;

  const top: ScoredProvider[] = [];
  const mid: ScoredProvider[] = [];
  const rest: ScoredProvider[] = [];

  for (const c of candidates) {
    const delta = best - c.score;
    if (delta <= SCORE_EPSILON) top.push(c);
    else if (range <= SCORE_EPSILON || delta <= range * 0.3) mid.push(c);
    else rest.push(c);
  }

  if (mid.length === 0 && rest.length > 0) {
    const half = Math.ceil(rest.length / 2);
    mid.push(...rest.splice(0, half));
  }

  return { top, mid, rest };
}

function chooseTierWeighted(
  tiers: Record<TierName, ScoredProvider[]>,
  prefs: Record<TierName, number>,
  pickFromPool: (pool: ScoredProvider[]) => ScoredProvider,
  fallback: () => ScoredProvider,
  random: () => number
): ScoredProvider {
  const active = {
    top: tiers.top.length > 0 ? prefs.top : 0,
    mid: tiers.mid.length > 0 ? prefs.mid : 0,
    rest: tiers.rest.length > 0 ? prefs.rest : 0,
  };
  const total = active.top + active.mid + active.rest;
  if (total <= 0) return fallback();
  const r = random() * total;
  let acc = 0;
  if (active.top > 0 && (acc += active.top) >= r) return pickFromPool(tiers.top);
  if (active.mid > 0 && (acc += active.mid) >= r) return pickFromPool(tiers.mid);
  if (active.rest > 0) return pickFromPool(tiers.rest);
  return fallback();
}

/**
 * Whether the rotator can return only one candidate from this score-sorted list
 * ("deterministic") or alternates between near-equal candidates across requests ("rotation").
 */
export function describeRotation(candidates: ScoredProvider[]): "deterministic" | "rotation" {
  if (candidates.length <= 1) return "deterministic";
  const spread = candidates[0].score - candidates[candidates.length - 1].score;
  const topTierSize = groupIntoTiers(candidates).top.length;
  return spread >= CLEAR_WINNER_THRESHOLD && topTierSize === 1 ? "deterministic" : "rotation";
}

const comboRotators = new Map<string, ScoreTierRotator>();
function getRotator(comboName: string): ScoreTierRotator {
  let r = comboRotators.get(comboName);
  if (!r) {
    r = new ScoreTierRotator(comboName);
    comboRotators.set(comboName, r);
  }
  return r;
}

/** Self-healing, rotation and randomness one selection reads. */
interface AutoSelectionDeps {
  healer: SelfHealingManager;
  rotatorFor: (key: string) => ScoreTierRotator;
  /** Draws for the exploration bandit: whether to explore, then which candidate. */
  explorationRandom: () => number;
  /** Draw for the weighted tier choice inside the rotator. */
  tierRandom: () => number;
}

function liveSelectionDeps(): AutoSelectionDeps {
  return {
    healer: getSelfHealingManager(),
    rotatorFor: getRotator,
    explorationRandom: () => Math.random(),
    tierRandom: () => Math.random(),
  };
}

/**
 * Deps for a what-if selection: copies of the live self-healing and rotator state, exploration
 * off, and the highest-preference score tier. A selection run with them changes no live state, so
 * repeated previews of the same input return the same answer.
 */
export function previewSelectionDeps(): AutoSelectionDeps {
  const rotators = new Map<string, ScoreTierRotator>();
  return {
    healer: getSelfHealingManager().clone(),
    rotatorFor: (key) => {
      let rotator = rotators.get(key);
      if (!rotator) {
        rotator = comboRotators.get(key)?.clone() ?? new ScoreTierRotator(key);
        rotators.set(key, rotator);
      }
      return rotator;
    },
    explorationRandom: () => 1,
    tierRandom: () => 0,
  };
}

type EngineExclusionReason = Extract<
  RoutingExclusionReason,
  "not_in_candidate_pool" | "circuit_open" | "self_healing_excluded"
>;

/** What the engine saw while selecting: enough to explain the decision afterwards. */
export interface AutoSelectionTrace {
  taskType: string;
  weights: ScoringWeights;
  /** Every scored candidate, best first. */
  scored: ScoredProvider[];
  /** Candidates the selection could pick from, best first. */
  eligible: ScoredProvider[];
  /** Why a provider was left out. Self-healing tracks providers, not models. */
  excludedProviders: Map<string, EngineExclusionReason>;
  /** True when every candidate was excluded and the engine fell back to the full list. */
  exclusionFallback: boolean;
}

/** Estimated USD cost of one request at the given price per 1M tokens (budget-cap estimate). */
export function estimateAutoRequestCostUsd(costPer1MTokens: number): number {
  return (costPer1MTokens / 1_000_000) * ESTIMATED_REQUEST_TOKENS;
}

function lastUserText(promptMessages: Array<{ role: string; content: unknown }>): string {
  const lastUserMsg = [...promptMessages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return "";
  if (typeof lastUserMsg.content === "string") return lastUserMsg.content;
  if (!Array.isArray(lastUserMsg.content)) return "";
  return (lastUserMsg.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join(" ");
}

// ── Intent classification (ClawRouter Feature #10/11) ────────────────────
// When taskType is generic ('default'), attempt to classify the prompt intent
// using the multilingual intentClassifier for better task fitness scoring.
function resolveEffectiveTaskType(
  taskType: string,
  promptMessages?: Array<{ role: string; content: unknown }>
): string {
  if ((taskType !== "default" && taskType !== "") || !promptMessages?.length) return taskType;
  const text = lastUserText(promptMessages);
  // 'code' | 'reasoning' | 'simple' | 'medium'
  return text.length > 10 ? classifyPromptIntent(text) : taskType;
}

// Resolve weights from mode pack or config
function resolveSelectionWeights(config: AutoComboConfig): ScoringWeights {
  const pack = config.modePack ? getModePack(config.modePack) : null;
  return normalizeScoringWeights(pack || config.weights);
}

function filterSelectionPool(
  config: AutoComboConfig,
  candidates: ProviderCandidate[],
  healer: SelfHealingManager,
  excluded: string[],
  reasons: Map<string, EngineExclusionReason>
): { pool: ProviderCandidate[]; exclusionFallback: boolean } {
  const pool = candidates.filter((c) => {
    if (config.candidatePool.length > 0 && !config.candidatePool.includes(c.provider)) {
      reasons.set(c.provider, "not_in_candidate_pool");
      return false;
    }
    const evaluation = healer.evaluate(c.provider, 0.5, c.circuitBreakerState);
    if (evaluation.excluded) {
      excluded.push(c.provider);
      reasons.set(
        c.provider,
        c.circuitBreakerState === "OPEN" ? "circuit_open" : "self_healing_excluded"
      );
      return false;
    }
    return true;
  });
  if (pool.length > 0) return { pool, exclusionFallback: false };
  // Fallback: allow all candidates regardless of exclusions
  excluded.length = 0;
  reasons.clear();
  return { pool: [...candidates], exclusionFallback: true };
}

// Apply self-healing re-evaluation with actual scores
function applyScoreExclusions(
  scored: ScoredProvider[],
  healer: SelfHealingManager,
  excluded: string[],
  reasons: Map<string, EngineExclusionReason>
): ScoredProvider[] {
  const kept = scored.filter((s) => {
    if (!healer.evaluate(s.provider, s.score, "CLOSED").excluded) return true;
    excluded.push(s.provider);
    if (!reasons.has(s.provider)) reasons.set(s.provider, "self_healing_excluded");
    return false;
  });
  return kept.length > 0 ? kept : scored;
}

// Selection: exploration vs exploitation (no exploration in incident mode)
function pickCandidate(
  config: AutoComboConfig,
  eligible: ScoredProvider[],
  deps: AutoSelectionDeps
): { selected: ScoredProvider; isExploration: boolean } {
  const explorationRate = deps.healer.isInIncidentMode() ? 0 : config.explorationRate;
  const isExploration = deps.explorationRandom() < explorationRate && eligible.length > 1;
  if (isExploration) {
    const idx = Math.floor(deps.explorationRandom() * eligible.length);
    return { selected: eligible[idx], isExploration };
  }
  return { selected: deps.rotatorFor(config.name).pick(eligible, deps.tierRandom), isExploration };
}

// Budget cap enforcement
function applyBudgetCap(
  config: AutoComboConfig,
  candidates: ProviderCandidate[],
  eligible: ScoredProvider[],
  selected: ScoredProvider,
  deps: AutoSelectionDeps
): ScoredProvider {
  const budgetCap = config.budgetCap;
  if (!budgetCap) return selected;
  const costMap = new Map<string, number>();
  for (const c of candidates) {
    costMap.set(`${c.provider}\0${c.model}`, c.costPer1MTokens);
  }
  const estimatedCostFor = (s: ScoredProvider) =>
    estimateAutoRequestCostUsd(costMap.get(`${s.provider}\0${s.model}`) ?? 0);
  if (estimatedCostFor(selected) <= budgetCap) return selected;

  const budgetOk = eligible.filter((s) => estimatedCostFor(s) <= budgetCap);
  if (budgetOk.length > 0) {
    return deps.rotatorFor(`${config.name}#budget`).pick(budgetOk, deps.tierRandom);
  }
  const cheapest = [...eligible].sort((a, b) => estimatedCostFor(a) - estimatedCostFor(b))[0];
  if (config.budgetFallback === "strict") {
    throw new BudgetExceededError(budgetCap, cheapest ? estimatedCostFor(cheapest) : 0);
  }
  return cheapest ?? selected;
}

/**
 * `selectProvider` plus the trace of what it saw. With the default deps it is the live selection
 * (shared self-healing state, round-robin counters, exploration); with `previewSelectionDeps()` it
 * runs the same algorithm without touching any of that state.
 */
export function selectProviderWithTrace(
  config: AutoComboConfig,
  candidates: ProviderCandidate[],
  taskType: string = "default",
  promptMessages?: Array<{ role: string; content: unknown }>,
  deps: AutoSelectionDeps = liveSelectionDeps()
): { selection: SelectionResult; trace: AutoSelectionTrace } {
  const effectiveTaskType = resolveEffectiveTaskType(taskType, promptMessages);
  const weights = resolveSelectionWeights(config);
  const excluded: string[] = [];
  const excludedProviders = new Map<string, EngineExclusionReason>();
  const { pool, exclusionFallback } = filterSelectionPool(
    config,
    candidates,
    deps.healer,
    excluded,
    excludedProviders
  );
  // Score all providers (using classified intent if available)
  const scored = scorePool(pool, effectiveTaskType, weights, getTaskFitness);
  const eligible = applyScoreExclusions(scored, deps.healer, excluded, excludedProviders);
  const picked = pickCandidate(config, eligible, deps);
  const selected = applyBudgetCap(config, candidates, eligible, picked.selected, deps);

  return {
    selection: {
      provider: selected.provider,
      model: selected.model,
      score: selected.score,
      isExploration: picked.isExploration,
      factors: selected.factors as unknown as Record<string, number>,
      excluded,
      connectionId: selected.connectionId,
    },
    trace: {
      taskType: effectiveTaskType,
      weights,
      scored,
      eligible,
      excludedProviders,
      exclusionFallback,
    },
  };
}

/**
 * Select the best provider from an auto-combo pool.
 *
 * @param config - AutoCombo configuration
 * @param candidates - Provider candidates to score
 * @param taskType - Task type hint. When "default" or omitted, the engine will attempt
 *   to infer the intent from `promptMessages` using multilingual classification.
 * @param promptMessages - Optional raw messages for intent classification
 */
export function selectProvider(
  config: AutoComboConfig,
  candidates: ProviderCandidate[],
  taskType: string = "default",
  promptMessages?: Array<{ role: string; content: unknown }>
): SelectionResult {
  return selectProviderWithTrace(config, candidates, taskType, promptMessages).selection;
}

// ============ Auto-Combo Config Schema Reference ============
// Note: AutoCombos are now persisted natively in the SQLite DB via src/lib/db/combos.ts
// using the combo.strategy = "auto" | "lkgp" type, with parameters nested inside combo.config
