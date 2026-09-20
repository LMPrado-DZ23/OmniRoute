/**
 * The latency budget must not refuse a candidate on a guess.
 *
 * `latencyBudget.ts` promised that "candidates and targets whose latency is unknown are
 * treated as within budget", but on the candidate path that state was unreachable:
 * `resolveP95LatencyMs` always returns a number, falling back to `getBootstrapLatencyMs`,
 * a hardcoded per-model table (`claude-opus-4.6: 6000`, everything unlisted: 1500). So an
 * unmeasured model was indistinguishable from a measured one, and on a fresh install
 * `X-OmniRoute-Latency-Budget: 1000` permanently excluded every model — on no evidence.
 *
 * Worse, it was self-sealing: the traffic that would replace the guess with a real p95 can
 * only happen if the candidate is allowed through.
 *
 * `resolveLatencyProfile` now marks the bootstrap fallback with `latencyIsEstimated`, and
 * both the selection filter and the failover filter honour it — as does the recorded
 * decision, so an explanation never claims an exclusion that did not happen.
 *
 * The pre-existing suite could not catch this: it builds candidates with explicit
 * `p95LatencyMs`, so it never exercises the bootstrap path at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { candidatesWithinLatencyBudget, dropTargetsOverLatencyBudget } =
  await import("../../open-sse/services/combo/latencyBudget.ts");

const measured = (executionKey: string, p95LatencyMs: number) => ({
  executionKey,
  p95LatencyMs,
  latencyIsEstimated: false,
});
const guessed = (executionKey: string, p95LatencyMs: number) => ({
  executionKey,
  p95LatencyMs,
  latencyIsEstimated: true,
});

test("a budget refuses a measured candidate but keeps an unmeasured one", () => {
  const kept = candidatesWithinLatencyBudget(
    [measured("fast", 400), measured("slow", 5000), guessed("unknown", 6000)],
    1000
  );

  assert.deepEqual(
    kept.map((c) => c.executionKey),
    ["fast", "unknown"],
    "the 5000 ms measurement is evidence of a breach; the 6000 ms bootstrap default is not"
  );
});

test("a candidate that does not declare the flag is still treated as measured", () => {
  // Every caller that was already measuring keeps its old behaviour — the flag only ever
  // widens what is allowed through, never narrows it.
  const kept = candidatesWithinLatencyBudget(
    [{ executionKey: "legacy", p95LatencyMs: 5000 }],
    1000
  );

  assert.deepEqual(kept, []);
});

test("no budget keeps every candidate, measured or not", () => {
  const candidates = [measured("slow", 9000), guessed("unknown", 9000)];

  assert.deepEqual(candidatesWithinLatencyBudget(candidates, undefined), candidates);
});

test("the failover chain drops measured over-budget targets and keeps unmeasured ones", () => {
  const targets = [
    { executionKey: "fast" },
    { executionKey: "slow" },
    { executionKey: "unknown" },
    { executionKey: "no-candidate-row" },
  ];
  const candidates = [measured("fast", 400), measured("slow", 5000), guessed("unknown", 6000)];

  const chain = dropTargetsOverLatencyBudget(targets, candidates, 1000);

  assert.deepEqual(
    chain.map((t) => t.executionKey),
    ["fast", "unknown", "no-candidate-row"],
    "an unmeasured candidate must behave exactly like a target with no candidate row"
  );
});

test("order is preserved — the filter never reshuffles the chain", () => {
  const targets = [{ executionKey: "c" }, { executionKey: "a" }, { executionKey: "b" }];
  const candidates = [measured("a", 100), measured("b", 200), measured("c", 300)];

  assert.deepEqual(
    dropTargetsOverLatencyBudget(targets, candidates, 5000).map((t) => t.executionKey),
    ["c", "a", "b"]
  );
});
