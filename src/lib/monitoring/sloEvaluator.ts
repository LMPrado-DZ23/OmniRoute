/**
 * SLO evaluator — pure function from (settings, routing metrics window,
 * circuit-breaker history) to an SLO report. No I/O; the caller supplies data.
 *
 * Objectives (thresholds from SloSettings, see docs/ops/MONITORING_GUIDE.md):
 *  - availability          success / (success + failed)            ≥ availabilityTarget
 *  - error_rate            (error + malformed + stream_interrupted)
 *                          / (success + failed)                    ≤ errorRateMax
 *  - latency_p95 / p99     end-to-end latency percentiles (ms)     ≤ latencyP95Ms / latencyP99Ms
 *  - ttft_p95              first stream chunk p95 (ms)             ≤ ttftP95Ms
 *  - failover_success_rate combo requests that needed a fallback
 *                          and still succeeded                     ≥ failoverSuccessRateMin
 *  - provider_recovery     worst circuit OPEN→CLOSED duration (ms)
 *                          in the window, ongoing opens included   ≤ providerRecoveryMaxMs
 *
 * `failed` excludes cancelled and guardrail_blocked outcomes (client/policy
 * decisions, not service failures). An objective with fewer than `minSamples`
 * samples reports `insufficient_data` and never breaches.
 */

import type { RoutingMetricsWindow } from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { sanitizeLabelValue } from "@omniroute/open-sse/services/routing/metricLabels.ts";
import type { SloSettings } from "./sloSettings";

export type SloObjectiveKey =
  | "availability"
  | "error_rate"
  | "latency_p95"
  | "latency_p99"
  | "ttft_p95"
  | "failover_success_rate"
  | "provider_recovery";

export type SloStatus = "ok" | "breached" | "insufficient_data";

export interface SloObjectiveResult {
  objective: SloObjectiveKey;
  /** "min": value must be ≥ threshold; "max": value must be ≤ threshold. */
  comparison: "min" | "max";
  threshold: number;
  value: number | null;
  samples: number;
  status: SloStatus;
  /** Provider label (sanitized) responsible for provider_recovery, when any. */
  provider?: string;
}

export interface SloReport {
  status: SloStatus;
  windowMinutes: number;
  evaluatedAt: number;
  objectives: SloObjectiveResult[];
}

/** Structural subset of CircuitBreakerStatus used by the evaluator. */
export interface BreakerHistoryInput {
  name: string;
  state: string;
  failureCount?: number;
  retryAfterMs?: number;
  transitionHistory: ReadonlyArray<{ to: string; timestamp: number }>;
}

function objective(
  key: SloObjectiveKey,
  comparison: "min" | "max",
  threshold: number,
  value: number | null,
  samples: number,
  minSamples: number
): SloObjectiveResult {
  let status: SloStatus = "insufficient_data";
  if (value !== null && samples >= minSamples) {
    const breached = comparison === "min" ? value < threshold : value > threshold;
    status = breached ? "breached" : "ok";
  }
  return { objective: key, comparison, threshold, value, samples, status };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Recovery episodes (ms) for one breaker that ended — or are still open — inside the window. */
function recoveryEpisodes(
  breaker: BreakerHistoryInput,
  windowStartMs: number,
  nowMs: number
): number[] {
  const episodes: number[] = [];
  let openedAt: number | null = null;
  const history = [...breaker.transitionHistory].sort((a, b) => a.timestamp - b.timestamp);
  for (const transition of history) {
    if (transition.to === "OPEN" && openedAt === null) {
      openedAt = transition.timestamp;
    } else if (transition.to === "CLOSED" && openedAt !== null) {
      if (transition.timestamp >= windowStartMs) episodes.push(transition.timestamp - openedAt);
      openedAt = null;
    }
  }
  const stillRecovering = breaker.state === "OPEN" || breaker.state === "HALF_OPEN";
  if (openedAt !== null && stillRecovering) episodes.push(Math.max(0, nowMs - openedAt));
  return episodes;
}

/** Worst provider recovery time across breakers within the window. */
export function computeProviderRecovery(
  breakers: ReadonlyArray<BreakerHistoryInput>,
  windowStartMs: number,
  nowMs: number
): { worstMs: number | null; provider: string | null; samples: number } {
  let worstMs: number | null = null;
  let provider: string | null = null;
  let samples = 0;
  for (const breaker of breakers) {
    for (const episodeMs of recoveryEpisodes(breaker, windowStartMs, nowMs)) {
      samples += 1;
      if (worstMs === null || episodeMs > worstMs) {
        worstMs = episodeMs;
        provider = sanitizeLabelValue(breaker.name);
      }
    }
  }
  return { worstMs, provider, samples };
}

function overallStatus(objectives: SloObjectiveResult[]): SloStatus {
  if (objectives.some((o) => o.status === "breached")) return "breached";
  if (objectives.some((o) => o.status === "ok")) return "ok";
  return "insufficient_data";
}

export function evaluateSlo(
  settings: SloSettings,
  window: RoutingMetricsWindow,
  breakers: ReadonlyArray<BreakerHistoryInput>,
  nowMs: number
): SloReport {
  const eligible = window.success + window.failed;
  const hardErrors =
    window.outcomes.error + window.outcomes.malformed + window.outcomes.stream_interrupted;
  const min = settings.minSamples;
  const recovery = computeProviderRecovery(
    breakers,
    nowMs - settings.windowMinutes * 60_000,
    nowMs
  );
  const recoveryObjective = objective(
    "provider_recovery",
    "max",
    settings.providerRecoveryMaxMs,
    recovery.worstMs,
    recovery.samples,
    1
  );
  if (recovery.provider) recoveryObjective.provider = recovery.provider;

  const objectives: SloObjectiveResult[] = [
    objective(
      "availability",
      "min",
      settings.availabilityTarget,
      ratio(window.success, eligible),
      eligible,
      min
    ),
    objective(
      "error_rate",
      "max",
      settings.errorRateMax,
      ratio(hardErrors, eligible),
      eligible,
      min
    ),
    objective(
      "latency_p95",
      "max",
      settings.latencyP95Ms,
      window.latency.p95,
      window.latency.count,
      min
    ),
    objective(
      "latency_p99",
      "max",
      settings.latencyP99Ms,
      window.latency.p99,
      window.latency.count,
      min
    ),
    objective("ttft_p95", "max", settings.ttftP95Ms, window.ttft.p95, window.ttft.count, min),
    objective(
      "failover_success_rate",
      "min",
      settings.failoverSuccessRateMin,
      ratio(window.comboFailoverSuccesses, window.comboFailoverRequests),
      window.comboFailoverRequests,
      min
    ),
    recoveryObjective,
  ];
  return {
    status: overallStatus(objectives),
    windowMinutes: settings.windowMinutes,
    evaluatedAt: nowMs,
    objectives,
  };
}
