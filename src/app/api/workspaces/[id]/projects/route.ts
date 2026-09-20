import { withWorkspaceErrors } from "@/lib/workspaces/http";
import { handleCreateProject, handleListProjects } from "@/lib/workspaces/projectHandlers";

type Context = { params: Promise<{ id: string }> };

// GET /api/workspaces/{id}/projects
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withWorkspaceErrors(() => handleListProjects(request, id));
}

// POST /api/workspaces/{id}/projects
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return withWorkspaceErrors(() => handleCreateProject(request, id));
}
