/**
 * The request's latency budget (`RoutingBudget.maxLatencyMs`) applied to live auto-combo routing.
 *
 * The budget is opt-in per request (the `X-OmniRoute-Latency-Budget` header): with none set every
 * function here is the identity, so a request without a budget routes exactly as it did before the
 * budget existed. With one set, a candidate whose estimated latency exceeds it is not routable —
 * not as the first pick and not as a failover target, because falling back past the budget would
 * break the very promise the caller asked for.
 *
 * "Exceeds" is decided by `exceedsLatencyBudget()` in `../routing/attemptPolicy.ts`, the same test
 * that produces the `latency_over_budget` exclusion reason on the recorded decision, so what the
 * decision says was excluded is exactly what selection and failover refused to use.
 *
 * Candidates and targets whose latency is unknown are treated as within budget, matching
 * `checkFailoverBudget()`: an unknown estimate is not evidence of a breach.
 */
import { exceedsLatencyBudget } from "../routing/attemptPolicy.ts";

/** The latency signal a candidate carries; `p95LatencyMs` is the estimate the router scores. */
interface LatencyScoredCandidate {
  executionKey: string;
  p95LatencyMs: number;
}

/** Candidates whose estimated latency fits `maxLatencyMs`. Undefined budget keeps every one. */
export function candidatesWithinLatencyBudget<T extends { p95LatencyMs: number }>(
  candidates: T[],
  maxLatencyMs: number | undefined
): T[] {
  if (maxLatencyMs === undefined) return candidates;
  return candidates.filter(
    (candidate) => !exceedsLatencyBudget(candidate.p95LatencyMs, maxLatencyMs)
  );
}

/**
 * The failover chain with every over-budget target removed, keeping the order of the rest. A
 * target with no matching candidate has no latency estimate and stays, as does every target when
 * no budget was set.
 */
export function dropTargetsOverLatencyBudget<T extends { executionKey: string }>(
  targets: T[],
  candidates: ReadonlyArray<LatencyScoredCandidate>,
  maxLatencyMs: number | undefined
): T[] {
  if (maxLatencyMs === undefined) return targets;
  const latencyByKey = new Map(candidates.map((c) => [c.executionKey, c.p95LatencyMs]));
  return targets.filter(
    (target) => !exceedsLatencyBudget(latencyByKey.get(target.executionKey), maxLatencyMs)
  );
}
