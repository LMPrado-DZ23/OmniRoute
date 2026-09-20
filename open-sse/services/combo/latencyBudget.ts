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
  latencyIsEstimated?: boolean;
}

/**
 * Whether this candidate's latency is a measurement rather than the per-model bootstrap
 * guess. `buildAutoCandidates` sets `latencyIsEstimated` when nothing was measured; a
 * candidate that predates the flag, or one built by a caller that does not set it, is taken
 * at face value so behaviour is unchanged for everything that was already measuring.
 */
function latencyIsMeasured(candidate: { latencyIsEstimated?: boolean }): boolean {
  return candidate.latencyIsEstimated !== true;
}

/**
 * Candidates whose estimated latency fits `maxLatencyMs`. Undefined budget keeps every one.
 *
 * A candidate whose latency was never measured is kept regardless of the budget. Every
 * candidate carries a number — `resolveP95LatencyMs` falls back to a hardcoded per-model
 * default — so without this distinction "unknown" is indistinguishable from "measured", and
 * a fresh install would permanently refuse every model under its bootstrap value on no
 * evidence at all. Worse, it is self-sealing: the traffic that would replace the guess with
 * a measurement can only happen if the candidate is allowed through.
 */
export function candidatesWithinLatencyBudget<
  T extends { p95LatencyMs: number; latencyIsEstimated?: boolean },
>(candidates: T[], maxLatencyMs: number | undefined): T[] {
  if (maxLatencyMs === undefined) return candidates;
  return candidates.filter(
    (candidate) =>
      !latencyIsMeasured(candidate) || !exceedsLatencyBudget(candidate.p95LatencyMs, maxLatencyMs)
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
  // Only measured latencies are indexed: an unmeasured candidate is treated exactly like a
  // target with no candidate row at all — no estimate, so no evidence of a breach.
  const latencyByKey = new Map(
    candidates.filter(latencyIsMeasured).map((c) => [c.executionKey, c.p95LatencyMs])
  );
  return targets.filter(
    (target) => !exceedsLatencyBudget(latencyByKey.get(target.executionKey), maxLatencyMs)
  );
}
