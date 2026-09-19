import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../src/app/api/telemetry/summary/route.ts";
import { RequestTelemetry, recordTelemetry } from "../../src/shared/utils/requestTelemetry.ts";
import { clearQuotaMonitors, startQuotaMonitor } from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

// The route always requires management auth (even under requireLogin=false), so
// these payload-semantics tests authenticate the way a scraper does: with a
// manage-scoped API key. The auth contract itself is pinned in
// tests/unit/api/stable-candidates/core-read-contract.test.ts.
process.env.API_KEY_SECRET ||= "telemetry-summary-route-test-secret";
let manageKey = "";

test.before(async () => {
  const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
  manageKey = (await apiKeysDb.createApiKey("telemetry-route", "test", ["manage"])).key;
});

function telemetryRequest(windowMs: number): Request {
  return new Request(`http://localhost:20128/api/telemetry/summary?windowMs=${windowMs}`, {
    headers: { Authorization: `Bearer ${manageKey}` },
  });
}

test.afterEach(() => {
  clearQuotaMonitors();
  clearSessions();
});

test("telemetry summary route includes totalRequests alias plus session/quota monitor signals", async () => {
  const telemetry = new RequestTelemetry("telemetry-route");
  telemetry.startPhase("parse");
  telemetry.endPhase();
  recordTelemetry(telemetry);

  touchSession("sess-route", "conn-route");
  startQuotaMonitor("sess-route", "codex", "conn-route", {
    providerSpecificData: { quotaMonitorEnabled: true },
  });

  const response = await GET(telemetryRequest(600000));
  const payload = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.ok(payload.totalRequests >= 1);
  assert.equal(payload.sessions.activeCount, 1);
  assert.equal(payload.sessions.stickyBoundCount, 1);
  assert.equal(payload.quotaMonitor.active, 1);
});

test("errorRate is failed/routed requests in the window, not quota-monitor errors per request", async () => {
  const { routingMetrics } = await import("../../open-sse/services/routing/metricsSink.ts");
  const { createRoutingEvent } = await import("../../open-sse/services/routing/events.ts");
  routingMetrics.reset();

  const empty = (await (await GET(telemetryRequest(300000))).json()) as { errorRate: number };
  assert.equal(empty.errorRate, 0);

  const base = { requestId: "r", provider: "openai", model: "gpt-4o", latencyMs: 100 };
  for (let i = 0; i < 3; i++) {
    routingMetrics.record(createRoutingEvent({ ...base, outcome: "success", status: 200 }));
  }
  routingMetrics.record(createRoutingEvent({ ...base, outcome: "error", status: 502 }));
  // Neutral outcomes (client cancel) are excluded from the denominator.
  routingMetrics.record(createRoutingEvent({ ...base, outcome: "cancelled", status: null }));

  const response = await GET(telemetryRequest(300000));
  const payload = (await response.json()) as {
    errorRate: number;
    quotaMonitor: { errors: number };
  };
  assert.equal(response.status, 200);
  assert.equal(payload.quotaMonitor.errors, 0);
  // Pre-fix this was quotaMonitor.errors / totalRequests * 100 = 0 despite a failed request.
  assert.equal(payload.errorRate, 25);
  routingMetrics.reset();
});
