import { withWorkspaceErrors } from "@/lib/workspaces/http";
import { handleCreateWorkspace, handleListWorkspaces } from "@/lib/workspaces/workspaceHandlers";

// GET /api/workspaces — workspaces visible to the caller (owner: all; others: memberships).
export async function GET(request: Request): Promise<Response> {
  return withWorkspaceErrors(() => handleListWorkspaces(request));
}

// POST /api/workspaces — create a workspace.
export async function POST(request: Request): Promise<Response> {
  return withWorkspaceErrors(() => handleCreateWorkspace(request));
}
