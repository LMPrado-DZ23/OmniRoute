/**
 * Handlers for `/api/workspaces/{id}/projects/**`. Every project lookup is scoped by the
 * workspace the caller was authorized for, so a project id of another workspace is a 404
 * with the same body as a nonexistent one.
 */
import { NextResponse } from "next/server";

import {
  createProject,
  deleteProject,
  getKeyPlacements,
  getProject,
  isProjectNameTaken,
  listProjects,
  setProjectApiKeys,
  updateProject,
  type HierarchyBudget,
  type KeyPlacement,
  type Workspace,
} from "@/lib/db/workspaces";
import { childBudgetExceedsParent } from "@/lib/usage/workspaceBudgets";

import {
  authorizeWorkspace,
  canSeeWorkspace,
  resolveWorkspaceCaller,
  type WorkspaceCaller,
} from "./access";
import {
  BUDGET_EXCEEDS_PARENT_MESSAGE,
  auditWorkspaceChange,
  errorJson,
  parseBody,
  projectNotFound,
} from "./http";
import {
  createHierarchyNodeSchema,
  setProjectKeysSchema,
  updateHierarchyNodeSchema,
} from "./schemas";
import { projectWithSpend } from "./workspaceHandlers";

const DEFAULT_PROJECT_BUDGET: HierarchyBudget = {
  limitUsd: null,
  interval: "monthly",
  warningThreshold: 0.8,
};

function exceedsWorkspace(workspace: Workspace, budget: HierarchyBudget): Response | null {
  return childBudgetExceedsParent(budget, workspace.budget)
    ? errorJson(400, BUDGET_EXCEEDS_PARENT_MESSAGE, "budget_exceeds_parent")
    : null;
}

async function authorized(request: Request, workspaceId: string, need: "read" | "write") {
  const { caller, response } = await resolveWorkspaceCaller(request);
  if (response) return { caller: null, workspace: null, response };
  const access = authorizeWorkspace(caller, workspaceId, need);
  return { caller, workspace: access.workspace, response: access.response };
}

/** GET /api/workspaces/{id}/projects */
export async function handleListProjects(request: Request, workspaceId: string): Promise<Response> {
  const auth = await authorized(request, workspaceId, "read");
  if (auth.response) return auth.response;
  return NextResponse.json({ projects: listProjects(workspaceId).map(projectWithSpend) });
}

/** POST /api/workspaces/{id}/projects */
export async function handleCreateProject(
  request: Request,
  workspaceId: string
): Promise<Response> {
  const auth = await authorized(request, workspaceId, "write");
  if (auth.response) return auth.response;
  const body = await parseBody(request, createHierarchyNodeSchema);
  if (body.response) return body.response;
  if (isProjectNameTaken(workspaceId, body.data.name)) {
    return errorJson(409, "A project with this name already exists in the workspace", "name_taken");
  }
  const tooBig = exceedsWorkspace(auth.workspace, {
    ...DEFAULT_PROJECT_BUDGET,
    ...body.data.budget,
  });
  if (tooBig) return tooBig;
  const project = createProject(workspaceId, body.data);
  auditWorkspaceChange(request, "project.create", project.id, { workspaceId });
  return NextResponse.json({ project: projectWithSpend(project) }, { status: 201 });
}

/** GET /api/workspaces/{id}/projects/{projectId} */
export async function handleGetProject(
  request: Request,
  workspaceId: string,
  projectId: string
): Promise<Response> {
  const auth = await authorized(request, workspaceId, "read");
  if (auth.response) return auth.response;
  const project = getProject(workspaceId, projectId);
  if (!project) return projectNotFound();
  return NextResponse.json({ project: projectWithSpend(project) });
}

/** PATCH /api/workspaces/{id}/projects/{projectId} */
export async function handleUpdateProject(
  request: Request,
  workspaceId: string,
  projectId: string
): Promise<Response> {
  const auth = await authorized(request, workspaceId, "write");
  if (auth.response) return auth.response;
  const current = getProject(workspaceId, projectId);
  if (!current) return projectNotFound();
  const body = await parseBody(request, updateHierarchyNodeSchema);
  if (body.response) return body.response;
  if (body.data.name && isProjectNameTaken(workspaceId, body.data.name, projectId)) {
    return errorJson(409, "A project with this name already exists in the workspace", "name_taken");
  }
  const tooBig = exceedsWorkspace(auth.workspace, { ...current.budget, ...body.data.budget });
  if (tooBig) return tooBig;
  const updated = updateProject(workspaceId, projectId, body.data);
  auditWorkspaceChange(request, "project.update", projectId, {
    workspaceId,
    fields: Object.keys(body.data),
  });
  return NextResponse.json({ project: projectWithSpend(updated) });
}

/** DELETE /api/workspaces/{id}/projects/{projectId} — only a project with no keys. */
export async function handleDeleteProject(
  request: Request,
  workspaceId: string,
  projectId: string
): Promise<Response> {
  const auth = await authorized(request, workspaceId, "write");
  if (auth.response) return auth.response;
  const outcome = deleteProject(workspaceId, projectId);
  if (outcome === "not_found") return projectNotFound();
  if (outcome === "not_empty") {
    return errorJson(409, "Unassign the project's API keys first", "project_not_empty");
  }
  auditWorkspaceChange(request, "project.delete", projectId, { workspaceId });
  return NextResponse.json({ deleted: true });
}

const API_KEY_NOT_FOUND = { error: { message: "API key not found" } } as const;

/**
 * A key that does not exist, or that sits in a workspace the caller cannot see, is the same
 * 404. A key in another workspace the caller CAN see is a 409: it must be unassigned there
 * first, so assignment never silently moves spend between workspaces.
 */
function refuseForeignKeys(
  caller: WorkspaceCaller,
  workspaceId: string,
  placements: readonly KeyPlacement[]
): Response | null {
  for (const placement of placements) {
    const foreign = placement.workspaceId !== null && placement.workspaceId !== workspaceId;
    if (!placement.exists || (foreign && !canSeeWorkspace(caller, placement.workspaceId))) {
      return NextResponse.json(API_KEY_NOT_FOUND, { status: 404 });
    }
    if (foreign) {
      return errorJson(
        409,
        "API key is assigned to a project of another workspace",
        "key_in_other_workspace"
      );
    }
  }
  return null;
}

/** PUT /api/workspaces/{id}/projects/{projectId}/keys — replace the project's key set. */
export async function handleSetProjectKeys(
  request: Request,
  workspaceId: string,
  projectId: string
): Promise<Response> {
  const auth = await authorized(request, workspaceId, "write");
  if (auth.response) return auth.response;
  if (!getProject(workspaceId, projectId)) return projectNotFound();
  const body = await parseBody(request, setProjectKeysSchema);
  if (body.response) return body.response;
  const apiKeyIds = [...new Set(body.data.apiKeyIds)];
  const refusal = refuseForeignKeys(auth.caller, workspaceId, getKeyPlacements(apiKeyIds));
  if (refusal) return refusal;
  setProjectApiKeys(projectId, apiKeyIds);
  auditWorkspaceChange(request, "project.keys.set", projectId, {
    workspaceId,
    apiKeyIds,
  });
  return NextResponse.json({ project: projectWithSpend(getProject(workspaceId, projectId)) });
}
