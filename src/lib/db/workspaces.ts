/**
 * Workspace -> project -> API key store (migration 178).
 *
 * Pure data access: no authorization decisions live here. Routes resolve the caller first
 * (`src/lib/workspaces/access.ts`) and only then call these functions, always with the
 * workspace id the caller was authorized for. Every project read and write is scoped by
 * `workspace_id` so a project id from another workspace behaves as nonexistent.
 *
 * OmniRoute does not run with `PRAGMA foreign_keys=ON`; the referential rules (no workspace
 * delete while it has projects, no project delete while keys are assigned) are enforced here.
 */
import { randomUUID } from "node:crypto";

import { getDbInstance } from "./core";

export type BudgetInterval = "daily" | "weekly" | "monthly";
export type WorkspaceMemberRole = "admin" | "viewer";

export interface HierarchyBudget {
  /** `null` = no budget at this level. */
  limitUsd: number | null;
  interval: BudgetInterval;
  warningThreshold: number;
}

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  budget: HierarchyBudget;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  budget: HierarchyBudget;
  apiKeyIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  principal: string;
  role: WorkspaceMemberRole;
  createdAt: string;
}

export interface WorkspaceInput {
  name: string;
  description?: string | null;
  budget?: Partial<HierarchyBudget>;
}

interface BudgetColumns {
  budget_limit_usd: number | null;
  budget_interval: BudgetInterval;
  warning_threshold: number;
}

