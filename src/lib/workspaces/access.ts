/**
 * Workspace authorization (docs/architecture/WORKSPACES_RBAC.md, section 3.4).
 *
 * 1. `requireManagementAuth` decides whether the credential may call the management API at
 *    all (and, for CLI access tokens, whether its scope covers the method + path).
 * 2. `resolveWorkspaceCaller` then names the caller from the SAME credential, in the same
 *    order: the dashboard session, auth-disabled mode, the loopback CLI machine token and
 *    trusted in-process service calls are the owner (every workspace); a management API key
 *    is `api_key:<id>`, a CLI access token is `access_token:<id>`.
 * 3. `authorizeWorkspace` resolves the workspace, then checks membership. A workspace the
 *    caller is not a member of answers exactly like one that does not exist (same 404 body),
 *    so a foreign id cannot be probed. A `viewer` member may read but not write (403).
 */
import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isTrustedLoopbackInternalServiceRequest } from "@/lib/api/internalServiceAuth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getMemberRole, getWorkspace, type Workspace } from "@/lib/db/workspaces";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import { evaluateAccessTokenAuth } from "@/server/authz/accessTokenAuth";
import { AUTHZ_HEADER_AUTH_KIND, AUTHZ_HEADER_AUTH_LABEL } from "@/server/authz/headers";
import { extractApiKey } from "@/sse/services/auth";
import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

export interface WorkspaceCaller {
  /** The owner sees and manages every workspace; `principal` is then `null`. */
  isOwner: boolean;
  principal: string | null;
}

export type WorkspaceAccessNeed = "read" | "write";

export interface WorkspaceAccess {
  /** `null` when access is refused; `response` then carries the refusal. */
  workspace: Workspace | null;
  response: Response | null;
  /** `owner`, or the caller's member role. */
  role: "owner" | "admin" | "viewer" | null;
}

const OWNER: WorkspaceCaller = { isOwner: true, principal: null };

export const WORKSPACE_NOT_FOUND_BODY = { error: { message: "Workspace not found" } } as const;

export function workspaceNotFound(): Response {
  return NextResponse.json(WORKSPACE_NOT_FOUND_BODY, { status: 404 });
}

export function forbidden(message: string): Response {
  return NextResponse.json({ error: { message } }, { status: 403 });
}

function isLoopbackCliStamp(request: Request): boolean {
  return (
    request.headers.get(AUTHZ_HEADER_AUTH_KIND) === "management_key" &&
    request.headers.get(AUTHZ_HEADER_AUTH_LABEL) === "local-cli-token"
  );
}

async function isOwnerCredential(request: Request): Promise<boolean> {
  if (!(await isAuthRequired(request))) return true;
  if (await isDashboardSessionAuthenticated(request)) return true;
  if (isTrustedLoopbackInternalServiceRequest(request)) return true;
  if (isLoopbackCliStamp(request)) return true;
  return isCliTokenAuthValid(request);
}

async function principalOf(request: Request): Promise<string | null> {
  const token = evaluateAccessTokenAuth(request);
  if (token.kind === "ok") return `access_token:${token.id}`;
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (!apiKey) return null;
  const meta = await getApiKeyMetadata(apiKey);
  return meta?.id ? `api_key:${meta.id}` : null;
}

/**
 * Authenticate the request and name the caller. Returns the refusal `response` when the
 * credential may not use the management API, or cannot be tied to a principal (fail closed).
 */
export async function resolveWorkspaceCaller(
  request: Request | null | undefined
): Promise<{ caller: WorkspaceCaller | null; response: Response | null }> {
  const authError = await requireManagementAuth(request);
  if (authError) return { caller: null, response: authError };
  // Direct in-process invocation without a Request is the trusted local caller, exactly as
  // requireManagementAuth treats it.
  if (!request || (await isOwnerCredential(request))) return { caller: OWNER, response: null };
  const principal = await principalOf(request);
  if (!principal) {
    return {
      caller: null,
      response: NextResponse.json(
        { error: { message: "Authentication required" } },
        { status: 401 }
      ),
    };
  }
  return { caller: { isOwner: false, principal }, response: null };
}

/** Resolve `workspaceId` for `caller`; see the module comment for the refusal rules. */
export function authorizeWorkspace(
  caller: WorkspaceCaller,
  workspaceId: string,
  need: WorkspaceAccessNeed
): WorkspaceAccess {
  const workspace = getWorkspace(workspaceId);
  if (caller.isOwner) {
    return workspace
      ? { workspace, response: null, role: "owner" }
      : { workspace: null, response: workspaceNotFound(), role: null };
  }
  const role = workspace ? getMemberRole(workspace.id, caller.principal ?? "") : null;
  if (!workspace || !role) return { workspace: null, response: workspaceNotFound(), role: null };
  if (need === "write" && role !== "admin") {
    return {
      workspace: null,
      response: forbidden("Workspace role 'viewer' cannot modify this workspace"),
      role,
    };
  }
  return { workspace, response: null, role };
}

/** Whether `caller` can see `workspaceId` at all (owner, or any member role). */
export function canSeeWorkspace(caller: WorkspaceCaller, workspaceId: string): boolean {
  if (caller.isOwner) return true;
  return getMemberRole(workspaceId, caller.principal ?? "") !== null;
}
