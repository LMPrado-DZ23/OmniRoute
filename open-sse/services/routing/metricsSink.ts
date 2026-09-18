/**
 * Routing metrics sink — in-process counters, fixed-bucket histograms and a
 * one-minute sliding window, fed by `RoutingEvent`s plus two side channels
 * (combo outcomes from comboMetrics.recordComboRequest and compression rows
 * from compressionAnalytics.insertCompressionAnalyticsRow).
 *
 * Exposed as Prometheus text / JSON by GET /api/metrics and consumed by the SLO
 * evaluator (src/lib/monitoring/sloEvaluator.ts).
 *
 * SAFETY: labels go through metricLabels.ts (allowlisted names, capped values,
 * secret-looking values redacted). Connection ids, request ids, finish reasons,
 * prompts and responses are never used as labels. `record()` is O(labels) with
 * no I/O, so it is safe on the request hot path.
 */

import { ROUTING_OUTCOMES, type RoutingEvent, type RoutingOutcome } from "./events.ts";
import { BoundedLabelSet, statusClassOf } from "./metricLabels.ts";
import {
  FixedHistogram,
  LATENCY_BUCKETS_MS,
  TTFT_BUCKETS_MS,
  estimateQuantile,
  type HistogramSnapshot,
} from "./metricsHistogram.ts";

const PROVIDER_LABEL_CAP = 64;
const MODEL_LABEL_CAP = 100;
const STRATEGY_LABEL_CAP = 16;
const ENGINE_LABEL_CAP = 16;
/** Defence in depth: a single metric family never exceeds this many series. */
const MAX_SERIES_PER_FAMILY = 2000;
const WINDOW_SLOT_MS = 60_000;
/** Sliding window length (slots). SLO windows are clamped to this. */
export const METRICS_WINDOW_MAX_MINUTES = 60;

/** Outcomes that are not counted against availability / error rate. */
const NEUTRAL_OUTCOMES: ReadonlySet<RoutingOutcome> = new Set(["cancelled", "guardrail_blocked"]);

export interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

export interface CounterFamily {
  name: string;
  help: string;
  series: MetricSeries[];
}

export interface HistogramFamily {
  name: string;
  help: string;
  series: Array<{ labels: Record<string, string>; snapshot: HistogramSnapshot }>;
}

class LabeledCounter {
  private readonly values = new Map<string, MetricSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[]
  ) {}

  inc(labelValues: readonly string[], by = 1): void {
    if (!Number.isFinite(by) || by <= 0) return;
    const key = labelValues.join("|");
    let series = this.values.get(key);
    if (!series) {
      if (this.values.size >= MAX_SERIES_PER_FAMILY) return;
      const labels: Record<string, string> = {};
      this.labelNames.forEach((labelName, i) => {
        labels[labelName] = labelValues[i] ?? "unknown";
      });
      series = { labels, value: 0 };
      this.values.set(key, series);
    }
    series.value += by;
  }

  family(): CounterFamily {
    return {
      name: this.name,
      help: this.help,
      series: Array.from(this.values.values(), (s) => ({
        labels: { ...s.labels },
        value: s.value,
      })),
    };
  }

  sumBy(labelName: string, filter?: (labels: Record<string, string>) => boolean) {
    const out: Record<string, number> = {};
    for (const series of this.values.values()) {
      if (filter && !filter(series.labels)) continue;
      const key = series.labels[labelName] ?? "unknown";
      out[key] = (out[key] ?? 0) + series.value;
    }
    return out;
  }

  clear(): void {
    this.values.clear();
  }
}

class LabeledHistogram {
  private readonly byLabel = new Map<string, FixedHistogram>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: readonly number[]
  ) {}

  observe(provider: string, value: number): void {
    let hist = this.byLabel.get(provider);
    if (!hist) {
      if (this.byLabel.size >= MAX_SERIES_PER_FAMILY) return;
      hist = new FixedHistogram(this.bounds);
      this.byLabel.set(provider, hist);
    }
    hist.observe(value);
  }

  family(): HistogramFamily {
    return {
      name: this.name,
      help: this.help,
      series: Array.from(this.byLabel.entries(), ([provider, hist]) => ({
        labels: { provider },
        snapshot: hist.snapshot(),
      })),
    };
  }

  clear(): void {
    this.byLabel.clear();
  }
}

