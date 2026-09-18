/**
 * SLO alerting — evaluates the SLO report on an unref'd timer and turns state
 * CHANGES into webhook events:
 *
 *  - `slo.breached`          an objective moved into `breached` (sent once)
 *  - `slo.recovered`         a breached objective is back to `ok` (sent once)
 *  - `provider.circuit_open` a provider circuit breaker is newly OPEN (once per open cycle)
 *
 * `insufficient_data` keeps the previous state, so low traffic never flaps.
 * Turning alerts off forgets that state, so re-enabling them never replays a
 * transition that happened while they were off. Ticks never overlap: a tick
 * that finds the previous one still dispatching (slow webhooks) is skipped.
 * Payloads carry only objective names, numbers and sanitized provider labels —
 * never prompts, responses, API keys, connection ids or account ids.
 * Off by default; enabled with settings `slo.alertsEnabled = true`.
 */

import { routingMetrics } from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { sanitizeLabelValue } from "@omniroute/open-sse/services/routing/metricLabels.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import { dispatchEvent } from "@/lib/webhookDispatcher";
import { getAllCircuitBreakerSnapshots } from "@/shared/utils/circuitBreaker";
import type { RoutingMetricsWindow } from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { evaluateSlo, type BreakerHistoryInput, type SloReport } from "./sloEvaluator";
import { resolveSloSettings, type SloSettings } from "./sloSettings";

const SLO_ALERT_INTERVAL_MS = 60_000;

export interface SloAlert {
  event: "slo.breached" | "slo.recovered" | "provider.circuit_open";
  data: Record<string, string | number | null>;
}

/** Deduplicating state machine: remembers breached objectives and open providers. */
export class SloAlertTracker {
  private readonly breached = new Set<string>();
  private openProviders = new Set<string>();

  transitions(report: SloReport, breakers: ReadonlyArray<BreakerHistoryInput>): SloAlert[] {
    return [...this.objectiveAlerts(report), ...this.circuitAlerts(breakers)];
  }

  private objectiveAlerts(report: SloReport): SloAlert[] {
    const alerts: SloAlert[] = [];
    for (const result of report.objectives) {
      const wasBreached = this.breached.has(result.objective);
      if (result.status === "breached" && !wasBreached) {
        this.breached.add(result.objective);
        alerts.push({ event: "slo.breached", data: objectivePayload(report, result) });
      } else if (result.status === "ok" && wasBreached) {
        this.breached.delete(result.objective);
        alerts.push({ event: "slo.recovered", data: objectivePayload(report, result) });
      }
    }
    return alerts;
  }

  private circuitAlerts(breakers: ReadonlyArray<BreakerHistoryInput>): SloAlert[] {
    const alerts: SloAlert[] = [];
    const nowOpen = new Set<string>();
    for (const breaker of breakers) {
      if (breaker.state !== "OPEN") continue;
      const provider = sanitizeLabelValue(breaker.name);
      nowOpen.add(provider);
      if (this.openProviders.has(provider)) continue;
      alerts.push({
        event: "provider.circuit_open",
        data: {
          provider,
          failureCount: breaker.failureCount ?? null,
          retryAfterMs: breaker.retryAfterMs ?? null,
        },
      });
    }
    this.openProviders = nowOpen;
    return alerts;
  }

  /** Forget every remembered breach and open provider. */
  reset(): void {
    this.breached.clear();
    this.openProviders = new Set<string>();
  }
}

function objectivePayload(
  report: SloReport,
  result: SloReport["objectives"][number]
): Record<string, string | number | null> {
  return {
    objective: result.objective,
    value: result.value,
    threshold: result.threshold,
    comparison: result.comparison,
    windowMinutes: report.windowMinutes,
    samples: result.samples,
    provider: result.provider ?? null,
  };
}

export interface SloAlertRunnerDeps {
  loadSettings(): Promise<SloSettings>;
  readBreakers(): BreakerHistoryInput[];
  readWindow(windowMs: number): RoutingMetricsWindow;
  dispatch(event: SloAlert["event"], data: SloAlert["data"]): Promise<unknown>;
  now(): number;
}

/** One SLO alert evaluation per `tick()`, never two at once. */
export class SloAlertRunner {
  private readonly tracker = new SloAlertTracker();
  private running = false;

  constructor(private readonly deps: SloAlertRunnerDeps) {}

  /** Evaluate and dispatch; returns false when skipped because a tick is still running. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.evaluate();
    } finally {
      this.running = false;
    }
    return true;
  }

  private async evaluate(): Promise<void> {
    const settings = await this.deps.loadSettings();
    if (!settings.alertsEnabled) {
      this.tracker.reset();
      return;
    }
    const breakers = this.deps.readBreakers();
    const report = evaluateSlo(
      settings,
      this.deps.readWindow(settings.windowMinutes * 60_000),
      breakers,
      this.deps.now()
    );
    for (const alert of this.tracker.transitions(report, breakers)) {
      await this.deps.dispatch(alert.event, alert.data).catch(() => undefined);
    }
  }
}

const runner = new SloAlertRunner({
  loadSettings: async () => resolveSloSettings((await getCachedSettings()).slo),
  readBreakers: getAllCircuitBreakerSnapshots,
  readWindow: (windowMs) => routingMetrics.window(windowMs),
  dispatch: dispatchEvent,
  now: Date.now,
});
let loopTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic SLO evaluation. Idempotent; the timer never keeps the process alive. */
export function startSloAlertLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    runner.tick().catch(() => undefined);
  }, SLO_ALERT_INTERVAL_MS);
  loopTimer.unref?.();
}
