/**
 * tests/unit/routing-metrics-sink.test.ts
 *
 * Phase 5 observability — routing metrics registry (open-sse/services/routing/metricsSink.ts):
 *  - outcome / token / cost / attempt counters with bounded labels
 *  - cardinality: 10k distinct models/providers never create 10k series
 *  - label policy: API keys, connection ids, e-mails, UUIDs never reach a label
 *  - fixed-bucket histograms + sliding window percentiles
 *  - combo failover + compression side channels
 *  - Prometheus text rendering
 *  - quality tracker Map cap
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRoutingEvent, type RoutingEvent } from "../../open-sse/services/routing/events.ts";
import { RoutingMetricsRegistry } from "../../open-sse/services/routing/metricsSink.ts";
import {
  BoundedLabelSet,
  OTHER_LABEL_VALUE,
  sanitizeLabelValue,
  statusClassOf,
} from "../../open-sse/services/routing/metricLabels.ts";
import {
  FixedHistogram,
  LATENCY_BUCKETS_MS,
  estimateQuantile,
} from "../../open-sse/services/routing/metricsHistogram.ts";
import { renderPrometheusText } from "../../open-sse/services/routing/prometheusText.ts";
import {
  QUALITY_WELL_KNOWN,
  getQualitySnapshot,
  recordQualityEvent,
  resetQualityTracker,
} from "../../open-sse/services/routing/quality.ts";
import {
  emitRoutingEvent,
  initRoutingObservability,
  resetRoutingObservability,
} from "../../open-sse/services/routing/index.ts";
import { routingMetrics } from "../../open-sse/services/routing/metricsSink.ts";

function event(partial: Partial<RoutingEvent> = {}): RoutingEvent {
  return createRoutingEvent({
    requestId: "req-1",
    provider: "openai",
    model: "gpt-4o",
    strategy: "direct",
    latencyMs: 400,
    outcome: "success",
    status: 200,
    ...partial,
  });
}

function render(registry: RoutingMetricsRegistry): string {
  return renderPrometheusText({
    counters: registry.counterFamilies(),
    histograms: registry.histogramFamilies(),
    gauges: [],
  });
}

function familySeries(registry: RoutingMetricsRegistry, name: string) {
  const family = registry.counterFamilies().find((f) => f.name === name);
  assert.ok(family, `missing family ${name}`);
  return family.series;
}

test("counts outcomes, tokens, cost and attempts by bounded labels", () => {
  const registry = new RoutingMetricsRegistry();
  registry.record(event({ inputTokens: 100, outputTokens: 20, cost: 0.5 }));
  registry.record(event({ outcome: "rate_limited", status: 429 }));
  registry.record(event({ outcome: "timeout", status: 504, provider: "anthropic", retries: 2 }));

  const totals = registry.totals();
  assert.equal(totals.requests, 3);
  assert.equal(totals.byOutcome.success, 1);
  assert.equal(totals.byOutcome.rate_limited, 1);
  assert.equal(totals.byOutcome.timeout, 1);
  assert.deepEqual(totals.tokens, { input: 100, output: 20 });
  assert.equal(totals.estimatedCostUsd, 0.5);
  assert.equal(totals.attempts, 3);
  assert.equal(totals.retries, 2);
  assert.deepEqual(totals.errorsByProvider, { openai: 1, anthropic: 1 });
  assert.deepEqual(totals.errorsByModel, { "gpt-4o": 2 });

  const statusClasses = familySeries(registry, "omniroute_requests_by_status_class_total");
  const byClass = Object.fromEntries(statusClasses.map((s) => [s.labels.status_class, s.value]));
  assert.deepEqual(byClass, { "2xx": 1, "4xx": 1, "5xx": 1 });
});

test("cardinality: 10k distinct models and providers stay within the label caps", () => {
  const registry = new RoutingMetricsRegistry();
  for (let i = 0; i < 10_000; i++) {
    registry.record(event({ model: `model-${i}`, provider: `provider-${i}`, strategy: `s-${i}` }));
  }
  const models = new Set(
    familySeries(registry, "omniroute_model_requests_total").map((s) => s.labels.model)
  );
  const providers = new Set(
    familySeries(registry, "omniroute_requests_total").map((s) => s.labels.provider)
  );
  const strategies = new Set(
    familySeries(registry, "omniroute_strategy_requests_total").map((s) => s.labels.strategy)
  );
  assert.ok(models.size <= 101, `model series ${models.size}`);
  assert.ok(providers.size <= 65, `provider series ${providers.size}`);
  assert.ok(strategies.size <= 17, `strategy series ${strategies.size}`);
  assert.ok(models.has(OTHER_LABEL_VALUE));
  const latency = registry
    .histogramFamilies()
    .find((f) => f.name === "omniroute_request_latency_ms");
  assert.ok(latency && latency.series.length <= 65);
  // Totals are still exact — only the label dimension collapses.
  assert.equal(registry.totals().requests, 10_000);
});

test("label policy: secrets, connection ids, e-mails and UUIDs never become label values", () => {
  const registry = new RoutingMetricsRegistry();
  const apiKey = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const connectionId = "123e4567-e89b-12d3-a456-426614174000";
  registry.record(
    event({
      provider: apiKey,
      model: `accounts/${connectionId}/model`,
      strategy: "someone@example.com",
      connectionId,
      requestId: "prompt: tell me a secret",
    })
  );
  const text = render(registry);
  assert.equal(text.includes(apiKey), false);
  assert.equal(text.includes(connectionId), false);
  assert.equal(text.includes("someone@example.com"), false);
  assert.equal(text.includes("tell me a secret"), false);
  assert.ok(text.includes('provider="redacted"'));
  assert.ok(text.includes('model="redacted"'));

  assert.equal(sanitizeLabelValue("ghp_0123456789abcdef"), "redacted");
  assert.equal(sanitizeLabelValue("a".repeat(40)), "redacted");
  assert.equal(sanitizeLabelValue("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(sanitizeLabelValue('bad"label\nvalue'), "bad_label_value");
  assert.equal(sanitizeLabelValue(""), "unknown");
  assert.equal(sanitizeLabelValue(null), "unknown");
  assert.equal(statusClassOf(503), "5xx");
  assert.equal(statusClassOf(null), "none");
  assert.equal(statusClassOf(99), "none");
});

test("BoundedLabelSet keeps first N values and collapses the rest", () => {
  const set = new BoundedLabelSet(2);
  assert.equal(set.resolve("a"), "a");
  assert.equal(set.resolve("b"), "b");
  assert.equal(set.resolve("c"), OTHER_LABEL_VALUE);
  assert.equal(set.resolve("a"), "a");
  assert.equal(set.size, 2);
});

test("junk model ids from failed requests do not crowd real models out of the label cap", () => {
  const registry = new RoutingMetricsRegistry();
  for (let i = 0; i < 500; i++) {
    registry.record(event({ model: `junk-${i}`, outcome: "error", status: 404 }));
  }
  for (let i = 0; i < 500; i++) {
    registry.record(event({ model: `sk-proj-${"x".repeat(12)}${i}` }));
  }
  registry.record(event({ model: "claude-opus-4-7" }));
  registry.record(event({ model: "claude-opus-4-7", outcome: "error", status: 500 }));

  const models = new Set(
    familySeries(registry, "omniroute_model_requests_total").map((s) => s.labels.model)
  );
  assert.ok(models.has("claude-opus-4-7"), "a real model keeps its own label");
  assert.ok(models.has(OTHER_LABEL_VALUE), "failed junk ids collapse into other");
  assert.ok(models.has("redacted"));
  assert.equal(
    [...models].some((model) => model.startsWith("junk-")),
    false,
    "a failed request never admits a new model label"
  );
  assert.equal(registry.totals().requests, 1002);
});

test("BoundedLabelSet: fixed values take no slot and admit=false never adds", () => {
  const set = new BoundedLabelSet(1);
  assert.equal(set.resolve("sk-proj-abcdefghijklmnop"), "redacted");
  assert.equal(set.resolve(""), "unknown");
  assert.equal(set.size, 0);
  assert.equal(set.resolve("junk", false), OTHER_LABEL_VALUE);
  assert.equal(set.size, 0);
  assert.equal(set.resolve("real"), "real");
  assert.equal(set.resolve("real", false), "real", "a tracked value still resolves");
  assert.equal(set.resolve("sk-proj-abcdefghijklmnop"), "redacted", "fixed values bypass the cap");
});

test("histogram quantiles interpolate inside the matching bucket", () => {
  const hist = new FixedHistogram([100, 200, 400]);
  for (let i = 0; i < 90; i++) hist.observe(50);
  for (let i = 0; i < 10; i++) hist.observe(300);
  hist.observe(-1); // ignored
  hist.observe(Number.NaN); // ignored
  const snap = hist.snapshot();
  assert.equal(snap.count, 100);
  assert.equal(estimateQuantile(snap, 0.5), 56);
  assert.equal(estimateQuantile(snap, 0.95), 300);
  assert.equal(estimateQuantile(new FixedHistogram([1]).snapshot(), 0.5), null);
  const inf = new FixedHistogram([10]);
  inf.observe(1000);
  assert.equal(estimateQuantile(inf.snapshot(), 0.99), 10);
});

test("sliding window aggregates recent minutes only and computes percentiles", () => {
  let now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const registry = new RoutingMetricsRegistry(() => now);
  registry.record(event({ outcome: "error", status: 500, latencyMs: 90_000 }));
  now += 20 * 60_000;
  for (let i = 0; i < 9; i++) registry.record(event({ latencyMs: 300, ttftMs: 80 }));
  registry.record(event({ outcome: "cancelled", status: null, latencyMs: 300 }));

  const window = registry.window(15 * 60_000);
  assert.equal(window.windowMs, 15 * 60_000);
  assert.equal(window.total, 10);
  assert.equal(window.success, 9);
  assert.equal(window.failed, 0, "cancelled is neutral; the old error fell out of the window");
  assert.equal(window.latency.count, 10);
  assert.ok((window.latency.p95 ?? 0) <= 500);
  assert.equal(window.ttft.count, 9);

  const wide = registry.window(60 * 60_000);
  assert.equal(wide.failed, 1);
  assert.ok((wide.latency.p99 ?? 0) > 60_000);
  // windowMs is clamped to the 60-minute ring.
  assert.equal(registry.window(10 * 60 * 60_000).windowMs, 60 * 60_000);
});

test("combo failover and compression side channels feed counters and the window", () => {
  const registry = new RoutingMetricsRegistry();
  registry.recordCombo({ strategy: "priority", success: true, fallbackCount: 0 });
  registry.recordCombo({ strategy: "priority", success: true, fallbackCount: 2 });
  registry.recordCombo({ strategy: "priority", success: false, fallbackCount: 3 });
  registry.recordCompression({ engine: "caveman", tokensSaved: 120, estimatedUsdSaved: 0.01 });
  registry.recordCompression({ engine: null, tokensSaved: null, estimatedUsdSaved: null });

  const window = registry.window(60_000);
  assert.equal(window.comboFailoverRequests, 2);
  assert.equal(window.comboFailoverSuccesses, 1);
  const totals = registry.totals();
  assert.equal(totals.comboFallbacks, 5);
  assert.equal(totals.compression.applied, 2);
  assert.equal(totals.compression.tokensSaved, 120);
  assert.equal(totals.compression.estimatedUsdSaved, 0.01);
  const failovers = familySeries(registry, "omniroute_combo_failover_requests_total");
  assert.equal(failovers.length, 2);
});

test("Prometheus rendering emits HELP/TYPE, cumulative buckets and escaped labels", () => {
  const registry = new RoutingMetricsRegistry();
  registry.record(event({ latencyMs: 75 }));
  registry.record(event({ latencyMs: 700 }));
  const text = render(registry);
  assert.ok(text.includes("# TYPE omniroute_requests_total counter"));
  assert.ok(text.includes('omniroute_requests_total{provider="openai",outcome="success"} 2'));
  assert.ok(text.includes("# TYPE omniroute_request_latency_ms histogram"));
  assert.ok(text.includes('omniroute_request_latency_ms_bucket{provider="openai",le="100"} 1'));
  assert.ok(text.includes('omniroute_request_latency_ms_bucket{provider="openai",le="1000"} 2'));
  assert.ok(text.includes('omniroute_request_latency_ms_bucket{provider="openai",le="+Inf"} 2'));
  assert.ok(text.includes('omniroute_request_latency_ms_count{provider="openai"} 2'));
  assert.equal(LATENCY_BUCKETS_MS.length > 0, true);

  const gaugeText = renderPrometheusText({
    counters: [],
    histograms: [],
    gauges: [{ name: "g", help: "h", series: [{ labels: { k: 'a"b\\c' }, value: 1 }] }],
  });
  assert.ok(gaugeText.includes('g{k="a\\"b\\\\c"} 1'));

  // A raw CR or LF inside a label value would end the exposition line early and let the rest be
  // read as a fabricated metric, so both must leave the value as an escape sequence.
  const controlText = renderPrometheusText({
    counters: [],
    histograms: [],
    gauges: [{ name: "g", help: "h", series: [{ labels: { k: "a\r\nb" }, value: 1 }] }],
  });
  assert.ok(controlText.includes('g{k="a\\r\\nb"} 1'));
  assert.equal(controlText.includes("\r"), false, "no raw CR survives into the exposition");
  assert.equal(
    controlText.split("\n").some((line) => line.trim() === 'b"} 1'),
    false,
    "the label value cannot break out onto its own line"
  );
});

test("registry reset clears counters, histograms and window", () => {
  const registry = new RoutingMetricsRegistry();
  registry.record(event());
  registry.reset();
  assert.equal(registry.totals().requests, 0);
  assert.equal(registry.window(60_000).total, 0);
  assert.equal(registry.histogramFamilies()[0].series.length, 0);
});

test("initRoutingObservability registers the metrics sink and emit feeds the shared registry", () => {
  resetRoutingObservability();
  const { sinks } = initRoutingObservability({});
  assert.ok(sinks.includes("metrics"));
  emitRoutingEvent(event({ provider: "gemini" }));
  assert.equal(routingMetrics.totals().requests, 1);
  resetRoutingObservability();
  assert.equal(routingMetrics.totals().requests, 0);
});

test("quality tracker Map is capped: 10k distinct models evict the least recently updated", () => {
  resetQualityTracker();
  const cap = QUALITY_WELL_KNOWN.MAX_TRACKED_KEYS;
  for (let i = 0; i < 10_000; i++) {
    recordQualityEvent({
      provider: "p",
      model: `m-${i}`,
      outcome: "success",
      status: 200,
      latencyMs: 10,
      ts: i,
    });
  }
  const snapshot = getQualitySnapshot(Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.length, cap);
  const models = new Set(snapshot.map((q) => q.model));
  assert.ok(models.has("m-9999"));
  assert.equal(models.has("m-0"), false);
  resetQualityTracker();
});
