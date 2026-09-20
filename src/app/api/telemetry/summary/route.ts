import { NextResponse } from "next/server";
import { buildTelemetryPayload } from "@/lib/monitoring/observability";
import { getTelemetrySummary } from "@/shared/utils/requestTelemetry";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { routingMetrics } from "@omniroute/open-sse/services/routing/metricsSink.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

/**
 * GET /api/telemetry/summary — request volume, latency and routed error rate.
 *
 * Management-scoped, with the default requireManagementAuth options: when login
 * is required, an anonymous caller gets 401 and an under-scoped key 403; with
 * requireLogin=false the route is open like the rest of the management surface
 * (the documented local-only mode), so the dashboard TelemetryCard keeps
 * working on keyless installs. Deliberately NOT `alwaysRequireAuth` (unlike
 * /api/metrics, which the dashboard never calls). The handler-level check is
 * defence in depth behind the central authz middleware.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const windowMs = parseInt(searchParams.get("windowMs") || "300000", 10);
    const summary = getTelemetrySummary(windowMs);
    const { getQuotaMonitorSummary } = await import("@omniroute/open-sse/services/quotaMonitor.ts");
    const { getActiveSessions } = await import("@omniroute/open-sse/services/sessionManager.ts");
    const quotaMonitorSummary = getQuotaMonitorSummary();
    const activeSessions = getActiveSessions();
    const payload = buildTelemetryPayload({
      summary,
      quotaMonitorSummary,
      activeSessions,
    });
    // errorRate (%) = failed / (success + failed) routed requests in the same window.
    // It previously divided quota-monitor poll errors by request count — two
    // unrelated populations. Window is clamped to 1..60 minutes by the registry.
    const routingWindow = routingMetrics.window(windowMs);
    const routedRequests = routingWindow.success + routingWindow.failed;
    return NextResponse.json({
      ...payload,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      activeConnections: activeSessions.length,
      errorRate: routedRequests > 0 ? (routingWindow.failed / routedRequests) * 100 : 0,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
