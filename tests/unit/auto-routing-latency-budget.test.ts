/**
 * Live per-request latency budget (`RoutingBudget.maxLatencyMs`, `X-OmniRoute-Latency-Budget`).
 *
 * With no budget the live auto combo must route exactly as before. With one, a candidate whose
 * estimated latency exceeds it is excluded from selection AND from the failover chain, the
 * recorded decision says why (`latency_over_budget`), and a request nothing can serve in time is
 * refused instead of being answered over budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-latency-budget-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
const { withRequestId } = await import("../../src/shared/utils/requestId.ts");
const { exceedsLatencyBudget } = await import("../../open-sse/services/routing/attemptPolicy.ts");
const { getRoutingDecision, resetRoutingDecisionStore } =
  await import("../../open-sse/services/routing/decisionStore.ts");
const { parseRequestLatencyBudgetMs, resolveRequestAutoControls } =
  await import("../../open-sse/services/autoCombo/requestControls.ts");
const { candidatesWithinLatencyBudget, dropTargetsOverLatencyBudget } =
  await import("../../open-sse/services/combo/latencyBudget.ts");
const { resolveAutoStrategyOrder } =
  await import("../../open-sse/services/combo/resolveAutoStrategy.ts");

import type {
  AutoProviderCandidate,
  ComboLike,
  ComboLogger,
  ResolvedComboTarget,
} from "../../open-sse/services/combo/types.ts";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const log: ComboLogger = { info() {}, warn() {}, error() {}, debug() {} };

function target(provider: string, model: string): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `step-${provider}`,
    executionKey: `${provider}>${model}`,
    modelStr: `${provider}/${model}`,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

/** A candidate that wins on everything but latency, so only the budget can keep it out. */
function candidate(
  provider: string,
  model: string,
  p95LatencyMs: number,
  quality: number
): AutoProviderCandidate {
  return {
    stepId: `step-${provider}`,
    executionKey: `${provider}>${model}`,
    modelStr: `${provider}/${model}`,
    provider,
    model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs,
    latencyStdDev: 10,
    errorRate: 0.01,
    accountTier: "standard",
    quotaResetIntervalSecs: 86400,
    contextAffinity: 0.5,
    sessionAvailability: 1,
    resetWindowAffinity: 0.5,
    quality,
  };
}

const combo: ComboLike = {
  id: "latency-budget-combo",
  name: "latency-budget-combo",
  strategy: "auto",
  models: [],
  // Quality-dominant weights with exploration off: the slow candidate is the clear winner.
  config: {
    auto: {
      explorationRate: 0,
      weights: {
        quota: 0,
        health: 0,
        costInv: 0,
        latencyInv: 0,
        taskFit: 0,
        stability: 0,
        tierPriority: 0,
        tierAffinity: 0,
        specificityMatch: 0,
        contextAffinity: 0,
        resetWindowAffinity: 0,
        connectionDensity: 0,
        quality: 1,
      },
    },
  },
};

const targets = [target("slowco", "big"), target("fastco", "small")];
const builtCandidates = [
  candidate("slowco", "big", 6000, 0.95),
  candidate("fastco", "small", 400, 0.2),
];

async function route(latencyBudgetMs: number | null, requestId: string) {
  return withRequestId({ headers: new Headers({ "x-request-id": requestId }) }, () =>
    resolveAutoStrategyOrder({
      orderedTargets: targets,
      body: { messages: [{ role: "user", content: "hello" }] },
      combo,
      settings: null,
      config: {},
      relayOptions: latencyBudgetMs === null ? null : { latencyBudgetMs },
      resilienceSettings: resolveResilienceSettings(null),
      log,
      buildAutoCandidates: async () => builtCandidates.map((c) => ({ ...c })),
    })
  );
}