interface WindowSlot {
  minute: number;
  outcomes: Record<RoutingOutcome, number>;
  latency: FixedHistogram;
  ttft: FixedHistogram;
  comboFailoverRequests: number;
  comboFailoverSuccesses: number;
}

function emptyOutcomes(): Record<RoutingOutcome, number> {
  const out = {} as Record<RoutingOutcome, number>;
  for (const outcome of ROUTING_OUTCOMES) out[outcome] = 0;
  return out;
}

function createSlot(minute: number): WindowSlot {
  return {
    minute,
    outcomes: emptyOutcomes(),
    latency: new FixedHistogram(LATENCY_BUCKETS_MS),
    ttft: new FixedHistogram(TTFT_BUCKETS_MS),
    comboFailoverRequests: 0,
    comboFailoverSuccesses: 0,
  };
}

export interface QuantileSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface RoutingMetricsWindow {
  windowMs: number;
  total: number;
  success: number;
  /** Non-success outcomes excluding cancelled / guardrail_blocked. */
  failed: number;
  outcomes: Record<RoutingOutcome, number>;
  latency: QuantileSummary;
  ttft: QuantileSummary;
  comboFailoverRequests: number;
  comboFailoverSuccesses: number;
}

function quantiles(snapshot: HistogramSnapshot): QuantileSummary {
  return {
    count: snapshot.count,
    p50: estimateQuantile(snapshot, 0.5),
    p95: estimateQuantile(snapshot, 0.95),
    p99: estimateQuantile(snapshot, 0.99),
  };
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export interface ComboOutcomeInput {
  strategy: string | null | undefined;
  success: boolean;
  fallbackCount: number;
}

export interface CompressionOutcomeInput {
  engine: string | null | undefined;
  tokensSaved: number | null | undefined;
  estimatedUsdSaved: number | null | undefined;
}

export class RoutingMetricsRegistry {
  readonly name = "metrics";
  private readonly providers = new BoundedLabelSet(PROVIDER_LABEL_CAP);
  private readonly models = new BoundedLabelSet(MODEL_LABEL_CAP);
  private readonly strategies = new BoundedLabelSet(STRATEGY_LABEL_CAP);
  private readonly engines = new BoundedLabelSet(ENGINE_LABEL_CAP);
  private slots: WindowSlot[] = [];

  private readonly requests = new LabeledCounter(
    "omniroute_requests_total",
    "Upstream routing outcomes by provider.",
    ["provider", "outcome"]
  );
  private readonly modelRequests = new LabeledCounter(
    "omniroute_model_requests_total",
    "Upstream routing outcomes by model (top-N models, rest collapsed into other).",
    ["model", "outcome"]
  );
  private readonly statusClasses = new LabeledCounter(
    "omniroute_requests_by_status_class_total",
    "Upstream routing outcomes by HTTP status class.",
    ["status_class"]
  );
  private readonly strategyRequests = new LabeledCounter(
    "omniroute_strategy_requests_total",
    "Upstream routing outcomes by routing strategy (direct or combo strategy).",
    ["strategy", "outcome"]
  );
  private readonly tokens = new LabeledCounter(
    "omniroute_tokens_total",
    "Tokens reported by upstream usage, by provider and direction.",
    ["provider", "direction"]
  );
  private readonly cost = new LabeledCounter(
    "omniroute_estimated_cost_usd_total",
    "Estimated upstream cost in USD (non-streaming successes carry a cost estimate).",
    ["provider"]
  );
  private readonly attempts = new LabeledCounter(
    "omniroute_upstream_attempts_total",
    "Upstream attempts (one per routing event), by provider.",
    ["provider"]
  );
  private readonly retries = new LabeledCounter(
    "omniroute_upstream_retries_total",
    "Retries reported on routing events, by provider.",
    ["provider"]
  );
  private readonly comboRequests = new LabeledCounter(
    "omniroute_combo_requests_total",
    "Combo requests by strategy and final outcome.",
    ["strategy", "outcome"]
  );
  private readonly comboFallbacks = new LabeledCounter(
    "omniroute_combo_fallbacks_total",
    "Fallbacks to a later combo target, by strategy.",
    ["strategy"]
  );
  private readonly comboFailovers = new LabeledCounter(
    "omniroute_combo_failover_requests_total",
    "Combo requests that needed at least one fallback, by strategy and final outcome.",
    ["strategy", "outcome"]
  );
  private readonly compressionApplied = new LabeledCounter(
    "omniroute_compression_applied_total",
    "Compression runs that recorded a result, by engine.",
    ["engine"]
  );
  private readonly compressionTokensSaved = new LabeledCounter(
    "omniroute_compression_tokens_saved_total",
    "Estimated prompt tokens saved by compression, by engine.",
    ["engine"]
  );
  private readonly compressionUsdSaved = new LabeledCounter(
    "omniroute_compression_estimated_usd_saved_total",
    "Estimated USD saved by compression, by engine.",
    ["engine"]
  );
  private readonly latency = new LabeledHistogram(
    "omniroute_request_latency_ms",
    "End-to-end upstream request latency in milliseconds, by provider.",
    LATENCY_BUCKETS_MS
  );
  private readonly ttft = new LabeledHistogram(
    "omniroute_ttft_ms",
    "Time to first forwarded stream chunk in milliseconds (streaming only), by provider.",
    TTFT_BUCKETS_MS
  );

  constructor(private readonly now: () => number = Date.now) {}

  /** RoutingEventSink entry point. */
  record(event: RoutingEvent): void {
    const provider = this.providers.resolve(event.provider);
    const outcome = event.outcome;
    this.requests.inc([provider, outcome]);
    this.modelRequests.inc([this.models.resolve(event.model), outcome]);
    this.statusClasses.inc([statusClassOf(event.status)]);
    this.strategyRequests.inc([this.strategies.resolve(event.strategy), outcome]);
    this.attempts.inc([provider]);
    this.retries.inc([provider], event.retries);
    this.tokens.inc([provider, "input"], finiteNonNegative(event.inputTokens) ?? 0);
    this.tokens.inc([provider, "output"], finiteNonNegative(event.outputTokens) ?? 0);
    this.cost.inc([provider], finiteNonNegative(event.cost) ?? 0);

    const slot = this.currentSlot();
    slot.outcomes[outcome] += 1;
    const latency = finiteNonNegative(event.latencyMs);
    if (latency !== null) {
      this.latency.observe(provider, latency);
      slot.latency.observe(latency);
    }
    const ttft = finiteNonNegative(event.ttftMs);
    if (ttft !== null) {
      this.ttft.observe(provider, ttft);
      slot.ttft.observe(ttft);
    }
  }

  /** Combo-level outcome (single chokepoint: comboMetrics.recordComboRequest). */
  recordCombo(input: ComboOutcomeInput): void {
    const strategy = this.strategies.resolve(input.strategy ?? "combo");
    const outcome = input.success ? "success" : "failure";
    const fallbacks = Math.max(0, Math.floor(Number(input.fallbackCount) || 0));
    this.comboRequests.inc([strategy, outcome]);
    this.comboFallbacks.inc([strategy], fallbacks);
    if (fallbacks === 0) return;
    this.comboFailovers.inc([strategy, outcome]);
    const slot = this.currentSlot();
    slot.comboFailoverRequests += 1;
    if (input.success) slot.comboFailoverSuccesses += 1;
  }

  /** Compression result (single chokepoint: insertCompressionAnalyticsRow). */
  recordCompression(input: CompressionOutcomeInput): void {
    const engine = this.engines.resolve(input.engine ?? "unknown");
    this.compressionApplied.inc([engine]);
    this.compressionTokensSaved.inc([engine], finiteNonNegative(input.tokensSaved) ?? 0);
    this.compressionUsdSaved.inc([engine], finiteNonNegative(input.estimatedUsdSaved) ?? 0);
  }

  counterFamilies(): CounterFamily[] {
    return [
      this.requests,
      this.modelRequests,
      this.statusClasses,
      this.strategyRequests,
      this.tokens,
      this.cost,
      this.attempts,
      this.retries,
      this.comboRequests,
      this.comboFallbacks,
      this.comboFailovers,
      this.compressionApplied,
      this.compressionTokensSaved,
      this.compressionUsdSaved,
    ].map((counter) => counter.family());
  }

  histogramFamilies(): HistogramFamily[] {
    return [this.latency.family(), this.ttft.family()];
  }

  /** Aggregate the last `windowMs` (clamped to 1..60 minutes) of routing outcomes. */
  window(windowMs: number): RoutingMetricsWindow {
    const minutes = Math.min(
      METRICS_WINDOW_MAX_MINUTES,
      Math.max(1, Math.ceil((Number(windowMs) || WINDOW_SLOT_MS) / WINDOW_SLOT_MS))
    );
    const currentMinute = Math.floor(this.now() / WINDOW_SLOT_MS);
    const acc = createSlot(currentMinute);
    for (const slot of this.slots) {
      if (!slot || currentMinute - slot.minute >= minutes || slot.minute > currentMinute) continue;
      for (const outcome of ROUTING_OUTCOMES) acc.outcomes[outcome] += slot.outcomes[outcome];
      acc.latency.merge(slot.latency.snapshot());
      acc.ttft.merge(slot.ttft.snapshot());
      acc.comboFailoverRequests += slot.comboFailoverRequests;
      acc.comboFailoverSuccesses += slot.comboFailoverSuccesses;
    }
    return summarizeSlot(acc, minutes * WINDOW_SLOT_MS);
  }

  /** Lifetime totals used by the JSON summary. */
  totals() {
    const byOutcome = this.requests.sumBy("outcome");
    const tokens = this.tokens.sumBy("direction");
    const failedFilter = (labels: Record<string, string>) =>
      labels.outcome !== "success" && !NEUTRAL_OUTCOMES.has(labels.outcome as RoutingOutcome);
    return {
      requests: sumValues(byOutcome),
      byOutcome,
      tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0 },
      estimatedCostUsd: sumValues(this.cost.sumBy("provider")),
      attempts: sumValues(this.attempts.sumBy("provider")),
      retries: sumValues(this.retries.sumBy("provider")),
      comboFallbacks: sumValues(this.comboFallbacks.sumBy("strategy")),
      errorsByProvider: this.requests.sumBy("provider", failedFilter),
      errorsByModel: this.modelRequests.sumBy("model", failedFilter),
      compression: {
        applied: sumValues(this.compressionApplied.sumBy("engine")),
        tokensSaved: sumValues(this.compressionTokensSaved.sumBy("engine")),
        estimatedUsdSaved: sumValues(this.compressionUsdSaved.sumBy("engine")),
      },
    };
  }

  reset(): void {
    for (const labels of [this.providers, this.models, this.strategies, this.engines]) {
      labels.clear();
    }
    for (const counter of [
      this.requests,
      this.modelRequests,
      this.statusClasses,
      this.strategyRequests,
      this.tokens,
      this.cost,
      this.attempts,
      this.retries,
      this.comboRequests,
      this.comboFallbacks,
      this.comboFailovers,
      this.compressionApplied,
      this.compressionTokensSaved,
      this.compressionUsdSaved,
    ]) {
      counter.clear();
    }
    this.latency.clear();
    this.ttft.clear();
    this.slots = [];
  }

  private currentSlot(): WindowSlot {
    const minute = Math.floor(this.now() / WINDOW_SLOT_MS);
    const idx = minute % METRICS_WINDOW_MAX_MINUTES;
    let slot = this.slots[idx];
    if (!slot || slot.minute !== minute) {
      slot = createSlot(minute);
      this.slots[idx] = slot;
    }
    return slot;
  }
}

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

function summarizeSlot(slot: WindowSlot, windowMs: number): RoutingMetricsWindow {
  const total = sumValues(slot.outcomes);
  const success = slot.outcomes.success;
  let neutral = 0;
  for (const outcome of NEUTRAL_OUTCOMES) neutral += slot.outcomes[outcome];
  return {
    windowMs,
    total,
    success,
    failed: Math.max(0, total - success - neutral),
    outcomes: { ...slot.outcomes },
    latency: quantiles(slot.latency.snapshot()),
    ttft: quantiles(slot.ttft.snapshot()),
    comboFailoverRequests: slot.comboFailoverRequests,
    comboFailoverSuccesses: slot.comboFailoverSuccesses,
  };
}

/** Process-wide registry shared by the routing sink, combo/compression hooks and /api/metrics. */
export const routingMetrics = new RoutingMetricsRegistry();
