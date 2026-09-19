import { handleListMembers, handleUpsertMember } from "@/lib/workspaces/memberHandlers";

type Context = { params: Promise<{ id: string }> };

// GET /api/workspaces/{id}/members
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return handleListMembers(request, id);
}

// POST /api/workspaces/{id}/members — add a member or change its role.
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return handleUpsertMember(request, id);
}
