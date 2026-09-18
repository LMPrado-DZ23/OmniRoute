/**
 * Provider attempt policy: how a failed attempt is classified, whether it may be retried on the
 * same candidate, and whether failing over to the next candidate still fits the request budget.
 *
 * Permanent failures (bad credentials, unknown model, invalid request, exhausted quota) are never
 * retried on the same candidate: repeating them cannot succeed and only burns quota and time.
 */
import type {
  ProviderAttempt,
  ProviderAttemptOutcome,
  RoutingBudget,
  RoutingCandidate,
  RoutingDecision,
  RoutingExclusionReason,
} from "@/shared/contracts/routing";
import {
  classifyProviderFailure,
  type ProviderFailureType,
} from "../../../src/lib/resilience/failureClassification";

/** Statuses a combo retries on the same target before failing over: timeouts, 429 and 5xx. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableAttemptStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

const OUTCOME_BY_FAILURE: Record<ProviderFailureType, ProviderAttemptOutcome> = {
  authentication_error: "auth_error",
  permission_error: "auth_error",
  rate_limit: "rate_limited",
  quota_exhausted: "quota_exhausted",
  timeout: "timeout",
  network_error: "network_error",
  provider_5xx: "provider_error",
  invalid_request: "invalid_request",
  model_unavailable: "model_not_found",
  unknown: "provider_error",
};

export interface AttemptResultInput {
  providerId: string;
  /** HTTP status from the provider, when a response arrived. */
  status?: number;
  /** Error text used only for classification; it is never stored on the attempt. */
  errorText?: string;
  /** The client went away or the request was cancelled. */
  aborted?: boolean;
  /** Part of a streamed response was already sent to the client. */
  streamStarted?: boolean;
}

export function classifyAttemptOutcome(input: AttemptResultInput): ProviderAttemptOutcome {
  if (input.aborted) return "cancelled";
  const status = input.status;
  if (status !== undefined && status >= 200 && status < 300 && !input.errorText) return "success";
  if (input.streamStarted) return "stream_failed";
  const failure = classifyProviderFailure({
    providerId: input.providerId,
    statusCode: status,
    message: input.errorText,
  });
  return OUTCOME_BY_FAILURE[failure.type];
}

const PERMANENT_OUTCOMES: ReadonlySet<ProviderAttemptOutcome> = new Set([
  "auth_error",
  "model_not_found",
  "invalid_request",
  "quota_exhausted",
]);

export function isPermanentAttemptOutcome(outcome: ProviderAttemptOutcome): boolean {
  return PERMANENT_OUTCOMES.has(outcome);
}

/** Transient failures only. A failed stream already delivered output, so it is not replayed. */
const SAME_CANDIDATE_RETRY_OUTCOMES: ReadonlySet<ProviderAttemptOutcome> = new Set([
  "rate_limited",
  "timeout",
  "network_error",
  "provider_error",
]);

export function canRetrySameCandidate(outcome: ProviderAttemptOutcome): boolean {
  return SAME_CANDIDATE_RETRY_OUTCOMES.has(outcome);
}

type BudgetExclusionReason = Extract<
  RoutingExclusionReason,
  "cost_over_budget" | "latency_over_budget"
>;

/** `reason` is null when the attempt fits the budget. */
export interface FailoverBudgetVerdict {
  allowed: boolean;
  reason: BudgetExclusionReason | null;
}

/**
 * Whether one more attempt on `next` still fits the request budget, given what the earlier
 * attempts cost and how long the request has been running. Unknown estimates do not block.
 */
export function checkFailoverBudget(input: {
  attempts: readonly ProviderAttempt[];
  next: Pick<RoutingCandidate, "estimatedCostUsd" | "estimatedLatencyMs">;
  budget?: RoutingBudget;
  elapsedMs: number;
}): FailoverBudgetVerdict {
  const maxCost = input.budget?.maxCost;
  const nextCost = input.next.estimatedCostUsd;
  if (maxCost !== undefined && nextCost !== null) {
    const spent = input.attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
    if (spent + nextCost > maxCost) return { allowed: false, reason: "cost_over_budget" };
  }
  const maxLatencyMs = input.budget?.maxLatencyMs;
  const nextLatency = input.next.estimatedLatencyMs;
  if (maxLatencyMs !== undefined && nextLatency !== null) {
    if (input.elapsedMs + nextLatency > maxLatencyMs) {
      return { allowed: false, reason: "latency_over_budget" };
    }
  }
  return { allowed: true, reason: null };
}

export interface FailoverPlan {
  /** Candidate for the next attempt; absent when nothing eligible fits. */
  next?: RoutingCandidate;
  skipped: Array<{
    providerId: string;
    modelId: string;
    reason: BudgetExclusionReason | "already_attempted";
  }>;
}

/**
 * Next candidate after a failed attempt: the eligible candidates in decision order (selected
 * first), skipping any already attempted and any whose attempt would exceed the budget.
 */
export function planNextAttempt(input: {
  decision: RoutingDecision;
  attempts: readonly ProviderAttempt[];
  budget?: RoutingBudget;
  elapsedMs: number;
}): FailoverPlan {
  const attempted = new Set(input.attempts.map((a) => `${a.providerId}\0${a.modelId}`));
  const selected = input.decision.selected;
  const ordered = [
    ...(selected ? [selected] : []),
    ...input.decision.candidates.filter((c) => c !== selected),
  ].filter((candidate) => candidate.eligible);
  const skipped: FailoverPlan["skipped"] = [];
  for (const candidate of ordered) {
    const identity = { providerId: candidate.providerId, modelId: candidate.modelId };
    if (attempted.has(`${candidate.providerId}\0${candidate.modelId}`)) {
      skipped.push({ ...identity, reason: "already_attempted" });
      continue;
    }
    const { reason } = checkFailoverBudget({ ...input, next: candidate });
    if (reason === null) return { next: candidate, skipped };
    skipped.push({ ...identity, reason });
  }
  return { skipped };
}
