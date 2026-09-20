/** Client-side types and calls for the `/api/workspaces/**` management API. */

export type BudgetInterval = "daily" | "weekly" | "monthly";

export interface Budget {
  limitUsd: number | null;
  interval: BudgetInterval;
  warningThreshold: number;
}

export interface LevelSpend {
  decision: "allow" | "warn" | "deny";
  spendUsd: number;
  limitUsd: number | null;
}

export interface WorkspaceView {
  id: string;
  name: string;
  budget: Budget;
  spend: LevelSpend;
}

export interface ProjectView {
  id: string;
  name: string;
  budget: Budget;
  apiKeyIds: string[];
  spend: LevelSpend;
}

export interface WorkspaceDetail {
  workspace: WorkspaceView;
  projects: ProjectView[];
}

export interface ApiKeyOption {
  id: string;
  name: string;
  projectId: string | null;
}

interface ErrorPayload {
  error?: string | { message?: string; code?: string };
}

function errorMessage(payload: ErrorPayload, status: number): string {
  const error = payload?.error;
  if (typeof error === "string") return error;
  return error?.message || `HTTP ${status}`;
}

function errorCode(payload: ErrorPayload): string | undefined {
  const error = payload?.error;
  return typeof error === "string" ? undefined : error?.code;
}

/**
 * A refusal from `/api/workspaces/**`, carrying the machine-readable `code` alongside the
 * server's English `message`.
 *
 * The page used to show `message` verbatim, which meant every workspaces error was English
 * no matter the chosen language — including for the locales that have a real translation.
 * The `code` is the part a UI can translate; `message` stays as the fallback for a code the
 * dashboard does not know yet, so a new server error is never rendered as a blank toast.
 */
export class WorkspaceApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.name = "WorkspaceApiError";
    this.code = code;
    this.status = status;
  }
}

async function send<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: T & ErrorPayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkspaceApiError(
      errorMessage(payload, response.status),
      errorCode(payload),
      response.status
    );
  }
  return payload;
}

const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;
const projectBase = (workspaceId: string, projectId: string) =>
  `${base(workspaceId)}/projects/${encodeURIComponent(projectId)}`;

export async function listWorkspaces(): Promise<WorkspaceView[]> {
  return (await send<{ workspaces: WorkspaceView[] }>("/api/workspaces")).workspaces ?? [];
}

export function getWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
  return send<WorkspaceDetail>(base(workspaceId));
}

export function createWorkspace(name: string, budget: Budget): Promise<unknown> {
  return send("/api/workspaces", "POST", { name, budget });
}

export function updateWorkspaceBudget(workspaceId: string, budget: Budget): Promise<unknown> {
  return send(base(workspaceId), "PATCH", { budget });
}

export function deleteWorkspace(workspaceId: string): Promise<unknown> {
  return send(base(workspaceId), "DELETE");
}

export function createProject(workspaceId: string, name: string, budget: Budget): Promise<unknown> {
  return send(`${base(workspaceId)}/projects`, "POST", { name, budget });
}

export function updateProjectBudget(
  workspaceId: string,
  projectId: string,
  budget: Budget
): Promise<unknown> {
  return send(projectBase(workspaceId, projectId), "PATCH", { budget });
}

export function deleteProject(workspaceId: string, projectId: string): Promise<unknown> {
  return send(projectBase(workspaceId, projectId), "DELETE");
}

export function setProjectKeys(
  workspaceId: string,
  projectId: string,
  apiKeyIds: string[]
): Promise<unknown> {
  return send(`${projectBase(workspaceId, projectId)}/keys`, "PUT", { apiKeyIds });
}

interface RawKey {
  id?: unknown;
  name?: unknown;
  projectId?: unknown;
}

export async function listApiKeys(): Promise<ApiKeyOption[]> {
  const payload = await send<{ keys?: RawKey[] }>("/api/keys");
  return (payload.keys ?? [])
    .filter((key) => typeof key.id === "string")
    .map((key) => ({
      id: String(key.id),
      name: typeof key.name === "string" && key.name ? key.name : String(key.id),
      projectId: typeof key.projectId === "string" ? key.projectId : null,
    }));
}
