-- 178_workspaces_projects.sql
--
-- Workspace -> project -> API key hierarchy with rolled-up USD budgets
-- (docs/architecture/WORKSPACES_RBAC.md, section 3.4).
--
-- Additive only: three new tables, one new NULLABLE column on api_keys and indexes.
-- Nothing is dropped, rewritten or backfilled. Every existing key keeps
-- `project_id IS NULL`, which means "no workspace": the hierarchy budget check is skipped
-- for it and the per-key budget (src/domain/costRules.ts) behaves exactly as before.
--
-- FOREIGN KEY clauses document the relationships; OmniRoute does not run with
-- PRAGMA foreign_keys=ON, so referential integrity is enforced in src/lib/db/workspaces.ts.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- NULL = no workspace-level budget.
  budget_limit_usd REAL,
  budget_interval TEXT NOT NULL DEFAULT 'monthly'
    CHECK (budget_interval IN ('daily', 'weekly', 'monthly')),
  warning_threshold REAL NOT NULL DEFAULT 0.8,
  -- Start of the budget period whose threshold alert was already sent (de-duplication).
  warning_period_start INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces (name);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  description TEXT,
  budget_limit_usd REAL,
  budget_interval TEXT NOT NULL DEFAULT 'monthly'
    CHECK (budget_interval IN ('daily', 'weekly', 'monthly')),
  warning_threshold REAL NOT NULL DEFAULT 0.8,
  warning_period_start INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_name ON projects (workspace_id, name);

-- principal: `api_key:<id>` or `access_token:<id>`. The dashboard owner is never a member:
-- it sees every workspace.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  principal TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_principal ON workspace_members (principal);

ALTER TABLE api_keys ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys (project_id);
