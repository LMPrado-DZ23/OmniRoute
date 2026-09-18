/**
 * tests/unit/slo-evaluator.test.ts
 *
 * Phase 5 SLOs: settings resolution, objective evaluation, provider recovery
 * time from circuit-breaker transition history, and deduplicated alert
 * transitions (slo.breached / slo.recovered / provider.circuit_open).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RoutingMetricsRegistry } from "../../open-sse/services/routing/metricsSink.ts";
import { createRoutingEvent } from "../../open-sse/services/routing/events.ts";
import { resolveSloSettings } from "../../src/lib/monitoring/sloSettings.ts";
import {
  computeProviderRecovery,
  evaluateSlo,
  type BreakerHistoryInput,
} from "../../src/lib/monitoring/sloEvaluator.ts";
import { SloAlertRunner, SloAlertTracker } from "../../src/lib/monitoring/sloAlerts.ts";
import { sloSettingsSchema } from "../../src/shared/validation/schemas/slo.ts";
import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";
import { WEBHOOK_EVENT_VALUES } from "../../src/lib/webhooks/eventDescriptions.ts";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function windowWith(
  success: number,
  errors: number,
  latencyMs = 500,
  failover?: { requests: number; successes: number }
) {
  const registry = new RoutingMetricsRegistry(() => NOW);
  for (let i = 0; i < success; i++) {
    registry.record(
      createRoutingEvent({
        requestId: "r",
        provider: "openai",
        model: "gpt-4o",
        latencyMs,
        ttftMs: 100,
        outcome: "success",
        status: 200,
      })
    );
  }
  for (let i = 0; i < errors; i++) {
    registry.record(
      createRoutingEvent({
        requestId: "r",
        provider: "openai",
        model: "gpt-4o",
        latencyMs,
        outcome: "error",
        status: 502,
      })
    );
  }
  for (let i = 0; i < (failover?.requests ?? 0); i++) {
    registry.recordCombo({
      strategy: "priority",
      success: i < (failover?.successes ?? 0),
      fallbackCount: 1,
    });
  }
  return registry.window(15 * 60_000);
}

function byKey(report: ReturnType<typeof evaluateSlo>) {
  return Object.fromEntries(report.objectives.map((o) => [o.objective, o]));
}

test("resolveSloSettings fills defaults and ignores invalid input", () => {
  const defaults = resolveSloSettings(undefined);
  assert.equal(defaults.alertsEnabled, false);
  assert.equal(defaults.availabilityTarget, 0.99);
  assert.equal(defaults.latencyP95Ms, 30_000);
  assert.equal(defaults.latencyP99Ms, 60_000);
  assert.equal(defaults.ttftP95Ms, 5_000);
  assert.equal(defaults.errorRateMax, 0.05);
  assert.equal(defaults.failoverSuccessRateMin, 0.8);
  assert.equal(defaults.providerRecoveryMaxMs, 300_000);
  assert.equal(defaults.windowMinutes, 15);
  assert.equal(defaults.minSamples, 20);

  const custom = resolveSloSettings({ latencyP95Ms: 1234, windowMinutes: 5 });
  assert.equal(custom.latencyP95Ms, 1234);
  assert.equal(custom.windowMinutes, 5);
  assert.equal(custom.errorRateMax, 0.05);

  assert.deepEqual(resolveSloSettings({ windowMinutes: 9999 }), defaults);
  assert.deepEqual(resolveSloSettings("garbage"), defaults);
});

test("settings schemas accept slo and reject unknown or out-of-range keys", () => {
  assert.equal(updateSettingsSchema.safeParse({ slo: { errorRateMax: 0.1 } }).success, true);
  assert.equal(sloSettingsSchema.safeParse({ errorRateMax: 2 }).success, false);
  assert.equal(sloSettingsSchema.safeParse({ unknownKey: 1 }).success, false);
  assert.equal(sloSettingsSchema.safeParse({ availabilityTarget: 0.1 }).success, false);
});

test("evaluateSlo reports insufficient_data below minSamples", () => {
  const report = evaluateSlo(resolveSloSettings({}), windowWith(3, 3), [], NOW);
  assert.equal(report.status, "insufficient_data");
  assert.ok(report.objectives.every((o) => o.status === "insufficient_data"));
});

test("evaluateSlo passes healthy traffic and breaches availability/error rate/latency", () => {
  const settings = resolveSloSettings({ minSamples: 10, latencyP95Ms: 1000 });
  const healthy = byKey(evaluateSlo(settings, windowWith(100, 0, 300), [], NOW));
  assert.equal(healthy.availability.status, "ok");
  assert.equal(healthy.error_rate.status, "ok");
  assert.equal(healthy.latency_p95.status, "ok");
  assert.equal(healthy.ttft_p95.status, "ok");

  const bad = evaluateSlo(settings, windowWith(80, 20, 4000), [], NOW);
  const objectives = byKey(bad);
  assert.equal(bad.status, "breached");
  assert.equal(objectives.availability.status, "breached");
  assert.equal(objectives.availability.value, 0.8);
  assert.equal(objectives.error_rate.status, "breached");
  assert.equal(objectives.error_rate.value, 0.2);
  assert.equal(objectives.latency_p95.status, "breached");
});

test("failover success rate objective uses combo requests that needed a fallback", () => {
  const settings = resolveSloSettings({ minSamples: 5 });
  const ok = byKey(
    evaluateSlo(settings, windowWith(0, 0, 0, { requests: 10, successes: 9 }), [], NOW)
  );
  assert.equal(ok.failover_success_rate.status, "ok");
  assert.equal(ok.failover_success_rate.value, 0.9);
  const bad = byKey(
    evaluateSlo(settings, windowWith(0, 0, 0, { requests: 10, successes: 5 }), [], NOW)
  );
  assert.equal(bad.failover_success_rate.status, "breached");
});

test("provider recovery time comes from OPEN→CLOSED transitions, including ongoing opens", () => {
  const windowStart = NOW - 15 * 60_000;
  const breakers: BreakerHistoryInput[] = [
    {
      name: "openai",
      state: "CLOSED",
      transitionHistory: [
        { to: "OPEN", timestamp: NOW - 10 * 60_000 },
        { to: "HALF_OPEN", timestamp: NOW - 9 * 60_000 },
        { to: "OPEN", timestamp: NOW - 8 * 60_000 },
        { to: "CLOSED", timestamp: NOW - 7 * 60_000 },
      ],
    },
    {
      name: "anthropic",
      state: "OPEN",
      transitionHistory: [{ to: "OPEN", timestamp: NOW - 60_000 }],
    },
    {
      name: "old",
      state: "CLOSED",
      transitionHistory: [
        { to: "OPEN", timestamp: NOW - 60 * 60_000 },
        { to: "CLOSED", timestamp: NOW - 50 * 60_000 },
      ],
    },
  ];
  const recovery = computeProviderRecovery(breakers, windowStart, NOW);
  assert.equal(recovery.samples, 2);
  assert.equal(recovery.worstMs, 3 * 60_000);
  assert.equal(recovery.provider, "openai");

  const report = byKey(
    evaluateSlo(
      resolveSloSettings({ providerRecoveryMaxMs: 120_000 }),
      windowWith(0, 0),
      breakers,
      NOW
    )
  );
  assert.equal(report.provider_recovery.status, "breached");
  assert.equal(report.provider_recovery.provider, "openai");
});

test("an idle breaker left open or half-open does not breach provider recovery forever", () => {
  const windowStart = NOW - 15 * 60_000;
  const idleHalfOpen: BreakerHistoryInput = {
    name: "retired-provider",
    state: "HALF_OPEN",
    lastFailureTime: NOW - 2 * 60 * 60_000,
    transitionHistory: [
      { to: "OPEN", timestamp: NOW - 2 * 60 * 60_000 },
      { to: "HALF_OPEN", timestamp: NOW - 2 * 60 * 60_000 + 30_000 },
    ],
  };
  const idleOpen: BreakerHistoryInput = {
    name: "idle-open",
    state: "OPEN",
    lastFailureTime: NOW - 60 * 60_000,
    transitionHistory: [{ to: "OPEN", timestamp: NOW - 60 * 60_000 }],
  };
  const idle = computeProviderRecovery([idleHalfOpen, idleOpen], windowStart, NOW);
  assert.equal(idle.samples, 0);
  assert.equal(idle.worstMs, null);

  const report = evaluateSlo(
    resolveSloSettings({ providerRecoveryMaxMs: 120_000 }),
    windowWith(0, 0),
    [idleHalfOpen, idleOpen],
    NOW
  );
  assert.equal(byKey(report).provider_recovery.status, "insufficient_data");
  assert.notEqual(report.status, "breached");

  // Still failing inside the window: the whole ongoing episode counts and breaches.
  const stillFailing: BreakerHistoryInput = {
    ...idleHalfOpen,
    name: "still-failing",
    lastFailureTime: NOW - 60_000,
  };
  const failing = computeProviderRecovery([stillFailing], windowStart, NOW);
  assert.equal(failing.samples, 1);
  assert.equal(failing.worstMs, 2 * 60 * 60_000);
  assert.equal(failing.provider, "still-failing");
});

function runnerDeps(overrides: Partial<ConstructorParameters<typeof SloAlertRunner>[0]> = {}) {
  const dispatched: string[] = [];
  let enabled = true;
  let window = windowWith(50, 50);
  const deps = {
    loadSettings: async () => resolveSloSettings({ minSamples: 10, alertsEnabled: enabled }),
    readBreakers: () => [],
    readWindow: () => window,
    dispatch: async (event: string) => {
      dispatched.push(event);
    },
    now: () => NOW,
    ...overrides,
  };
  return {
    deps,
    dispatched,
    setEnabled: (value: boolean) => (enabled = value),
    setWindow: (value: ReturnType<typeof windowWith>) => (window = value),
  };
}

test("SloAlertRunner forgets alert state while alerts are off", async () => {
  const harness = runnerDeps();
  const runner = new SloAlertRunner(harness.deps);

  await runner.tick();
  assert.ok(harness.dispatched.includes("slo.breached"));
  harness.dispatched.length = 0;

  harness.setEnabled(false);
  harness.setWindow(windowWith(100, 0));
  await runner.tick();
  assert.deepEqual(harness.dispatched, [], "nothing is sent while alerts are off");

  harness.setEnabled(true);
  await runner.tick();
  assert.deepEqual(
    harness.dispatched,
    [],
    "re-enabling does not replay a recovery that happened while alerts were off"
  );

  harness.setWindow(windowWith(50, 50));
  await runner.tick();
  assert.ok(harness.dispatched.includes("slo.breached"), "a new breach alerts again");
});

test("SloAlertRunner skips a tick while the previous one is still dispatching", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const harness = runnerDeps({
    dispatch: async (event: string) => {
      events.push(event);
      await gate;
    },
  });
  const runner = new SloAlertRunner(harness.deps);

  const first = runner.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runner.tick(), false, "the overlapping tick is skipped");
  release();
  assert.equal(await first, true);
  const breaches = events.filter((event) => event === "slo.breached").length;
  assert.ok(breaches > 0);
  assert.equal(await runner.tick(), true, "the next tick runs again");
  assert.equal(
    events.filter((event) => event === "slo.breached").length,
    breaches,
    "each transition is sent once"
  );
});

test("SloAlertTracker emits breach/recovery/circuit-open once per state change", () => {
  const settings = resolveSloSettings({ minSamples: 10 });
  const tracker = new SloAlertTracker();
  const breached = evaluateSlo(settings, windowWith(50, 50), [], NOW);
  const openBreaker: BreakerHistoryInput = {
    name: "openai",
    state: "OPEN",
    failureCount: 5,
    retryAfterMs: 30_000,
    transitionHistory: [{ to: "OPEN", timestamp: NOW - 1000 }],
  };

  const first = tracker.transitions(breached, [openBreaker]);
  const events = first.map((a) => a.event);
  assert.ok(events.includes("slo.breached"));
  assert.ok(events.includes("provider.circuit_open"));
  const circuit = first.find((a) => a.event === "provider.circuit_open");
  assert.deepEqual(circuit?.data, { provider: "openai", failureCount: 5, retryAfterMs: 30_000 });
  for (const alert of first) assert.ok(WEBHOOK_EVENT_VALUES.includes(alert.event));

  assert.deepEqual(tracker.transitions(breached, [openBreaker]), [], "deduplicated");

  const insufficient = evaluateSlo(settings, windowWith(1, 0), [], NOW);
  assert.deepEqual(tracker.transitions(insufficient, []), [], "no data keeps state");

  const healthy = evaluateSlo(settings, windowWith(100, 0), [], NOW);
  const recovered = tracker.transitions(healthy, []);
  assert.ok(recovered.length > 0);
  assert.ok(recovered.every((a) => a.event === "slo.recovered"));
  assert.deepEqual(
    tracker.transitions(healthy, [openBreaker]).map((a) => a.event),
    ["provider.circuit_open"],
    "a new open cycle alerts again"
  );

  const serialized = JSON.stringify([...first, ...recovered]);
  assert.equal(serialized.includes("connection"), false);
});
