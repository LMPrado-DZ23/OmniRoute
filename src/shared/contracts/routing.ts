/**
 * Shared routing contract: types used by routing code in both src/ and open-sse/. Consumers import
 * them from here instead of declaring look-alike copies. Type-only; no runtime code.
 */

/** One weighted input of a routing score. */
export interface RoutingFactor {
  /** Factor name (quota, health, cost, latency, task_fit, stability, ...). */
  name: string;
  /** Raw factor value, normally within [0, 1]. */
  value: number;
  /** Weight applied to this factor. */
  weight: number;
  /** Weighted contribution (value × weight). */
  contribution: number;
}

/** Circuit breaker state as the routing scorer reads it. */
export type RoutingCircuitState = "closed" | "open" | "half_open";

/** Why a candidate was not eligible in a routing decision. */
export type RoutingExclusionReason =
  | "not_in_candidate_pool"
  | "model_not_found"
  | "capability_missing"
  | "quota_exhausted"
  | "circuit_open"
  | "self_healing_excluded"
  | "cost_over_budget"
  | "latency_over_budget";

/**
 * Quota state of a candidate. "unknown" means no quota signal was observed (no quota fetcher for
 * the provider, or no connection to ask). It is scored as neutral and is never read as "exhausted".
 */
export type RoutingQuotaState = "available" | "low" | "exhausted" | "unknown";

/** Optional per-request limits that the decision and every failover attempt must respect. */
export interface RoutingBudget {
  /** Maximum estimated cost of the request in USD, summed over its attempts. */
  maxCost?: number;
  /** Maximum latency of the request in milliseconds, summed over its attempts. */
  maxLatencyMs?: number;
}

/** What the router is asked to route. It never carries prompt or response content. */
export interface RoutingRequest {
  requestId: string;
  model: string;
  protocol: string;
  capabilities?: string[];
  workspaceId?: string;
  policyId?: string;
  stream?: boolean;
  budget?: RoutingBudget;
}

/**
 * One provider/model the router considered: its score breakdown and why it was or was not
 * eligible. Connection and account identifiers are deliberately absent.
 */
export interface RoutingCandidate {
  providerId: string;
  modelId: string;
  score: number;
  factors: RoutingFactor[];
  eligible: boolean;
  exclusionReasons: RoutingExclusionReason[];
  quota: RoutingQuotaState;
  circuit: RoutingCircuitState;
  estimatedCostUsd: number | null;
  estimatedLatencyMs: number | null;
}

/**
 * How the selected candidate was chosen among the eligible ones: "deterministic" when one
 * candidate is the clear winner, "rotation" when live traffic rotates between near-equal
 * candidates, "exploration" when the live bandit picked a random candidate.
 */
export type RoutingSelectionMode = "deterministic" | "rotation" | "exploration";

/** The router's answer for one request, explainable without re-running it. */
export interface RoutingDecision {
  decisionId: string;
  requestId: string;
  selected?: RoutingCandidate;
  candidates: RoutingCandidate[];
  /** Content hash of the routing policy that produced the decision. */
  policyVersion: string;
  /** ISO-8601 timestamp. */
  generatedAt: string;
  /** False for a preview: no upstream provider was called. */
  liveRequestExecuted: boolean;
  selectionMode?: RoutingSelectionMode;
  /** Router strategy that chose the candidate ("rules" is the scoring engine). */
  strategy?: string;
}

/** Result class of one provider attempt. */
export type ProviderAttemptOutcome =
  | "success"
  | "rate_limited"
  | "timeout"
  | "auth_error"
  | "model_not_found"
  | "quota_exhausted"
  | "invalid_request"
  | "provider_error"
  | "network_error"
  | "stream_failed"
  | "cancelled";

/** One call to an upstream provider made while serving a request. */
export interface ProviderAttempt {
  providerId: string;
  modelId: string;
  /** 1-based attempt number within the request. */
  attempt: number;
  /** ISO-8601 timestamp. */
  startedAt: string;
  durationMs?: number;
  /** HTTP status returned by the provider, when there was one. */
  status?: number;
  outcome: ProviderAttemptOutcome;
  /** Estimated cost of the attempt in USD, when known. */
  costUsd?: number;
}
