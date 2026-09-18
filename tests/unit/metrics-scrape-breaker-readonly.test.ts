/**
 * Scraping metrics must not change routing state: `/api/metrics` and the SLO alert timer read
 * circuit breakers through `getAllCircuitBreakerSnapshots()` (`peekStatus()`), so an OPEN breaker
 * whose cooldown elapsed is reported as HALF_OPEN without transitioning, persisting or consuming
 * its half-open probe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-scrape-breaker-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const breakers = await import("../../src/shared/utils/circuitBreaker.ts");
const { collectMetricsSnapshot } = await import("../../src/lib/monitoring/metricsExposition.ts");

test.after(() => {
  breakers.resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("scraping does not transition an OPEN breaker whose cooldown elapsed", async () => {
  let clock = Date.now();
  const breaker = breakers.getCircuitBreaker("scrape-readonly-provider", {
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
  clock += 5000;
  const historyBefore = breaker.transitionHistory.length;

  const first = await collectMetricsSnapshot();
  const second = await collectMetricsSnapshot();

  assert.equal(breaker.state, "OPEN", "the scrape did not move the breaker to HALF_OPEN");
  assert.equal(breaker.transitionHistory.length, historyBefore, "no transition was recorded");
  assert.equal(breaker.halfOpenAllowed, 0, "no half-open probe was granted by the scrape");
  for (const snapshot of [first, second]) {
    assert.ok(snapshot.breakersByState.HALF_OPEN >= 1, "the effective state is reported");
    assert.equal(snapshot.openProviders.includes("scrape-readonly-provider"), false);
  }

  const snapshot = breakers
    .getAllCircuitBreakerSnapshots()
    .find((status) => status.name === "scrape-readonly-provider");
  assert.equal(snapshot?.state, "HALF_OPEN");
  assert.equal(snapshot?.retryAfterMs, 0);
  assert.equal(breaker.canExecute(), true, "live routing still gets its probe afterwards");
  assert.equal(breaker.state, "HALF_OPEN");
});
