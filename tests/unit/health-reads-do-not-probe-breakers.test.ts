/**
 * Reading health must not decide a circuit breaker's fate.
 *
 * `getAllCircuitBreakerStatuses()` calls `getStatus()`, which transitions an OPEN breaker whose
 * cooldown has elapsed to HALF_OPEN and persists that, so merely *looking* at health flipped the
 * breaker and handed the next request a probe through to a provider that is still broken. PR #38
 * fixed `/api/metrics` and the SLO timer with the read-only `getAllCircuitBreakerSnapshots()` /
 * `peekStatus()` API; these are the remaining read paths, now converted.
 *
 * "Unchanged" here means the breaker's own state: it stays OPEN, records no transition, keeps no
 * granted half-open probe, and its persisted row is untouched. The *reported* state is the
 * effective one — HALF_OPEN for an elapsed breaker — which is what PR #38 established and what
 * dashboards need to show; reporting it is not the same as causing it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { A2ATask } from "../../src/lib/a2a/taskManager.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-breaker-reads-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const domainState = await import("../../src/lib/db/domainState.ts");
const breakers = await import("../../src/shared/utils/circuitBreaker.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const webSessionPoolHealth = await import("../../open-sse/services/webSessionPoolHealth.ts");
const omnirouteStatus = await import("../../src/lib/omnirouteStatus.ts");
const healthMatrix = await import("../../src/lib/monitoring/providerHealthMatrix.ts");
const autopilot = await import("../../src/lib/monitoring/providerHealthAutopilot.ts");
const connectionsRoute = await import("../../src/app/api/resilience/connections/route.ts");
const monitoringHealthRoute = await import("../../src/app/api/monitoring/health/route.ts");
const providerDiscovery = await import("../../src/lib/a2a/skills/providerDiscovery.ts");

const PROVIDER = "breaker-read-only-provider";

/** The minimal A2A task `executeProviderDiscovery` needs to pick a capability. */
function discoveryTask(): A2ATask {
  const now = new Date().toISOString();
  return {
    id: "task-breaker-read",
    skill: "provider-discovery",
    state: "working",
    input: { skill: "provider-discovery", messages: [{ role: "user", content: "chat" }] },
    artifacts: [],
    events: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
  };
}

test.after(() => {
  breakers.resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let clock = Date.now();

/** An OPEN breaker whose cooldown has elapsed: the state a read used to probe out of. */
async function openBreakerWithElapsedCooldown() {
  breakers.resetAllCircuitBreakers();
  clock = Date.now();
  const breaker = breakers.getCircuitBreaker(PROVIDER, {
    failureThreshold: 1,
    resetTimeout: 1000,
    now: () => clock,
  });
  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("upstream down");
    })
  );
  assert.equal(breaker.state, "OPEN");
  clock += 60_000;
  return breaker;
}

function persistedState(): string {
  return JSON.stringify(domainState.loadCircuitBreakerState(PROVIDER));
}

/** Every read path converted away from the mutating `getAllCircuitBreakerStatuses()`. */
const readPaths: Array<[string, () => Promise<unknown>]> = [
  ["accountFallback.getProvidersInCooldown", async () => accountFallback.getProvidersInCooldown()],
  [
    "webSessionPoolHealth",
    async () => {
      const report = webSessionPoolHealth.getWebSessionPoolHealth(PROVIDER);
      assert.ok(report.providers[0]?.breaker, "the report really read the breaker");
      return report;
    },
  ],
  ["omnirouteStatus", () => omnirouteStatus.buildOmniRouteStatus()],
  ["providerHealthMatrix", () => healthMatrix.buildProviderHealthMatrix({})],
  ["providerHealthAutopilot", () => autopilot.buildProviderHealthAutopilotReport({})],
  [
    "/api/resilience/connections",
    async () => {
      const response = await connectionsRoute.GET(
        new Request("http://localhost/api/resilience/connections")
      );
      assert.equal(response.status, 200, "the route answered, so it really read the breakers");
      return response.json();
    },
  ],
  [
    "a2a providerDiscovery",
    async () => {
      const result = await providerDiscovery.executeProviderDiscovery(discoveryTask());
      assert.ok(result.metadata.totalCandidates > 0, "discovery really listed candidates");
      return result;
    },
  ],
  [
    "/api/monitoring/health",
    async () => {
      monitoringHealthRoute.__test_resetMonitoringHealthPayloadCache();
      const response = await monitoringHealthRoute.GET(
        new Request("http://localhost/api/monitoring/health")
      );
      assert.equal(response.status, 200, "the route answered, so it really read the breakers");
      return response.json();
    },
  ],
];

