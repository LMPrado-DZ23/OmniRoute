import test from "node:test";
import assert from "node:assert/strict";

import {
  getRoutingDecision,
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
