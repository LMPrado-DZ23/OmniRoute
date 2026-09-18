/**
 * GET /api/metrics — Prometheus text + JSON summary, management auth only,
 * bounded labels without connection ids / keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-metrics-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/metrics/route.ts");
const { routingMetrics } = await import("../../open-sse/services/routing/metricsSink.ts");
const { createRoutingEvent } = await import("../../open-sse/services/routing/events.ts");

test.after(() => {
  routingMetrics.reset();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const CONNECTION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function seed(): void {
  routingMetrics.reset();
  routingMetrics.record(
    createRoutingEvent({
      requestId: "r1",
      provider: "openai",
      model: "gpt-4o",
      strategy: "priority",
      latencyMs: 800,
      ttftMs: 120,
      inputTokens: 10,
      outputTokens: 5,
      outcome: "success",
      status: 200,
      connectionId: CONNECTION_ID,
    })
  );
  routingMetrics.record(
    createRoutingEvent({
      requestId: "r2",
      provider: "openai",
      model: "gpt-4o",
      latencyMs: 30_000,
      outcome: "timeout",
      status: 504,
      connectionId: CONNECTION_ID,
    })
  );
}

test("anonymous callers are rejected", async () => {
  const res = await route.GET(new Request("http://localhost/api/metrics"));
  assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
});

test("management session receives Prometheus text without connection ids", async () => {
  seed();
  const req = await makeManagementSessionRequest("http://localhost/api/metrics");
  const res = await route.GET(req);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
  const text = await res.text();
  assert.ok(text.includes("# TYPE omniroute_requests_total counter"));
  assert.ok(text.includes('omniroute_requests_total{provider="openai",outcome="timeout"} 1'));
  assert.ok(text.includes("# TYPE omniroute_ttft_ms histogram"));
  assert.ok(text.includes("# TYPE omniroute_circuit_breakers gauge"));
  assert.ok(text.includes('omniroute_slo_objective_threshold{objective="availability"} 0.99'));
  assert.equal(text.includes(CONNECTION_ID), false);
  for (const line of text.split("\n")) {
    const labels = line.match(/\{([^}]*)\}/)?.[1] ?? "";
    for (const name of labels.matchAll(/(\w+)="/g)) {
      assert.ok(
        [
          "provider",
          "model",
          "strategy",
          "outcome",
          "status_class",
          "direction",
          "engine",
          "le",
          "state",
          "status",
          "objective",
        ].includes(name[1]),
        `unexpected label name ${name[1]}`
      );
    }
  }
});

test("format=json returns totals, window percentiles and SLO report", async () => {
  seed();
  const req = await makeManagementSessionRequest("http://localhost/api/metrics?format=json");
  const res = await route.GET(req);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    totals: { requests: number; success: number; failed: number; timeouts: number };
    window: { total: number; latency: { p50: number | null } };
    slo: { objectives: Array<{ objective: string }> };
  };
  assert.equal(body.totals.requests, 2);
  assert.equal(body.totals.success, 1);
  assert.equal(body.totals.failed, 1);
  assert.equal(body.totals.timeouts, 1);
  assert.equal(body.window.total, 2);
  assert.notEqual(body.window.latency.p50, null);
  assert.equal(body.slo.objectives.length, 7);
  assert.equal(JSON.stringify(body).includes(CONNECTION_ID), false);
});
