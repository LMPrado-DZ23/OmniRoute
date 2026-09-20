/**
 * Handlers for `/api/workspaces/{id}/members/**`. Reading the member list needs any
 * membership; changing it needs the workspace `admin` role (or the owner).
 */
import { NextResponse } from "next/server";

import { listMembers, removeMember, upsertMember } from "@/lib/db/workspaces";

import { authorizeWorkspace, resolveWorkspaceCaller } from "./access";
import { auditWorkspaceChange, errorJson, parseBody } from "./http";
import { MEMBER_PRINCIPAL_PATTERN, upsertMemberSchema } from "./schemas";

async function authorized(request: Request, workspaceId: string, need: "read" | "write") {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  return authorizeWorkspace(caller, workspaceId, need).response;
}

/** GET /api/workspaces/{id}/members */
export async function handleListMembers(request: Request, workspaceId: string): Promise<Response> {
  const refusal = await authorized(request, workspaceId, "read");
  if (refusal) return refusal;
  return NextResponse.json({ members: listMembers(workspaceId) });
}

/** POST /api/workspaces/{id}/members — add a member or change its role. */
export async function handleUpsertMember(request: Request, workspaceId: string): Promise<Response> {
  const refusal = await authorized(request, workspaceId, "write");
  if (refusal) return refusal;
  const body = await parseBody(request, upsertMemberSchema);
  if (body.response) return body.response;
  upsertMember(workspaceId, body.data.principal, body.data.role);
  auditWorkspaceChange(request, "workspace.member.upsert", workspaceId, {
    principal: body.data.principal,
    memberRole: body.data.role,
  });
  return NextResponse.json({ members: listMembers(workspaceId) });
}

/** DELETE /api/workspaces/{id}/members/{principal} */
export async function handleRemoveMember(
  request: Request,
  workspaceId: string,
  principal: string
): Promise<Response> {
  const refusal = await authorized(request, workspaceId, "write");
  if (refusal) return refusal;
  if (!MEMBER_PRINCIPAL_PATTERN.test(principal) || !removeMember(workspaceId, principal)) {
    return errorJson(404, "Member not found", "member_not_found");
  }
  auditWorkspaceChange(request, "workspace.member.remove", workspaceId, { principal });
  return NextResponse.json({ members: listMembers(workspaceId) });
}