test("exceedsLatencyBudget: no budget and unknown estimates never exclude", () => {
  assert.equal(exceedsLatencyBudget(9000, undefined), false);
  assert.equal(exceedsLatencyBudget(null, 100), false);
  assert.equal(exceedsLatencyBudget(undefined, 100), false);
  assert.equal(exceedsLatencyBudget(Number.NaN, 100), false);
  assert.equal(exceedsLatencyBudget(100, 100), false, "equal to the budget fits");
  assert.equal(exceedsLatencyBudget(101, 100), true);
});

test("X-OmniRoute-Latency-Budget: only a finite positive ms value is accepted", () => {
  assert.equal(parseRequestLatencyBudgetMs("1500"), 1500);
  assert.equal(parseRequestLatencyBudgetMs(" 250 "), 250);
  assert.equal(parseRequestLatencyBudgetMs(800), 800);
  for (const invalid of ["", "0", "-5", "fast", "Infinity", null, undefined]) {
    assert.equal(parseRequestLatencyBudgetMs(invalid), undefined, String(invalid));
  }
  assert.deepEqual(
    resolveRequestAutoControls(new Headers({ "x-omniroute-latency-budget": "1200" })),
    { latencyBudgetMs: 1200 }
  );
  assert.deepEqual(resolveRequestAutoControls(new Headers()), {});
});

test("latency helpers are the identity when the request sets no budget", () => {
  const list = builtCandidates.map((c) => ({ ...c }));
  assert.equal(candidatesWithinLatencyBudget(list, undefined), list);
  assert.equal(dropTargetsOverLatencyBudget(targets, list, undefined), targets);
});

test("latency helpers drop only over-budget entries and keep unknown-latency targets", () => {
  const kept = candidatesWithinLatencyBudget(builtCandidates, 1000);
  assert.deepEqual(
    kept.map((c) => c.provider),
    ["fastco"]
  );
  const orphan = target("orphanco", "unknown");
  const chain = dropTargetsOverLatencyBudget([...targets, orphan], builtCandidates, 1000);
  assert.deepEqual(
    chain.map((t) => t.provider),
    ["fastco", "orphanco"]
  );
});

test("no latency budget: routing is unchanged and still picks the slow high-quality target", async () => {
  resetRoutingDecisionStore();
  const result = await route(null, "req-no-budget");
  assert.ok("orderedTargets" in result);
  if (!("orderedTargets" in result)) return;
  assert.equal(result.orderedTargets[0].provider, "slowco");
  assert.ok(result.orderedTargets.some((t) => t.provider === "fastco"));
  const decision = getRoutingDecision("req-no-budget");
  assert.ok(decision);
  assert.equal(decision?.selected?.providerId, "slowco");
  assert.ok(decision?.candidates.every((c) => !c.exclusionReasons.includes("latency_over_budget")));
});

test("latency budget: the slow target is excluded from selection, failover and explained", async () => {
  resetRoutingDecisionStore();
  const result = await route(1000, "req-with-budget");
  assert.ok("orderedTargets" in result);
  if (!("orderedTargets" in result)) return;
  assert.deepEqual(
    result.orderedTargets.map((t) => t.provider),
    ["fastco"],
    "the over-budget target must not survive as a failover fallback"
  );
  const decision = getRoutingDecision("req-with-budget");
  assert.equal(decision?.selected?.providerId, "fastco");
  const slow = decision?.candidates.find((c) => c.providerId === "slowco");
  assert.equal(slow?.eligible, false);
  assert.deepEqual(slow?.exclusionReasons, ["latency_over_budget"]);
  assert.equal(slow?.estimatedLatencyMs, 6000);
});

test("latency budget no candidate can meet: refused with 503, never served over budget", async () => {
  const result = await route(100, "req-impossible-budget");
  assert.ok("earlyResponse" in result);
  if (!("earlyResponse" in result)) return;
  assert.equal(result.earlyResponse.status, 503);
  const body = await result.earlyResponse.text();
  assert.match(body, /latency budget of 100ms/);
});
