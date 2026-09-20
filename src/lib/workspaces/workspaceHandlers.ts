/**
 * Handlers for `/api/workspaces` and `/api/workspaces/{id}`. Route files stay thin wrappers.
 */
import { NextResponse } from "next/server";

import {
  createWorkspace,
  deleteWorkspace,
  isWorkspaceNameTaken,
  listProjects,
  listWorkspaces,
  updateWorkspace,
  type HierarchyBudget,
  type Project,
  type Workspace,
} from "@/lib/db/workspaces";
import { childBudgetExceedsParent, describeLevel } from "@/lib/usage/workspaceBudgets";

import { authorizeWorkspace, resolveWorkspaceCaller } from "./access";
import { BUDGET_EXCEEDS_PARENT_MESSAGE, auditWorkspaceChange, errorJson, parseBody } from "./http";
import { createHierarchyNodeSchema, updateHierarchyNodeSchema } from "./schemas";

function withSpend(workspace: Workspace) {
  return { ...workspace, spend: describeLevel("workspace", workspace.id, workspace.budget) };
}

export function projectWithSpend(project: Project) {
  return { ...project, spend: describeLevel("project", project.id, project.budget) };
}

function budgetFields(budget: Partial<HierarchyBudget> | undefined): string[] {
  return budget ? Object.keys(budget) : [];
}

/** GET /api/workspaces — the workspaces the caller can see. */
export async function handleListWorkspaces(request: Request): Promise<Response> {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  const workspaces = listWorkspaces(caller.isOwner ? null : caller.principal);
  return NextResponse.json({ workspaces: workspaces.map(withSpend) });
}

/** POST /api/workspaces — a non-owner creator becomes the workspace admin. */
export async function handleCreateWorkspace(request: Request): Promise<Response> {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  const body = await parseBody(request, createHierarchyNodeSchema);
  if (body.response) return body.response;
  if (isWorkspaceNameTaken(body.data.name)) {
    return errorJson(409, "A workspace with this name already exists", "name_taken");
  }
  const workspace = createWorkspace(
    body.data,
    caller.isOwner ? "owner" : (caller.principal ?? "unknown"),
    caller.isOwner ? null : caller.principal
  );
  auditWorkspaceChange(request, "workspace.create", workspace.id, {
    budgetFields: budgetFields(body.data.budget),
  });
  return NextResponse.json({ workspace: withSpend(workspace) }, { status: 201 });
}

/** GET /api/workspaces/{id} — the workspace, its projects and every level's spend. */
export async function handleGetWorkspace(request: Request, id: string): Promise<Response> {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  const access = authorizeWorkspace(caller, id, "read");
  if (access.response) return access.response;
  return NextResponse.json({
    workspace: withSpend(access.workspace),
    role: access.role,
    projects: listProjects(access.workspace.id).map(projectWithSpend),
  });
}

function projectAboveNewParent(workspaceId: string, parent: HierarchyBudget): boolean {
  return listProjects(workspaceId).some((project) =>
    childBudgetExceedsParent(project.budget, parent)
  );
}

/** PATCH /api/workspaces/{id} — name, description and/or budget. */
export async function handleUpdateWorkspace(request: Request, id: string): Promise<Response> {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  const access = authorizeWorkspace(caller, id, "write");
  if (access.response) return access.response;
  const body = await parseBody(request, updateHierarchyNodeSchema);
  if (body.response) return body.response;
  if (body.data.name && isWorkspaceNameTaken(body.data.name, id)) {
    return errorJson(409, "A workspace with this name already exists", "name_taken");
  }
  if (body.data.budget) {
    const next = { ...access.workspace.budget, ...body.data.budget };
    if (projectAboveNewParent(id, next)) {
      return errorJson(400, BUDGET_EXCEEDS_PARENT_MESSAGE, "budget_exceeds_parent");
    }
  }
  const updated = updateWorkspace(id, body.data);
  auditWorkspaceChange(request, "workspace.update", id, {
    fields: Object.keys(body.data),
    budgetFields: budgetFields(body.data.budget),
  });
  return NextResponse.json({ workspace: withSpend(updated) });
}

/** DELETE /api/workspaces/{id} — only an empty workspace (no projects) can be deleted. */
export async function handleDeleteWorkspace(request: Request, id: string): Promise<Response> {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return response;
  const access = authorizeWorkspace(caller, id, "write");
  if (access.response) return access.response;
  const outcome = deleteWorkspace(id);
  if (outcome === "not_empty") {
    return errorJson(409, "Delete the workspace's projects first", "workspace_not_empty");
  }
  auditWorkspaceChange(request, "workspace.delete", id);
  return NextResponse.json({ deleted: true });
}
