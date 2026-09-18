import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getRoutingDecision } from "@omniroute/open-sse/services/routing/decisionStore.ts";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A recent live routing decision, by decision id or request id. Decisions are kept in memory for
 * 30 minutes. An unknown id and a malformed id get the same 404, so the answer reveals nothing
 * beyond whether a decision with that exact id exists.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const decision = SAFE_ID.test(id) ? getRoutingDecision(id) : null;
  if (!decision) {
    return NextResponse.json({ error: "Routing decision not found" }, { status: 404 });
  }
  return NextResponse.json({ decision });
}
