import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { revokeAccessTokenIds } from "@/lib/db/accessTokens";
import { logAdminAuditEvent } from "@/lib/compliance/adminAuditActor";

/**
 * DELETE /api/cli/tokens/:id — revoke an access token (by id or display prefix).
 * Admin-only (same enforcement as the collection route). Idempotent: revoking
 * an unknown/already-revoked token returns 404.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const revokedIds = revokeAccessTokenIds(id);
  if (revokedIds.length === 0) {
    return NextResponse.json({ error: "Token not found or already revoked" }, { status: 404 });
  }
  // Audit the record id, never the display prefix the caller may have used (same rule as create).
  for (const revokedId of revokedIds) {
    logAdminAuditEvent(request, {
      action: "accessToken.revoke",
      target: revokedId,
      resourceType: "cli_access_token",
    });
  }
  return NextResponse.json({ success: true, id });
}
