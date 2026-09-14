/**
 * GET /api/metrics payload builder — joins the in-process routing metrics
 * registry with scrape-time gauges (circuit breakers, quota monitors, SLO
 * report) and renders Prometheus text or a JSON summary.
 *
 * Every label value is either an allowlisted enum (state, status, objective) or
 * a provider id passed through the capped/sanitizing label policy.
 */

import {
  routingMetrics,
  type RoutingMetricsWindow,
} from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { BoundedLabelSet } from "@omniroute/open-sse/services/routing/metricLabels.ts";
import {
  renderPrometheusText,
  type GaugeFamily,
} from "@omniroute/open-sse/services/routing/prometheusText.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import { getAllCircuitBreakerStatuses } from "@/shared/utils/circuitBreaker";
import { evaluateSlo, type BreakerHistoryInput, type SloReport } from "./sloEvaluator";
import { resolveSloSettings } from "./sloSettings";

const OPEN_BREAKER_LABEL_CAP = 64;

interface QuotaMonitorView {
  active: number;
  alerting: number;
  exhausted: number;
  errors: number;
  statusCounts: Record<string, number>;
}

export interface MetricsSnapshot {
  generatedAt: number;
  uptimeSeconds: number;
  window: RoutingMetricsWindow;
  slo: SloReport;
  breakersByState: Record<string, number>;
  openProviders: string[];
  quota: QuotaMonitorView;
}

function summarizeBreakers(breakers: ReadonlyArray<BreakerHistoryInput>) {
  const byState: Record<string, number> = { CLOSED: 0, DEGRADED: 0, OPEN: 0, HALF_OPEN: 0 };
  const labels = new BoundedLabelSet(OPEN_BREAKER_LABEL_CAP);
  const open = new Set<string>();
  for (const breaker of breakers) {
    if (breaker.state in byState) byState[breaker.state] += 1;
    if (breaker.state === "OPEN") open.add(labels.resolve(breaker.name));
  }
  return { byState, openProviders: [...open] };
}

async function readQuotaMonitor(): Promise<QuotaMonitorView> {
  const { getQuotaMonitorSummary } = await import("@omniroute/open-sse/services/quotaMonitor.ts");
  const summary = getQuotaMonitorSummary();
  return {
    active: summary.active,
    alerting: summary.alerting,
    exhausted: summary.exhausted,
    errors: summary.errors,
    statusCounts: { ...summary.statusCounts },
  };
}

export async function collectMetricsSnapshot(now = Date.now()): Promise<MetricsSnapshot> {
  const settings = resolveSloSettings((await getCachedSettings()).slo);
  const breakers = getAllCircuitBreakerStatuses();
  const window = routingMetrics.window(settings.windowMinutes * 60_000);
  const { byState, openProviders } = summarizeBreakers(breakers);
  return {
    generatedAt: now,
    uptimeSeconds: Math.round(process.uptime()),
    window,
    slo: evaluateSlo(settings, window, breakers, now),
    breakersByState: byState,
    openProviders,
    quota: await readQuotaMonitor(),
  };
}

function recordSeries(record: Record<string, number>, labelName: string) {
  return Object.entries(record).map(([key, value]) => ({ labels: { [labelName]: key }, value }));
}

function sloGauges(report: SloReport): GaugeFamily[] {
  const evaluated = report.objectives.filter((o) => o.value !== null);
  return [
    {
      name: "omniroute_slo_objective_value",
      help: "Current SLO objective value over the SLO window (ratio or milliseconds).",
      series: evaluated.map((o) => ({ labels: { objective: o.objective }, value: o.value ?? 0 })),
    },
    {
      name: "omniroute_slo_objective_threshold",
      help: "Configured SLO objective threshold (ratio or milliseconds).",
      series: report.objectives.map((o) => ({
        labels: { objective: o.objective },
        value: o.threshold,
      })),
    },
    {
      name: "omniroute_slo_objective_breached",
      help: "1 when the SLO objective is breached, 0 otherwise (insufficient data = 0).",
      series: report.objectives.map((o) => ({
        labels: { objective: o.objective },
        value: o.status === "breached" ? 1 : 0,
      })),
    },
  ];
}

function scrapeGauges(snapshot: MetricsSnapshot): GaugeFamily[] {
  return [
    {
      name: "omniroute_process_uptime_seconds",
      help: "Process uptime in seconds.",
      series: [{ labels: {}, value: snapshot.uptimeSeconds }],
    },
    {
      name: "omniroute_circuit_breakers",
      help: "Circuit breakers by state.",
      series: recordSeries(snapshot.breakersByState, "state"),
    },
    {
      name: "omniroute_circuit_breaker_open",
      help: "1 for each provider whose circuit breaker is OPEN.",
      series: snapshot.openProviders.map((provider) => ({ labels: { provider }, value: 1 })),
    },
    {
      name: "omniroute_quota_monitors",
      help: "Active quota monitors by status.",
      series: recordSeries(snapshot.quota.statusCounts, "status"),
    },
    ...sloGauges(snapshot.slo),
  ];
}

export function renderMetricsText(snapshot: MetricsSnapshot): string {
  return renderPrometheusText({
    counters: routingMetrics.counterFamilies(),
    histograms: routingMetrics.histogramFamilies(),
    gauges: scrapeGauges(snapshot),
  });
}

export function buildMetricsJson(snapshot: MetricsSnapshot) {
  const totals = routingMetrics.totals();
  const byOutcome = totals.byOutcome;
  const neutral = (byOutcome.cancelled ?? 0) + (byOutcome.guardrail_blocked ?? 0);
  const success = byOutcome.success ?? 0;
  return {
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    uptimeSeconds: snapshot.uptimeSeconds,
    totals: {
      ...totals,
      success,
      failed: Math.max(0, totals.requests - success - neutral),
      rateLimited: byOutcome.rate_limited ?? 0,
      timeouts: byOutcome.timeout ?? 0,
    },
    window: snapshot.window,
    slo: snapshot.slo,
    circuitBreakers: { byState: snapshot.breakersByState, openProviders: snapshot.openProviders },
    quotaMonitor: snapshot.quota,
  };
}
