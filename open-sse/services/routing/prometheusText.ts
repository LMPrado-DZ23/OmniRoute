/**
 * Minimal Prometheus text exposition (format 0.0.4) renderer — no dependency.
 * Renders counter, gauge and histogram families produced by metricsSink.ts and
 * the scrape-time gauges added by src/lib/monitoring/metricsExposition.ts.
 */

import type { CounterFamily, HistogramFamily, MetricSeries } from "./metricsSink.ts";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface GaugeFamily {
  name: string;
  help: string;
  series: MetricSeries[];
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

function renderSimple(family: CounterFamily | GaugeFamily, type: "counter" | "gauge"): string[] {
  const lines = [
    `# HELP ${family.name} ${escapeHelp(family.help)}`,
    `# TYPE ${family.name} ${type}`,
  ];
  for (const series of family.series) {
    lines.push(`${family.name}${formatLabels(series.labels)} ${formatNumber(series.value)}`);
  }
  return lines;
}

function renderHistogram(family: HistogramFamily): string[] {
  const lines = [
    `# HELP ${family.name} ${escapeHelp(family.help)}`,
    `# TYPE ${family.name} histogram`,
  ];
  for (const { labels, snapshot } of family.series) {
    let cumulative = 0;
    snapshot.bounds.forEach((bound, i) => {
      cumulative += snapshot.counts[i] ?? 0;
      const le = formatLabels({ ...labels, le: String(bound) });
      lines.push(`${family.name}_bucket${le} ${cumulative}`);
    });
    lines.push(`${family.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${snapshot.count}`);
    lines.push(`${family.name}_sum${formatLabels(labels)} ${formatNumber(snapshot.sum)}`);
    lines.push(`${family.name}_count${formatLabels(labels)} ${snapshot.count}`);
  }
  return lines;
}

export function renderPrometheusText(input: {
  counters: CounterFamily[];
  histograms: HistogramFamily[];
  gauges: GaugeFamily[];
}): string {
  const lines: string[] = [];
  for (const family of input.counters) lines.push(...renderSimple(family, "counter"));
  for (const family of input.histograms) lines.push(...renderHistogram(family));
  for (const family of input.gauges) lines.push(...renderSimple(family, "gauge"));
  return `${lines.join("\n")}\n`;
}
