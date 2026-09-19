import { handleRemoveMember } from "@/lib/workspaces/memberHandlers";

type Context = { params: Promise<{ id: string; principal: string }> };

// DELETE /api/workspaces/{id}/members/{principal}
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { id, principal } = await params;
  return handleRemoveMember(request, id, principal);
}
