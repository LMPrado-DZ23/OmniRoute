import { withWorkspaceErrors } from "@/lib/workspaces/http";
import {
  handleDeleteWorkspace,
  handleGetWorkspace,
  handleUpdateWorkspace,
} from "@/lib/workspaces/workspaceHandlers";

type Context = { params: Promise<{ id: string }> };

// GET /api/workspaces/{id} — workspace, projects and rolled-up spend.
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withWorkspaceErrors(() => handleGetWorkspace(request, id));
}

// PATCH /api/workspaces/{id} — rename, describe or set the workspace budget.
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withWorkspaceErrors(() => handleUpdateWorkspace(request, id));
}

// DELETE /api/workspaces/{id} — delete an empty workspace.
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withWorkspaceErrors(() => handleDeleteWorkspace(request, id));
}
