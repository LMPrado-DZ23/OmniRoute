/**
 * Router contract scenarios (Phase 3): the decision a preview returns is produced by the same
 * selection code live traffic runs, explains every exclusion, carries a policy version, never
 * calls an upstream provider and never changes routing state; failed attempts are classified so
 * permanent errors are not retried blindly and failover respects the request budget.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeRoutingPolicyVersion,
  previewRoutingDecision,
} from "../../open-sse/services/autoCombo/routingDecision.ts";
import { selectProvider } from "../../open-sse/services/autoCombo/engine.ts";
import { getSelfHealingManager } from "../../open-sse/services/autoCombo/selfHealing.ts";
import { DEFAULT_WEIGHTS } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  canRetrySameCandidate,
  checkFailoverBudget,
  classifyAttemptOutcome,
  isPermanentAttemptOutcome,
  isRetryableAttemptStatus,
  planNextAttempt,
} from "../../open-sse/services/routing/attemptPolicy.ts";

const healer = getSelfHealingManager();
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;

const clock = {
  now: () => Date.parse("2026-09-14T12:00:00.000Z"),
  newDecisionId: () => "rd_test",
};

function resetHealer() {
  healer.exclusions.clear();
  healer.incidentMode = false;
}

test.beforeEach(() => {
  resetHealer();
  upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("routing decisions must not call an upstream provider");
  }) as typeof fetch;
});

test.afterEach(() => {
  resetHealer();
  globalThis.fetch = originalFetch;
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

function request(overrides = {}) {
  return { requestId: "req-1", model: "auto/test", protocol: "openai-chat", ...overrides };
}

const cheapFast = () => candidate("alpha", { costPer1MTokens: 1, p95LatencyMs: 200 });
const pricySlow = () =>
  candidate("beta", { costPer1MTokens: 10, p95LatencyMs: 2000, latencyStdDev: 400 });

function byProvider(decision, providerId) {
  return decision.candidates.find((c) => c.providerId === providerId);
}

test("healthy: the preview selects what live selection picks and explains the score", () => {
  const cfg = config("healthy-combo");
  const decision = previewRoutingDecision(
    { request: request(), config: cfg, candidates: [cheapFast(), pricySlow()] },
    clock
  );

  assert.equal(decision.selected?.providerId, "alpha");
  assert.equal(selectProvider(cfg, [cheapFast(), pricySlow()]).provider, "alpha");
  assert.equal(decision.decisionId, "rd_test");
  assert.equal(decision.requestId, "req-1");
  assert.equal(decision.generatedAt, "2026-09-14T12:00:00.000Z");
  assert.equal(decision.liveRequestExecuted, false);
  assert.equal(decision.selectionMode, "deterministic");
  assert.match(decision.policyVersion, /^rp_[0-9a-f]{16}$/);
  assert.deepEqual(
    decision.candidates.map((c) => [c.providerId, c.eligible]),
    [
      ["alpha", true],
      ["beta", true],
    ]
  );
  const cost = decision.selected?.factors.find((f) => f.name === "costInv");
  assert.ok(cost, "score breakdown lists the cost factor");
  assert.ok(Math.abs(cost.contribution - cost.value * cost.weight) < 1e-5);
  assert.equal(decision.selected?.estimatedCostUsd, 0.001);
  assert.equal(decision.selected?.estimatedLatencyMs, 200);
  assert.equal(upstreamCalls, 0);
});

test("quota exhausted: a cut-off account is excluded with an explicit reason", () => {
  const decision = previewRoutingDecision(
    {
      request: request(),
      config: config("quota-combo"),
      candidates: [
        candidate("alpha", { quotaCutoffBlocked: true, quotaRemaining: 0 }),
        pricySlow(),
      ],
    },
    clock
  );

  const alpha = byProvider(decision, "alpha");
  assert.equal(alpha.eligible, false);
  assert.deepEqual(alpha.exclusionReasons, ["quota_exhausted"]);
  assert.equal(alpha.quota, "exhausted");
  assert.equal(decision.selected?.providerId, "beta");
});

test("quota unknown: a candidate without a quota signal stays eligible and is not 'exhausted'", () => {
  const decision = previewRoutingDecision(
    {
      request: request(),
      config: config("unknown-quota-combo"),
      candidates: [candidate("alpha", { quotaKnown: false, quotaRemaining: 100 }), pricySlow()],
    },
    clock
  );

  const alpha = byProvider(decision, "alpha");
  assert.equal(alpha.quota, "unknown");
  assert.equal(alpha.eligible, true);
  assert.deepEqual(alpha.exclusionReasons, []);
  assert.equal(byProvider(decision, "beta").quota, "available");
});

test("circuit open: the provider is excluded and the preview leaves self-healing untouched", () => {
  const input = {
    request: request(),
    config: config("circuit-combo"),
    candidates: [candidate("alpha", { circuitBreakerState: "OPEN" }), pricySlow()],
  };
  const first = previewRoutingDecision(input, clock);
  const second = previewRoutingDecision(input, clock);

  const alpha = byProvider(first, "alpha");
  assert.equal(alpha.circuit, "open");
  assert.equal(alpha.eligible, false);
  assert.deepEqual(alpha.exclusionReasons, ["circuit_open"]);
  assert.equal(first.selected?.providerId, "beta");
  assert.deepEqual(second, first);
  assert.equal(healer.getStatus().exclusionCount, 0, "a preview must not add live exclusions");
});

function decisionForFailover() {
  return previewRoutingDecision(
    {
      request: request(),
      config: config("failover-combo"),
      candidates: [cheapFast(), pricySlow()],
    },
    clock
  );
}

function failedAttempt(providerId, outcome, extra = {}) {
  return {
    providerId,
    modelId: `${providerId}-model`,
    attempt: 1,
    startedAt: "2026-09-14T12:00:00.000Z",
    outcome,
    ...extra,
  };
}

test("timeout: retryable on the same candidate, then failover goes to the next one", () => {
  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 504 }), "timeout");
  assert.equal(
    classifyAttemptOutcome({ providerId: "alpha", errorText: "upstream request timed out" }),
    "timeout"
  );
  assert.equal(isRetryableAttemptStatus(504), true);
  assert.equal(canRetrySameCandidate("timeout"), true);
  assert.equal(isPermanentAttemptOutcome("timeout"), false);

  const plan = planNextAttempt({
    decision: decisionForFailover(),
    attempts: [failedAttempt("alpha", "timeout")],
    elapsedMs: 1000,
  });
  assert.equal(plan.next?.providerId, "beta");
  assert.deepEqual(plan.skipped, [
    { providerId: "alpha", modelId: "alpha-model", reason: "already_attempted" },
  ]);
});

test("rate limit: a 429 is transient and may be retried on the same candidate", () => {
  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 429 }), "rate_limited");
  assert.equal(isRetryableAttemptStatus(429), true);
  assert.equal(canRetrySameCandidate("rate_limited"), true);
  assert.equal(isPermanentAttemptOutcome("rate_limited"), false);
});

test("auth error: permanent, never retried on the same candidate", () => {
  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 401 }), "auth_error");
  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 403 }), "auth_error");
  assert.equal(isRetryableAttemptStatus(401), false);
  assert.equal(isPermanentAttemptOutcome("auth_error"), true);
  assert.equal(canRetrySameCandidate("auth_error"), false);

  const plan = planNextAttempt({
    decision: decisionForFailover(),
    attempts: [failedAttempt("alpha", "auth_error", { status: 401 })],
    elapsedMs: 50,
  });
  assert.equal(plan.next?.providerId, "beta");
});

test("model not found: excluded before scoring and a 404 attempt is permanent", () => {
  const decision = previewRoutingDecision(
    {
      request: request(),
      config: config("model-combo"),
      candidates: [candidate("alpha", { modelAvailable: false }), pricySlow()],
    },
    clock
  );
  assert.deepEqual(byProvider(decision, "alpha").exclusionReasons, ["model_not_found"]);
  assert.equal(decision.selected?.providerId, "beta");

  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 404 }), "model_not_found");
  assert.equal(isPermanentAttemptOutcome("model_not_found"), true);
  assert.equal(isRetryableAttemptStatus(404), false);
});

test("streaming failure: output already sent is not replayed, failover stays possible", () => {
  const outcome = classifyAttemptOutcome({
    providerId: "alpha",
    status: 200,
    errorText: "stream closed before completion",
    streamStarted: true,
  });
  assert.equal(outcome, "stream_failed");
  assert.equal(canRetrySameCandidate(outcome), false);
  assert.equal(isPermanentAttemptOutcome(outcome), false);
  assert.equal(classifyAttemptOutcome({ providerId: "alpha", status: 200 }), "success");

  const plan = planNextAttempt({
    decision: decisionForFailover(),
    attempts: [failedAttempt("alpha", outcome)],
    elapsedMs: 300,
  });
  assert.equal(plan.next?.providerId, "beta");
});

test("all unavailable: no candidate is selected and each one says why", () => {
  const decision = previewRoutingDecision(
    {
      request: request(),
      config: config("none-combo"),
      candidates: [
        candidate("alpha", { quotaCutoffBlocked: true }),
        candidate("beta", { modelAvailable: false }),
      ],
    },
    clock
  );

  assert.equal(decision.selected, undefined);
  assert.ok(decision.candidates.every((c) => !c.eligible && c.exclusionReasons.length > 0));
  assert.equal(planNextAttempt({ decision, attempts: [], elapsedMs: 0 }).next, undefined);
});

test("candidate tie: the preview reports rotation, is stable, and predicts the next live pick", () => {
  const cfg = config("tie-rotation-combo");
  const tied = () => [candidate("alpha"), candidate("beta")];
  const input = { request: request(), config: cfg, candidates: tied() };

  for (let round = 0; round < 3; round += 1) {
    const before = previewRoutingDecision(input, clock);
    const again = previewRoutingDecision(input, clock);
    assert.equal(before.selectionMode, "rotation");
    assert.equal(again.selected?.providerId, before.selected?.providerId, "preview is stable");
    const live = selectProvider(cfg, tied());
    assert.equal(live.provider, before.selected?.providerId, "preview predicts the live pick");
  }
  assert.notEqual(
    selectProvider(cfg, tied()).provider,
    selectProvider(cfg, tied()).provider,
    "live traffic rotates between tied candidates"
  );
});

test("different policies: the policy version changes and so can the winner", () => {
  const zero = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, 0]));
  const costFirst = config("policy-combo", { weights: { ...zero, costInv: 1 } });
  const latencyFirst = config("policy-combo", { weights: { ...zero, latencyInv: 1 } });
  const candidates = () => [
    candidate("alpha", { costPer1MTokens: 1, p95LatencyMs: 3000 }),
    candidate("beta", { costPer1MTokens: 20, p95LatencyMs: 100 }),
  ];

  const cheap = previewRoutingDecision(
    { request: request(), config: costFirst, candidates: candidates() },
    clock
  );
  const fast = previewRoutingDecision(
    { request: request(), config: latencyFirst, candidates: candidates() },
    clock
  );
  assert.equal(cheap.selected?.providerId, "alpha");
  assert.equal(fast.selected?.providerId, "beta");
  assert.notEqual(cheap.policyVersion, fast.policyVersion);

  const reordered = {
    ...costFirst,
    weights: Object.fromEntries(Object.entries(costFirst.weights).reverse()),
  };
  assert.equal(computeRoutingPolicyVersion(reordered), cheap.policyVersion);
});

test("cost limit: over-budget candidates are excluded and failover stops at the budget", () => {
  const decision = previewRoutingDecision(
    {
      request: request({ budget: { maxCost: 0.005 } }),
      config: config("cost-combo"),
      candidates: [
        candidate("alpha", { costPer1MTokens: 2 }),
        candidate("beta", { costPer1MTokens: 10 }),
      ],
    },
    clock
  );
  assert.deepEqual(byProvider(decision, "beta").exclusionReasons, ["cost_over_budget"]);
  assert.equal(decision.selected?.providerId, "alpha");

  const next = { estimatedCostUsd: 0.002, estimatedLatencyMs: 400 };
  const budget = { maxCost: 0.005 };
  assert.deepEqual(
    checkFailoverBudget({
      attempts: [failedAttempt("x", "timeout", { costUsd: 0.004 })],
      next,
      budget,
      elapsedMs: 0,
    }),
    { allowed: false, reason: "cost_over_budget" }
  );
  assert.deepEqual(
    checkFailoverBudget({
      attempts: [failedAttempt("x", "timeout", { costUsd: 0.002 })],
      next,
      budget,
      elapsedMs: 0,
    }),
    { allowed: true, reason: null }
  );

  const strict = previewRoutingDecision(
    {
      request: request(),
      config: config("strict-cost-combo", { budgetCap: 0.0001, budgetFallback: "strict" }),
      candidates: [candidate("alpha"), candidate("beta")],
    },
    clock
  );
  assert.equal(strict.selected, undefined);
  assert.ok(strict.candidates.every((c) => c.exclusionReasons.includes("cost_over_budget")));
});

test("latency limit: slow candidates are excluded and failover stops at the time budget", () => {
  const decision = previewRoutingDecision(
    {
      request: request({ budget: { maxLatencyMs: 1000 } }),
      config: config("latency-combo"),
      candidates: [
        candidate("alpha", { p95LatencyMs: 400 }),
        candidate("beta", { p95LatencyMs: 2000 }),
      ],
    },
    clock
  );
  assert.deepEqual(byProvider(decision, "beta").exclusionReasons, ["latency_over_budget"]);
  assert.equal(decision.selected?.providerId, "alpha");

  const plan = planNextAttempt({
    decision: decisionForFailover(),
    attempts: [failedAttempt("alpha", "timeout")],
    budget: { maxLatencyMs: 2500 },
    elapsedMs: 1000,
  });
  assert.equal(plan.next, undefined, "beta (p95 2000ms) no longer fits the remaining 1500ms");
  assert.deepEqual(plan.skipped.at(-1), {
    providerId: "beta",
    modelId: "beta-model",
    reason: "latency_over_budget",
  });
});
