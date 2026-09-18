import test from "node:test";
import assert from "node:assert/strict";

import {
  getRoutingDecision,
  getRoutingDecisionStoreStats,
  MAX_CANDIDATES_WITH_FACTORS,
  MAX_STORE_BYTES,
  MAX_STORED_CANDIDATES,
  recordRoutingDecision,
  resetRoutingDecisionStore,
} from "../../open-sse/services/routing/decisionStore.ts";

function decision(decisionId: string, requestId: string) {
  return {
    decisionId,
    requestId,
    candidates: [],
    policyVersion: "rp_0000000000000000",
    generatedAt: "2026-09-14T12:00:00.000Z",
    liveRequestExecuted: true,
  };
}

test.beforeEach(() => resetRoutingDecisionStore());

test("a decision is found by decision id and by request id", () => {
  recordRoutingDecision(decision("rd_1", "req-1"), 1000);
  assert.equal(getRoutingDecision("rd_1", 1000)?.requestId, "req-1");
  assert.equal(getRoutingDecision("req-1", 1000)?.decisionId, "rd_1");
  assert.equal(getRoutingDecision("missing", 1000), null);
});

test("the latest decision for a request wins the request-id lookup", () => {
  recordRoutingDecision(decision("rd_1", "req-1"), 1000);
  recordRoutingDecision(decision("rd_2", "req-1"), 2000);
  assert.equal(getRoutingDecision("req-1", 2000)?.decisionId, "rd_2");
  assert.equal(getRoutingDecision("rd_1", 2000)?.decisionId, "rd_1");
});

test("decisions expire after 30 minutes", () => {
  recordRoutingDecision(decision("rd_1", "req-1"), 0);
  assert.ok(getRoutingDecision("rd_1", 30 * 60 * 1000));
  assert.equal(getRoutingDecision("rd_1", 30 * 60 * 1000 + 1), null);
  assert.equal(getRoutingDecision("req-1", 30 * 60 * 1000 + 1), null);
});

test("the store keeps at most 2000 decisions, evicting the oldest", () => {
  for (let i = 0; i < 2001; i += 1) recordRoutingDecision(decision(`rd_${i}`, `req-${i}`), 1000);
  assert.equal(getRoutingDecision("rd_0", 1000), null);
  assert.equal(getRoutingDecision("req-0", 1000), null);
  assert.ok(getRoutingDecision("rd_2000", 1000));
});

const FACTOR_NAMES = [
  "quota",
  "health",
  "cost",
  "latency",
  "task_fit",
  "stability",
  "tier",
  "cache_affinity",
  "context",
  "throughput",
  "freshness",
  "region",
  "priority",
  "reliability",
  "error_rate",
  "jitter",
  "session",
];

function wideCandidate(index: number) {
  return {
    providerId: `provider-${index % 40}`,
    modelId: `catalog-model-${index}`,
    score: 1 - index / 1000,
    factors: FACTOR_NAMES.map((name) => ({ name, value: 0.5, weight: 0.1, contribution: 0.05 })),
    eligible: index % 3 !== 0,
    exclusionReasons: index % 3 === 0 ? ["circuit_open" as const] : [],
    quota: "available" as const,
    circuit: "closed" as const,
    estimatedCostUsd: 0.001,
    estimatedLatencyMs: 400,
  };
}

function wideDecision(decisionId: string, requestId: string, candidateCount: number) {
  const candidates = Array.from({ length: candidateCount }, (_, i) => wideCandidate(i));
  return { ...decision(decisionId, requestId), candidates, selected: candidates[250] };
}

test("a wide decision is stored compact: bounded candidates, factors only where they explain", () => {
  recordRoutingDecision(wideDecision("rd_wide", "req-wide", 300), 1000);
  const stored = getRoutingDecision("req-wide", 1000);
  assert.ok(stored);
  assert.equal(stored.candidates.length, MAX_STORED_CANDIDATES);
  assert.equal(stored.omittedCandidates, 300 - MAX_STORED_CANDIDATES);
  assert.equal(stored.selected?.modelId, "catalog-model-250");
  assert.equal(stored.selected?.factors.length, FACTOR_NAMES.length);
  assert.ok(
    stored.candidates.some((c) => c.modelId === "catalog-model-250"),
    "the selected candidate stays listed even when it ranked below the kept ones"
  );
  const withFactors = stored.candidates.filter((c) => c.factors.length > 0);
  assert.ok(withFactors.length <= MAX_CANDIDATES_WITH_FACTORS + 1, `${withFactors.length}`);
  assert.equal(stored.candidates[0].factors.length, FACTOR_NAMES.length);
  assert.deepEqual(stored.candidates[MAX_CANDIDATES_WITH_FACTORS].factors, []);
  assert.deepEqual(
    stored.candidates[0].exclusionReasons,
    ["circuit_open"],
    "exclusion reasons survive compaction"
  );
});

test("2000 decisions with 300 candidates each stay inside the store byte budget", () => {
  for (let i = 0; i < 2000; i += 1) {
    recordRoutingDecision(wideDecision(`rd_w${i}`, `req-w${i}`, 300), 1000);
  }
  const stats = getRoutingDecisionStoreStats();
  assert.ok(stats.bytes <= MAX_STORE_BYTES, `estimated ${stats.bytes} bytes`);
  assert.ok(stats.entries > 0 && stats.entries <= 2000);
  const latest = getRoutingDecision("req-w1999", 1000);
  assert.ok(latest, "the newest decision is retained");
  const serialized = JSON.stringify(latest).length;
  assert.ok(serialized < 64 * 1024, `one stored decision serializes to ${serialized} bytes`);
  assert.ok(
    serialized * stats.entries < 2 * MAX_STORE_BYTES,
    `retained decisions serialize to ${serialized * stats.entries} bytes`
  );
  assert.equal(getRoutingDecision("req-w0", 1000), null, "the oldest were evicted by the budget");
});

test("a small decision is stored unchanged", () => {
  const small = wideDecision("rd_small", "req-small", 5);
  recordRoutingDecision(small, 1000);
  const stored = getRoutingDecision("rd_small", 1000);
  assert.equal(stored?.omittedCandidates, undefined);
  assert.equal(stored?.candidates.length, 5);
  assert.ok(stored?.candidates.every((c) => c.factors.length === FACTOR_NAMES.length));
});
