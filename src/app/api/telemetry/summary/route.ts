import { NextResponse } from "next/server";
import { buildTelemetryPayload } from "@/lib/monitoring/observability";
import { getTelemetrySummary } from "@/shared/utils/requestTelemetry";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { routingMetrics } from "@omniroute/open-sse/services/routing/metricsSink.ts";

export async function GET(request) {
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
