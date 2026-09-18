/**
 * An explicit auto router strategy (cost, latency, lkgp, ...) keeps its pick as the first target
 * attempted, as in v3.8.53: the combo `budgetCap` orders the failover chain only on the scoring
 * engine ("rules") path. Otherwise the recorded decision and the "Auto selection" log line would
 * name a target that is not the one tried first.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-explicit-budget-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resolveAutoStrategyOrder } =
  await import("@omniroute/open-sse/services/combo/resolveAutoStrategy.ts");
const { getRoutingDecision, resetRoutingDecisionStore } =
  await import("@omniroute/open-sse/services/routing/decisionStore.ts");
const { withRequestId } = await import("@/shared/utils/requestId.ts");
const { resetDbInstance } = await import("@/lib/db/core.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const target = (provider: string, modelStr: string): never =>
  ({
    kind: "model",
    stepId: "s1",
    executionKey: `${provider}>${modelStr}`,
    modelStr,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  }) as never;

const candidate = (provider: string, model: string, overrides: Record<string, unknown> = {}) => ({
  kind: "model",
  stepId: "s1",
  executionKey: `${provider}>${model}`,
  modelStr: model,
  provider,
  model,
  quotaRemaining: 100,
  quotaTotal: 100,
  circuitBreakerState: "CLOSED",
  latencyStdDev: 10,
  errorRate: 0,
  ...overrides,
});

// "fast-model" is the latency pick but costs 0.05 USD per estimated request, over the 0.001 cap;
// "slow-model" is in budget.
const candidates = () =>
  [
    candidate("anthropic", "fast-model", { costPer1MTokens: 50, p95LatencyMs: 10 }),
    candidate("openai", "slow-model", { costPer1MTokens: 0.01, p95LatencyMs: 5000 }),
  ] as never;

function capturingLog() {
  const entries: string[] = [];
  const push = (_tag: unknown, msg: unknown) => entries.push(String(msg));
  return { entries, info: push, warn: push, error: push, debug: push };
}

async function resolve(comboName: string, routerStrategy: string, requestId: string) {
  const log = capturingLog();
  const result = await withRequestId(
    new Request("http://localhost/v1/chat/completions", { headers: { "x-request-id": requestId } }),
    () =>
      resolveAutoStrategyOrder({
        orderedTargets: [target("anthropic", "fast-model"), target("openai", "slow-model")],
        body: { messages: [{ role: "user", content: "hi" }] },
        combo: {
          id: comboName,
          name: comboName,
          autoConfig: {
            routerStrategy,
            candidatePool: ["anthropic", "openai"],
            explorationRate: 0,
            budgetCap: 0.001,
            budgetFallback: "strict",
          },
        },
        settings: null,
        config: {},
        relayOptions: null,
        resilienceSettings: { quotaPreflight: { enabled: false } },
        log,
        buildAutoCandidates: (async () => candidates()) as never,
      } as never)
  );
  assert.ok("orderedTargets" in result, "expected an ordering result, not an earlyResponse");
  const selection = log.entries.find((entry) => entry.startsWith("Auto selection:")) ?? "";
  return { orderedTargets: result.orderedTargets, selection };
}

test("an explicit strategy's over-budget pick is still attempted first", async () => {
  resetRoutingDecisionStore();
  const { orderedTargets, selection } = await resolve(
    "explicit-budget-latency",
    "latency",
    "req-explicit-budget"
  );
  assert.equal(orderedTargets[0].provider, "anthropic");
  assert.equal(orderedTargets[0].modelStr, "fast-model");
  assert.match(selection, /^Auto selection: fast-model .*strategy=latency/);
  assert.equal(orderedTargets.length, 2, "the explicit path does not drop targets by budget");
  assert.equal(getRoutingDecision("req-explicit-budget")?.strategy, "latency");
});

test("the rules path keeps its failover chain inside the budget cap", async () => {
  resetRoutingDecisionStore();
  const { orderedTargets, selection } = await resolve(
    "explicit-budget-rules",
    "rules",
    "req-rules-budget"
  );
  assert.deepEqual(
    orderedTargets.map((t: { modelStr: string }) => t.modelStr),
    ["slow-model"],
    "strict drops the over-budget target from the rules failover chain"
  );
  assert.match(selection, /^Auto selection: slow-model /);
  assert.equal(getRoutingDecision("req-rules-budget")?.selected?.modelId, "slow-model");
});
