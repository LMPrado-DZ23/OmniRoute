import { handleSetProjectKeys } from "@/lib/workspaces/projectHandlers";

type Context = { params: Promise<{ id: string; projectId: string }> };

// PUT /api/workspaces/{id}/projects/{projectId}/keys — replace the project's API key set.
export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const { id, projectId } = await params;
  return handleSetProjectKeys(request, id, projectId);
}
