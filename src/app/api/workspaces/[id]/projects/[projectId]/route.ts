import { withWorkspaceErrors } from "@/lib/workspaces/http";
import {
  handleDeleteProject,
  handleGetProject,
  handleUpdateProject,
} from "@/lib/workspaces/projectHandlers";

type Context = { params: Promise<{ id: string; projectId: string }> };

// GET /api/workspaces/{id}/projects/{projectId}
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id, projectId } = await params;
  return withWorkspaceErrors(() => handleGetProject(request, id, projectId));
}

// PATCH /api/workspaces/{id}/projects/{projectId}
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { id, projectId } = await params;
  return withWorkspaceErrors(() => handleUpdateProject(request, id, projectId));
}

// DELETE /api/workspaces/{id}/projects/{projectId}
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { id, projectId } = await params;
  return withWorkspaceErrors(() => handleDeleteProject(request, id, projectId));
}
