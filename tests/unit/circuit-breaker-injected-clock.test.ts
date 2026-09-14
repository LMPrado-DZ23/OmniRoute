/**
 * The circuit breaker read Date.now() directly, so cooldown and half-open transitions could only
 * be tested against wall-clock time, and reading its status moved an OPEN breaker to HALF_OPEN.
 * An injected clock makes the transitions deterministic, and peekState() reads the effective
 * state without changing it.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { CircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");

function breakerWithClock(start: number) {
  const clock = { now: start };
  const breaker = new CircuitBreaker(`clock-test-${start}`, {
    failureThreshold: 1,
    resetTimeout: 1000,
    now: () => clock.now,
  });
  return { breaker, clock };
}

test("failure time and cooldown follow the injected clock", () => {
  const { breaker, clock } = breakerWithClock(5_000_000);
  breaker._onFailure();

  assert.equal(breaker.state, "OPEN");
  assert.equal(breaker.lastFailureTime, 5_000_000);
  clock.now += 400;
  assert.equal(breaker.getRetryAfterMs(), 600);
  assert.equal(breaker.transitionHistory.at(-1)?.timestamp, 5_000_000);
});

test("peekState reports HALF_OPEN after the cooldown without transitioning", () => {
  const { breaker, clock } = breakerWithClock(7_000_000);
  breaker._onFailure();

  clock.now += 999;
  assert.equal(breaker.peekState(), "OPEN");
  clock.now += 1;
  assert.equal(breaker.peekState(), "HALF_OPEN");
  assert.equal(breaker.state, "OPEN", "peeking must not move the breaker");
  assert.equal(breaker.transitionHistory.length, 1);

  assert.equal(breaker.getStatus().state, "HALF_OPEN", "getStatus still performs the transition");
  assert.equal(breaker.state, "HALF_OPEN");
  assert.equal(breaker.transitionHistory.at(-1)?.timestamp, 7_001_000);
});

test("without an injected clock the breaker keeps using Date.now", () => {
  const breaker = new CircuitBreaker("clock-test-default", { failureThreshold: 1 });
  const before = Date.now();
  breaker._onFailure();
  const after = Date.now();
  assert.ok(breaker.lastFailureTime !== null);
  assert.ok(breaker.lastFailureTime >= before && breaker.lastFailureTime <= after);
});
