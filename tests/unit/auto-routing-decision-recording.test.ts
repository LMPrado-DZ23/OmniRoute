/**
 * A live auto-combo selection records an explainable routing decision under the request id, and
 * the failover chain stays inside the request cost budget (strict drops over-budget targets,
 * cheapest moves them behind the in-budget ones).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  orderTargetsByCostBudget,
  recordExplicitStrategyDecision,
  selectAutoProviderWithDecision,
} from "../../open-sse/services/combo/autoRoutingDecision.ts";
import {
  getRoutingDecision,
  resetRoutingDecisionStore,
} from "../../open-sse/services/routing/decisionStore.ts";
import { getSelfHealingManager } from "../../open-sse/services/autoCombo/selfHealing.ts";
import { DEFAULT_WEIGHTS } from "../../open-sse/services/autoCombo/scoring.ts";
import { withRequestId } from "../../src/shared/utils/requestId.ts";

const healer = getSelfHealingManager();

test.beforeEach(() => {
  resetRoutingDecisionStore();
  healer.exclusions.clear();
  healer.incidentMode = false;
});

function config(name, overrides = {}) {
  return {
    id: name,
    name,
    type: "auto",
    candidatePool: [],
    weights: DEFAULT_WEIGHTS,
    explorationRate: 0,
    ...overrides,
  };
}

function candidate(provider, overrides = {}) {
  return {
    provider,
    model: `${provider}-model`,
    executionKey: `${provider}-key`,
    quotaRemaining: 90,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 2,
    p95LatencyMs: 400,
    latencyStdDev: 40,
    errorRate: 0.01,
    ...overrides,
  };
}

function inRequest(requestId, fn) {
  return withRequestId(
    new Request("http://localhost/v1/chat/completions", { headers: { "x-request-id": requestId } }),
    fn
  );
}

test("the live rules selection is recorded and found by request id", async () => {
  const alpha = candidate("alpha", { costPer1MTokens: 1, p95LatencyMs: 200 });
  const blocked = candidate("beta", { quotaCutoffBlocked: true });
  const result = await inRequest("req-live-1", () =>
    selectAutoProviderWithDecision({
      config: config("live-record-combo"),
      candidates: [alpha, blocked],
      routableCandidates: [alpha],
      taskType: "default",
      body: { messages: [], stream: true },
    })
  );

  assert.ok("selection" in result);
  assert.equal(result.selection.provider, "alpha");
  const stored = getRoutingDecision("req-live-1");
  assert.equal(stored?.decisionId, result.decision.decisionId);
  assert.equal(stored?.liveRequestExecuted, true);
  assert.equal(stored?.strategy, "rules");
  assert.equal(stored?.selected?.providerId, "alpha");
  assert.deepEqual(stored?.candidates.find((c) => c.providerId === "beta")?.exclusionReasons, [
    "quota_exhausted",
  ]);
  assert.equal(getRoutingDecision(result.decision.decisionId)?.requestId, "req-live-1");
});

test("a strict budget refusal returns the error together with a recorded decision", async () => {
  const candidates = [candidate("alpha"), candidate("beta")];
  const result = await inRequest("req-live-budget", () =>
    selectAutoProviderWithDecision({
      config: config("live-budget-combo", { budgetCap: 0.0001, budgetFallback: "strict" }),
      candidates,
      routableCandidates: candidates,
      taskType: "default",
      body: { messages: [] },
    })
  );

  assert.ok("budgetError" in result);
  assert.equal(result.decision.selected, undefined);
  assert.ok(
    result.decision.candidates.every((c) => c.exclusionReasons.includes("cost_over_budget"))
  );
  assert.equal(getRoutingDecision("req-live-budget")?.decisionId, result.decision.decisionId);
});

test("an explicit router strategy is recorded with its own pick and no live side effects", async () => {
  const candidates = [
    candidate("alpha", { costPer1MTokens: 1 }),
    candidate("beta", { circuitBreakerState: "OPEN" }),
    candidate("gamma", { costPer1MTokens: 5 }),
  ];
  const decision = await inRequest("req-live-cost", () =>
    recordExplicitStrategyDecision({
      config: config("live-strategy-combo", { routerStrategy: "cost" }),
      candidates,
      routableCandidates: candidates,
      taskType: "default",
      body: { input: "hello" },
      selection: { strategy: "cost", provider: "gamma", model: "gamma-model" },
    })
  );

  assert.equal(decision.strategy, "cost");
  assert.equal(decision.selected?.providerId, "gamma");
  assert.equal(decision.selectionMode, undefined);
  assert.equal(
    healer.getStatus().exclusionCount,
    0,
    "scoring for the record must not exclude live"
  );
  assert.equal(getRoutingDecision("req-live-cost")?.decisionId, decision.decisionId);
});

test("failover order respects the cost budget", () => {
  const targets = [{ executionKey: "a" }, { executionKey: "b" }, { executionKey: "c" }];
  const candidates = [
    { executionKey: "a", costPer1MTokens: 2 },
    { executionKey: "b", costPer1MTokens: 20 },
  ];

  assert.deepEqual(
    orderTargetsByCostBudget(targets, candidates, 0.01, "strict").map((t) => t.executionKey),
    ["a", "c"],
    "strict drops the over-budget target; an unpriced target is kept"
  );
  assert.deepEqual(
    orderTargetsByCostBudget(targets, candidates, 0.01, "cheapest").map((t) => t.executionKey),
    ["a", "c", "b"]
  );
  assert.equal(orderTargetsByCostBudget(targets, candidates, undefined, "strict"), targets);
  assert.deepEqual(
    orderTargetsByCostBudget([{ executionKey: "b" }], candidates, 0.01, "strict").map(
      (t) => t.executionKey
    ),
    ["b"],
    "never empties the chain; the engine already refused an all-over-budget request"
  );
});
