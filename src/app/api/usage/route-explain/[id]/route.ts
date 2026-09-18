import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { explainRouteByRequestId } from "@/lib/usage/routeExplain";
import { getRoutingDecision } from "@omniroute/open-sse/services/routing/decisionStore.ts";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;

    const { id } = await params;
    const explanation = await explainRouteByRequestId(id);

    if (!explanation) {
      return NextResponse.json({ error: "Routing decision not found" }, { status: 404 });
    }

    // Additive: the live routing decision recorded under this request id, when still retained.
    const decision = getRoutingDecision(id);
    const routingDecision = decision?.requestId === id ? decision : null;
    return NextResponse.json({ ...explanation, routingDecision });
  } catch (error) {
    console.error("[API ERROR] /api/usage/route-explain/[id] failed:", error);
    return NextResponse.json({ error: "Failed to explain route" }, { status: 500 });
  }
}