for (const [name, read] of readPaths) {
  test(`${name} does not probe an OPEN breaker whose cooldown elapsed`, async () => {
    const breaker = await openBreakerWithElapsedCooldown();
    const historyBefore = breaker.transitionHistory.length;
    const persistedBefore = persistedState();
    assert.match(persistedBefore, /"OPEN"/, "the breaker was persisted OPEN");

    await read();
    await read();

    assert.equal(breaker.state, "OPEN", "the read did not move the breaker to HALF_OPEN");
    assert.equal(breaker.transitionHistory.length, historyBefore, "no transition was recorded");
    assert.equal(breaker.halfOpenAllowed, 0, "no half-open probe was granted by the read");
    assert.equal(persistedState(), persistedBefore, "the persisted state is unchanged");
    assert.equal(breaker.canExecute(), true, "live routing still gets its probe afterwards");
    assert.equal(breaker.state, "HALF_OPEN", "and live routing is what transitions the breaker");
  });
}

test("the read paths still report the breaker, with its effective state", async () => {
  await openBreakerWithElapsedCooldown();

  const connections = (await (
    await connectionsRoute.GET(new Request("http://localhost/api/resilience/connections"))
  ).json()) as { breakers: Array<{ name: string; state: string }> };
  const reported = connections.breakers.find((entry) => entry.name === PROVIDER);
  assert.equal(reported?.state, "HALF_OPEN", "the effective state is reported, not caused");

  const status = (await omnirouteStatus.buildOmniRouteStatus()) as {
    circuits: { halfOpen?: number };
  };
  assert.ok((status.circuits.halfOpen ?? 0) >= 1, "omnirouteStatus counted the breaker");

  const pools = webSessionPoolHealth.getWebSessionPoolHealth(PROVIDER);
  assert.equal(pools.providers[0]?.breaker?.state, "HALF_OPEN");
  assert.equal(pools.providers[0]?.breaker?.inCooldown, false, "an elapsed breaker is not blocked");
});

test("a breaker still inside its cooldown is reported in cooldown, without mutating it", async () => {
  breakers.resetAllCircuitBreakers();
  clock = Date.now();
  const breaker = breakers.getCircuitBreaker(PROVIDER, {
    failureThreshold: 1,
    resetTimeout: 600_000,
    now: () => clock,
  });
  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("upstream down");
    })
  );
  const historyBefore = breaker.transitionHistory.length;
  const persistedBefore = persistedState();

  assert.ok(
    accountFallback.getProvidersInCooldown().some((entry) => entry.provider === PROVIDER),
    "an open breaker inside its cooldown is still listed"
  );
  const blocked = breakers.getBlockedCircuitBreakerSnapshots();
  assert.ok(blocked.some((status) => status.name === PROVIDER));
  assert.ok((blocked.find((status) => status.name === PROVIDER)?.retryAfterMs ?? 0) > 0);
  assert.equal(breakers.peekCircuitBreaker(PROVIDER)?.peekCanExecute(), false);

  assert.equal(breaker.state, "OPEN");
  assert.equal(breaker.transitionHistory.length, historyBefore);
  assert.equal(persistedState(), persistedBefore);
});
