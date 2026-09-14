/**
 * SLO alerting — evaluates the SLO report on an unref'd timer and turns state
 * CHANGES into webhook events:
 *
 *  - `slo.breached`          an objective moved into `breached` (sent once)
 *  - `slo.recovered`         a breached objective is back to `ok` (sent once)
 *  - `provider.circuit_open` a provider circuit breaker is newly OPEN (once per open cycle)
 *
 * `insufficient_data` keeps the previous state, so low traffic never flaps.
 * Payloads carry only objective names, numbers and sanitized provider labels —
 * never prompts, responses, API keys, connection ids or account ids.
 * Disabled with settings `slo.alertsEnabled = false`.
 */

import { routingMetrics } from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { sanitizeLabelValue } from "@omniroute/open-sse/services/routing/metricLabels.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import { dispatchEvent } from "@/lib/webhookDispatcher";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { evaluateSlo, type BreakerHistoryInput, type SloReport } from "./sloEvaluator";
import { resolveSloSettings } from "./sloSettings";

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

const tracker = new SloAlertTracker();
let loopTimer: ReturnType<typeof setInterval> | null = null;

async function runSloAlertTick(): Promise<void> {
  const settings = resolveSloSettings((await getCachedSettings()).slo);
  if (!settings.alertsEnabled) return;
  const breakers = getAllCircuitBreakerStatuses();
  const now = Date.now();
  const report = evaluateSlo(
    settings,
    routingMetrics.window(settings.windowMinutes * 60_000),
    breakers,
    now
  );
  for (const alert of tracker.transitions(report, breakers)) {
    await dispatchEvent(alert.event, alert.data).catch(() => undefined);
  }
}

/** Start the periodic SLO evaluation. Idempotent; the timer never keeps the process alive. */
export function startSloAlertLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    runSloAlertTick().catch(() => undefined);
  }, SLO_ALERT_INTERVAL_MS);
  loopTimer.unref?.();
}
