/**
 * Live recording builds the routing decision already in the shape the decision store retains.
 *
 * `buildRoutingDecision` used to materialise every candidate with its full factor breakdown and
 * leave it to `recordRoutingDecision` to throw all but 40 candidates / 10 factor breakdowns away,
 * so an auto combo over the whole catalog paid hundreds of KiB and double-digit milliseconds of
 * pure waste on every routed request. Passing the store's own bounds as `retention` builds the
 * decision compact from the start.
 *
 * What must not change:
 *  - what `GET /api/omniroute/route/decisions/{id}` returns, byte for byte, for the same input;
 *  - the preview path, which must keep returning the full, uncompacted candidate list.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRoutingDecision,
  previewRoutingDecision,
  type BuildRoutingDecisionInput,
  type DecisionCandidateInput,
} from "../../open-sse/services/autoCombo/routingDecision.ts";
import {
  previewSelectionDeps,
  selectProviderWithTrace,
  type AutoComboConfig,
} from "../../open-sse/services/autoCombo/engine.ts";
import { DEFAULT_WEIGHTS } from "../../open-sse/services/autoCombo/scoring.ts";
import {
  getRoutingDecision,
  MAX_CANDIDATES_WITH_FACTORS,
  MAX_STORED_CANDIDATES,
  recordRoutingDecision,
  resetRoutingDecisionStore,
} from "../../open-sse/services/routing/decisionStore.ts";

const clock = {
  now: () => Date.parse("2026-09-18T12:00:00.000Z"),
  newDecisionId: () => "rd_compact_test",
};

const config = {
  id: "compact-auto",
  name: "compact-auto",
  type: "auto",
  candidatePool: [],
  weights: DEFAULT_WEIGHTS,
  explorationRate: 0,
} as unknown as AutoComboConfig;

const request = {
  requestId: "req-compact",
  model: "compact-auto",
  protocol: "messages",
  stream: false,
};

const RETENTION = {
  maxCandidates: MAX_STORED_CANDIDATES,
  maxCandidatesWithFactors: MAX_CANDIDATES_WITH_FACTORS,
};

/** A pool wide enough that the store's bounds bite, with a mix of routable and excluded entries. */
function candidatePool(count: number): DecisionCandidateInput[] {
  const pool: DecisionCandidateInput[] = [];
  for (let index = 0; index < count; index += 1) {
    pool.push({
      provider: `provider-${index % 37}`,
      model: `catalog-model-${index}`,
      connectionId: `conn-${index}`,
      quotaRemaining: 95 - (index % 90),
      quotaTotal: 100,
      circuitBreakerState: index % 23 === 0 ? "OPEN" : "CLOSED",
      costPer1MTokens: 1 + (index % 19),
      p95LatencyMs: 150 + (index % 1200),
      latencyStdDev: 25 + (index % 65),
      errorRate: (index % 13) / 200,
      modelAvailable: index % 31 !== 0,
    } as unknown as DecisionCandidateInput);
  }
  return pool;
}

function buildInput(pool: DecisionCandidateInput[]): BuildRoutingDecisionInput {
  const routable = pool.filter((candidate) => candidate.modelAvailable !== false);
  const outcome = selectProviderWithTrace(
    config,
    routable,
    "default",
    undefined,
    previewSelectionDeps()
  );
  return { request, config, candidates: pool, outcome, liveRequestExecuted: true };
}

/** The decision as `GET /api/omniroute/route/decisions/{id}` serialises it. */
function storedJson(input: BuildRoutingDecisionInput): string {
  resetRoutingDecisionStore();
  recordRoutingDecision(buildRoutingDecision(input, clock), 1000);
  const stored = getRoutingDecision("rd_compact_test", 1000);
  assert.ok(stored, "the decision was recorded");
  return JSON.stringify(stored);
}

test.afterEach(() => resetRoutingDecisionStore());

test("a decision built compact stores exactly what a full build stored", () => {
  for (const size of [300, 50, MAX_STORED_CANDIDATES, 7]) {
    const input = buildInput(candidatePool(size));
    const full = storedJson(input);
    const compact = storedJson({ ...input, retention: RETENTION });
    assert.equal(compact, full, `stored decision differs for a pool of ${size} candidates`);
  }
});

test("the compact build carries the store's omittedCandidates count", () => {
  const input = buildInput(candidatePool(300));
  const compact = buildRoutingDecision({ ...input, retention: RETENTION }, clock);

  assert.equal(compact.candidates.length, MAX_STORED_CANDIDATES);
  assert.equal(compact.omittedCandidates, 300 - MAX_STORED_CANDIDATES);
  assert.equal(
    compact.candidates.filter((candidate) => candidate.factors.length > 0).length,
    MAX_CANDIDATES_WITH_FACTORS
  );
  assert.ok(compact.selected, "a candidate was selected");
  assert.ok(compact.selected.factors.length > 0, "the selected candidate keeps its factors");
  assert.ok(
    compact.candidates.some(
      (candidate) =>
        candidate.providerId === compact.selected?.providerId &&
        candidate.modelId === compact.selected?.modelId
    ),
    "the selected candidate is among the retained ones"
  );
});

test("the retained candidates keep the order a full build produced", () => {
  const input = buildInput(candidatePool(300));
  const full = buildRoutingDecision(input, clock);
  const compact = buildRoutingDecision({ ...input, retention: RETENTION }, clock);

  assert.deepEqual(
    compact.candidates.map((candidate) => [candidate.providerId, candidate.modelId]),
    full.candidates
      .slice(0, MAX_STORED_CANDIDATES)
      .map((candidate) => [candidate.providerId, candidate.modelId])
  );
});

test("preview still returns every candidate with its factor breakdown", () => {
  const pool = candidatePool(300);
  const decision = previewRoutingDecision({ request, config, candidates: pool }, clock);

  assert.equal(decision.candidates.length, 300);
  assert.equal(decision.omittedCandidates, undefined);
  const scored = decision.candidates.filter((candidate) => candidate.factors.length > 0);
  assert.ok(scored.length > MAX_CANDIDATES_WITH_FACTORS, "preview is not compacted");
});
