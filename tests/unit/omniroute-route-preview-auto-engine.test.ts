/**
 * POST /api/omniroute/route/preview with `engine: "auto"` runs the live auto-combo selection
 * engine on the supplied candidates and returns the full routing decision. It must not call an
 * upstream provider, must not change live routing state, and the original `{ candidates }`
 * preview must keep its response shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-route-preview-auto-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { POST } = await import("../../src/app/api/omniroute/route/preview/route.ts");
const { getSelfHealingManager } = await import("../../open-sse/services/autoCombo/selfHealing.ts");

const originalFetch = globalThis.fetch;
let upstreamCalls = 0;

test.before(() => {
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("route preview must not call any upstream");
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/omniroute/route/preview", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

const autoBody = {
  engine: "auto",
  request: { model: "auto/coding", budget: { maxLatencyMs: 1500 } },
  policy: { name: "preview-auto-combo" },
  candidates: [
    {
      provider: "alpha",
      model: "alpha-model",
      costPer1MTokens: 1,
      p95LatencyMs: 300,
      quotaRemaining: 80,
    },
    { provider: "beta", model: "beta-model", costPer1MTokens: 1, p95LatencyMs: 3000 },
    {
      provider: "gamma",
      model: "gamma-model",
      costPer1MTokens: 1,
      p95LatencyMs: 400,
      circuitBreakerState: "OPEN",
    },
  ],
};

type Decision = {
  decisionId: string;
  requestId: string;
  policyVersion: string;
  liveRequestExecuted: boolean;
  selected?: { providerId: string };
  candidates: Array<{
    providerId: string;
    eligible: boolean;
    exclusionReasons: string[];
    quota: string;
    circuit: string;
    estimatedCostUsd: number | null;
    estimatedLatencyMs: number | null;
    factors: unknown[];
  }>;
};

test("auto engine preview returns an explainable decision without side effects", async () => {
  const res = await post(autoBody, { "x-request-id": "req-preview-7" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    selected: string | null;
    liveRequestExecuted: boolean;
    request: { candidateCount: number };
    decision: Decision;
  };

  assert.equal(body.selected, "alpha");
  assert.equal(body.liveRequestExecuted, false);
  assert.equal(body.request.candidateCount, 3);
  assert.equal(body.decision.requestId, "req-preview-7");
  assert.equal(res.headers.get("x-request-id"), "req-preview-7");
  assert.equal(res.headers.get("x-omniroute-decision-id"), body.decision.decisionId);
  assert.match(body.decision.policyVersion, /^rp_[0-9a-f]{16}$/);

  const byId = new Map(body.decision.candidates.map((c) => [c.providerId, c]));
  assert.deepEqual(byId.get("beta")?.exclusionReasons, ["latency_over_budget"]);
  assert.deepEqual(byId.get("gamma")?.exclusionReasons, ["circuit_open"]);
  assert.equal(byId.get("gamma")?.circuit, "open");
  assert.equal(byId.get("alpha")?.quota, "available");
  assert.equal(byId.get("beta")?.quota, "unknown", "no quotaRemaining means no quota signal");
  assert.equal(byId.get("alpha")?.estimatedLatencyMs, 300);
  assert.ok((byId.get("alpha")?.factors.length ?? 0) > 0);

  assert.equal(upstreamCalls, 0);
  assert.equal(getSelfHealingManager().getStatus().exclusionCount, 0);
});

test("an unsafe x-request-id header is replaced instead of echoed", async () => {
  const res = await post(autoBody, { "x-request-id": "bad id with spaces" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-request-id") ?? "", /^preview-[0-9a-f-]{36}$/);
});

test("an invalid auto engine body is rejected with 400", async () => {
  const res = await post({ engine: "auto", candidates: [] });
  assert.equal(res.status, 400);
});

test("the original candidates preview keeps its response shape", async () => {
  const res = await post({
    candidates: [
      {
        providerId: "provider-allowed",
        modelId: "model-x",
        allocation: "allow",
        capabilityScore: 0.9,
        healthScore: 1,
        circuit: "closed",
        quota: "healthy",
      },
    ],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "candidates",
    "liveRequestExecuted",
    "request",
    "selected",
  ]);
  assert.equal(body.selected, "provider-allowed");
});