interface WorkspaceRow extends BudgetColumns {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ProjectRow extends BudgetColumns {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_BUDGET: HierarchyBudget = {
  limitUsd: null,
  interval: "monthly",
  warningThreshold: 0.8,
};

function toBudget(row: BudgetColumns): HierarchyBudget {
  return {
    limitUsd: row.budget_limit_usd === null ? null : Number(row.budget_limit_usd),
    interval: row.budget_interval,
    warningThreshold: Number(row.warning_threshold),
  };
}

function mergeBudget(current: HierarchyBudget, patch?: Partial<HierarchyBudget>): HierarchyBudget {
  if (!patch) return current;
  return {
    limitUsd: patch.limitUsd === undefined ? current.limitUsd : patch.limitUsd,
    interval: patch.interval ?? current.interval,
    warningThreshold: patch.warningThreshold ?? current.warningThreshold,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    budget: toBudget(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WORKSPACE_COLUMNS =
  "id, name, description, budget_limit_usd, budget_interval, warning_threshold, created_by, created_at, updated_at";
const PROJECT_COLUMNS =
  "id, workspace_id, name, description, budget_limit_usd, budget_interval, warning_threshold, created_at, updated_at";

/** Every workspace (owner view), or only those `principal` is a member of. */
export function listWorkspaces(principal: string | null): Workspace[] {
  const db = getDbInstance();
  const rows = (
    principal === null
      ? db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY name`).all()
      : db
          .prepare(
            `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
             WHERE id IN (SELECT workspace_id FROM workspace_members WHERE principal = ?)
             ORDER BY name`
          )
          .all(principal)
  ) as WorkspaceRow[];
  return rows.map(toWorkspace);
}

export function getWorkspace(id: string): Workspace | null {
  const row = getDbInstance()
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`)
    .get(id) as WorkspaceRow | undefined;
  return row ? toWorkspace(row) : null;
}

export function isWorkspaceNameTaken(name: string, exceptId?: string): boolean {
  const row = getDbInstance()
    .prepare("SELECT id FROM workspaces WHERE name = ? AND id != ?")
    .get(name, exceptId ?? "") as { id: string } | undefined;
  return Boolean(row);
}

/**
 * Create a workspace. `creatorMember` (the caller's principal when it is not the owner)
 * becomes the workspace `admin`, so a non-owner can always see what it created.
 */
export function createWorkspace(
  input: WorkspaceInput,
  createdBy: string,
  creatorMember: string | null
): Workspace {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const id = randomUUID();
  const budget = mergeBudget(DEFAULT_BUDGET, input.budget);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, name, description, budget_limit_usd, budget_interval,
         warning_threshold, warning_period_start, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).run(
      id,
      input.name,
      input.description ?? null,
      budget.limitUsd,
      budget.interval,
      budget.warningThreshold,
      createdBy,
      now,
      now
    );
    if (creatorMember) {
      db.prepare(
        "INSERT INTO workspace_members (workspace_id, principal, role, created_at) VALUES (?, ?, 'admin', ?)"
      ).run(id, creatorMember, now);
    }
  })();
  return getWorkspace(id) as Workspace;
}

/** Apply a partial update. Changing the budget re-arms the threshold alert. */
export function updateWorkspace(id: string, patch: Partial<WorkspaceInput>): Workspace | null {
  const current = getWorkspace(id);
  if (!current) return null;
  const budget = mergeBudget(current.budget, patch.budget);
  getDbInstance()
    .prepare(
      `UPDATE workspaces SET name = ?, description = ?, budget_limit_usd = ?, budget_interval = ?,
         warning_threshold = ?, warning_period_start = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.name ?? current.name,
      patch.description === undefined ? current.description : patch.description,
      budget.limitUsd,
      budget.interval,
      budget.warningThreshold,
      patch.budget ? null : readWarningPeriod("workspaces", id),
      new Date().toISOString(),
      id
    );
  return getWorkspace(id);
}

export type DeleteOutcome = "deleted" | "not_found" | "not_empty";

/** Delete an empty workspace (and its member rows). A workspace with projects is kept. */
export function deleteWorkspace(id: string): DeleteOutcome {
  const db = getDbInstance();
  if (!getWorkspace(id)) return "not_found";
  const projects = db
    .prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?")
    .get(id) as { n: number };
  if (Number(projects.n) > 0) return "not_empty";
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  })();
  return "deleted";
}

// ── Projects ──────────────────────────────────────────────────────────────────

function projectKeyIds(projectId: string): string[] {
  const rows = getDbInstance()
    .prepare("SELECT id FROM api_keys WHERE project_id = ? ORDER BY id")
    .all(projectId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    budget: toBudget(row),
    apiKeyIds: projectKeyIds(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(workspaceId: string): Project[] {
  const rows = getDbInstance()
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = ? ORDER BY name`)
    .all(workspaceId) as ProjectRow[];
  return rows.map(toProject);
}

/** A project of THIS workspace, or `null` (also when the id belongs to another workspace). */
export function getProject(workspaceId: string, projectId: string): Project | null {
  const row = getDbInstance()
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND workspace_id = ?`)
    .get(projectId, workspaceId) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function isProjectNameTaken(workspaceId: string, name: string, exceptId?: string): boolean {
  const row = getDbInstance()
    .prepare("SELECT id FROM projects WHERE workspace_id = ? AND name = ? AND id != ?")
    .get(workspaceId, name, exceptId ?? "") as { id: string } | undefined;
  return Boolean(row);
}

export function createProject(workspaceId: string, input: WorkspaceInput): Project {
  const now = new Date().toISOString();
  const id = randomUUID();
  const budget = mergeBudget(DEFAULT_BUDGET, input.budget);
  getDbInstance()
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, description, budget_limit_usd, budget_interval,
         warning_threshold, warning_period_start, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(
      id,
      workspaceId,
      input.name,
      input.description ?? null,
      budget.limitUsd,
      budget.interval,
      budget.warningThreshold,
      now,
      now
    );
  return getProject(workspaceId, id) as Project;
}

export function updateProject(
  workspaceId: string,
  projectId: string,
  patch: Partial<WorkspaceInput>
): Project | null {
  const current = getProject(workspaceId, projectId);
  if (!current) return null;
  const budget = mergeBudget(current.budget, patch.budget);
  getDbInstance()
    .prepare(
      `UPDATE projects SET name = ?, description = ?, budget_limit_usd = ?, budget_interval = ?,
         warning_threshold = ?, warning_period_start = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    )
    .run(
      patch.name ?? current.name,
      patch.description === undefined ? current.description : patch.description,
      budget.limitUsd,
      budget.interval,
      budget.warningThreshold,
      patch.budget ? null : readWarningPeriod("projects", projectId),
      new Date().toISOString(),
      projectId,
      workspaceId
    );
  return getProject(workspaceId, projectId);
}

/** Delete a project with no assigned keys. */
export function deleteProject(workspaceId: string, projectId: string): DeleteOutcome {
  const project = getProject(workspaceId, projectId);
  if (!project) return "not_found";
  if (project.apiKeyIds.length > 0) return "not_empty";
  getDbInstance()
    .prepare("DELETE FROM projects WHERE id = ? AND workspace_id = ?")
    .run(projectId, workspaceId);
  return "deleted";
}

// ── API key assignment ────────────────────────────────────────────────────────

export interface KeyPlacement {
  apiKeyId: string;
  exists: boolean;
  /** Workspace of the project the key is assigned to, `null` when unassigned. */
  workspaceId: string | null;
  projectId: string | null;
}

/** Where each key currently sits. Unknown ids come back with `exists: false`. */
export function getKeyPlacements(apiKeyIds: readonly string[]): KeyPlacement[] {
  const stmt = getDbInstance().prepare(
    `SELECT k.id AS id, k.project_id AS project_id, p.workspace_id AS workspace_id
     FROM api_keys k LEFT JOIN projects p ON p.id = k.project_id
     WHERE k.id = ?`
  );
  return apiKeyIds.map((apiKeyId) => {
    const row = stmt.get(apiKeyId) as
      { id: string; project_id: string | null; workspace_id: string | null } | undefined;
    return {
      apiKeyId,
      exists: Boolean(row),
      projectId: row?.project_id ?? null,
      workspaceId: row?.workspace_id ?? null,
    };
  });
}

/**
 * Make `apiKeyIds` the exact key set of the project: listed keys are assigned, keys that
 * were in the project and are not listed are unassigned (`project_id = NULL`). The caller
 * has already verified that no listed key belongs to another workspace.
 */
export function setProjectApiKeys(projectId: string, apiKeyIds: readonly string[]): void {
  const db = getDbInstance();
  const keep = new Set(apiKeyIds);
  db.transaction(() => {
    for (const current of projectKeyIds(projectId)) {
      if (!keep.has(current)) {
        db.prepare("UPDATE api_keys SET project_id = NULL WHERE id = ?").run(current);
      }
    }
    for (const id of keep) {
      db.prepare("UPDATE api_keys SET project_id = ? WHERE id = ?").run(projectId, id);
    }
  })();
}

// ── Members ───────────────────────────────────────────────────────────────────

export function getMemberRole(workspaceId: string, principal: string): WorkspaceMemberRole | null {
  const row = getDbInstance()
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND principal = ?")
    .get(workspaceId, principal) as { role: WorkspaceMemberRole } | undefined;
  return row?.role ?? null;
}

export function listMembers(workspaceId: string): WorkspaceMember[] {
  const rows = getDbInstance()
    .prepare(
      "SELECT principal, role, created_at FROM workspace_members WHERE workspace_id = ? ORDER BY principal"
    )
    .all(workspaceId) as Array<{
    principal: string;
    role: WorkspaceMemberRole;
    created_at: string;
  }>;
  return rows.map((row) => ({
    principal: row.principal,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export function upsertMember(
  workspaceId: string,
  principal: string,
  role: WorkspaceMemberRole
): void {
  getDbInstance()
    .prepare(
      `INSERT INTO workspace_members (workspace_id, principal, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, principal) DO UPDATE SET role = excluded.role`
    )
    .run(workspaceId, principal, role, new Date().toISOString());
}

export function removeMember(workspaceId: string, principal: string): boolean {
  const result = getDbInstance()
    .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND principal = ?")
    .run(workspaceId, principal);
  return result.changes > 0;
}

// ── Budget roll-up support ────────────────────────────────────────────────────

export interface KeyHierarchy {
  project: { id: string; budget: HierarchyBudget };
  workspace: { id: string; budget: HierarchyBudget };
}

/**
 * The project and workspace an API key rolls up into, or `null` for a key with no project
 * (every key that existed before migration 178). One indexed lookup.
 */
export function getKeyHierarchy(apiKeyId: string): KeyHierarchy | null {
  const row = getDbInstance()
    .prepare(
      `SELECT p.id AS project_id, p.budget_limit_usd AS p_limit, p.budget_interval AS p_interval,
              p.warning_threshold AS p_threshold,
              w.id AS workspace_id, w.budget_limit_usd AS w_limit, w.budget_interval AS w_interval,
              w.warning_threshold AS w_threshold
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE k.id = ?`
    )
    .get(apiKeyId) as
    | {
        project_id: string;
        p_limit: number | null;
        p_interval: BudgetInterval;
        p_threshold: number;
        workspace_id: string;
        w_limit: number | null;
        w_interval: BudgetInterval;
        w_threshold: number;
      }
    | undefined;
  if (!row) return null;
  return {
    project: {
      id: row.project_id,
      budget: toBudget({
        budget_limit_usd: row.p_limit,
        budget_interval: row.p_interval,
        warning_threshold: row.p_threshold,
      }),
    },
    workspace: {
      id: row.workspace_id,
      budget: toBudget({
        budget_limit_usd: row.w_limit,
        budget_interval: row.w_interval,
        warning_threshold: row.w_threshold,
      }),
    },
  };
}

/** Every key id that rolls up into the workspace (through any of its projects). */
export function listWorkspaceApiKeyIds(workspaceId: string): string[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT k.id AS id FROM api_keys k JOIN projects p ON p.id = k.project_id
       WHERE p.workspace_id = ? ORDER BY k.id`
    )
    .all(workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function listProjectApiKeyIds(projectId: string): string[] {
  return projectKeyIds(projectId);
}

type BudgetTable = "workspaces" | "projects";

export function readWarningPeriod(table: BudgetTable, id: string): number | null {
  const row = getDbInstance()
    .prepare(`SELECT warning_period_start FROM ${table} WHERE id = ?`)
    .get(id) as { warning_period_start: number | null } | undefined;
  return row?.warning_period_start ?? null;
}

/**
 * Claim the threshold alert for one budget period. Returns `true` exactly once per
 * (level, id, period): the conditional UPDATE is the de-duplication.
 */
export function claimWarningPeriod(table: BudgetTable, id: string, periodStart: number): boolean {
  const result = getDbInstance()
    .prepare(
      `UPDATE ${table} SET warning_period_start = ?
       WHERE id = ? AND (warning_period_start IS NULL OR warning_period_start != ?)`
    )
    .run(periodStart, id, periodStart);
  return result.changes > 0;
}
