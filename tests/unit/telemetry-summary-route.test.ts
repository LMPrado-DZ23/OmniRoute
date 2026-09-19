import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../src/app/api/telemetry/summary/route.ts";
import { RequestTelemetry, recordTelemetry } from "../../src/shared/utils/requestTelemetry.ts";
import { clearQuotaMonitors, startQuotaMonitor } from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

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

  const response = await GET(
    new Request("http://localhost:20128/api/telemetry/summary?windowMs=600000")
  );
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

  const empty = (await (
    await GET(new Request("http://localhost:20128/api/telemetry/summary?windowMs=300000"))
  ).json()) as { errorRate: number };
  assert.equal(empty.errorRate, 0);

  const base = { requestId: "r", provider: "openai", model: "gpt-4o", latencyMs: 100 };
  for (let i = 0; i < 3; i++) {
    routingMetrics.record(createRoutingEvent({ ...base, outcome: "success", status: 200 }));
  }
  routingMetrics.record(createRoutingEvent({ ...base, outcome: "error", status: 502 }));
  // Neutral outcomes (client cancel) are excluded from the denominator.
  routingMetrics.record(createRoutingEvent({ ...base, outcome: "cancelled", status: null }));

  const response = await GET(
    new Request("http://localhost:20128/api/telemetry/summary?windowMs=300000")
  );
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
