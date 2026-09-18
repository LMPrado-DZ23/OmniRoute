import { NextResponse } from "next/server";
import { PROMETHEUS_CONTENT_TYPE } from "@omniroute/open-sse/services/routing/prometheusText.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  buildMetricsJson,
  collectMetricsSnapshot,
  renderMetricsText,
} from "@/lib/monitoring/metricsExposition";

/**
 * GET /api/metrics — routing metrics and SLO status.
 *
 * Default: Prometheus text exposition (format 0.0.4). `?format=json`: JSON summary.
 * Always requires management auth (dashboard session or a `manage`-scoped API
 * key as Bearer), even under requireLogin=false — the payload names providers
 * and models in use. Labels are bounded and never carry keys, connection ids,
 * account ids, prompts or responses (see docs/ops/MONITORING_GUIDE.md).
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const snapshot = await collectMetricsSnapshot();
    const format = new URL(request.url).searchParams.get("format");
    if (format === "json") {
      return NextResponse.json(buildMetricsJson(snapshot), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(renderMetricsText(snapshot), {
      status: 200,
      headers: { "Content-Type": PROMETHEUS_CONTENT_TYPE, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
