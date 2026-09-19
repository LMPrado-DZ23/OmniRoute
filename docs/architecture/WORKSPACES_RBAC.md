---
title: "Workspaces, Budgets and RBAC (ADR)"
version: 3.8.55
lastUpdated: 2026-09-19
---

# Workspaces, Budgets and RBAC (ADR)

> **Status:** accepted. Phase 8 shipped the role naming layer, admin audit coverage, the internal
> budget alert and credential-exposure hardening. **v3.8.55 implements workspaces and projects with
> rolled-up budgets (section 3.4)**, with the deviations from the original design listed in 3.4.6.
> **Source of truth:** `src/server/authz/roles.ts`, `src/server/authz/accessScopes.ts`,
> `src/shared/constants/managementScopes.ts`, `src/domain/costRules.ts`,
> `src/lib/compliance/adminAuditActor.ts`, `src/lib/apiKeyExposure.ts`,
> `src/lib/db/migrations/178_workspaces_projects.sql`, `src/lib/db/workspaces.ts`,
> `src/lib/usage/workspaceBudgets.ts`, `src/lib/workspaces/access.ts`.

## 1. Context — what exists today (verified 2026-09-14)

OmniRoute is a single-operator gateway. There are no user, role, tenant, workspace or project
tables. Isolation is **per API key**:

| Concern                    | Mechanism                                                                          | Where                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Key lifecycle              | `revoked_at`, `expires_at`, `last_used_at`, `key_prefix`, `ip_allowlist`, `scopes` | migration 032, `src/lib/db/apiKeys.ts`                                           |
| Grouping                   | key groups                                                                         | migration 066                                                                    |
| Model / combo / connection | allow-lists per key                                                                | migrations 086, 149; `src/shared/utils/apiKeyPolicy.ts`                          |
| USD limits per key         | daily / weekly usage limits                                                        | migration 101, `src/lib/usage/apiKeyUsageLimits.ts`                              |
| Token limits per key       | per model / provider / global windows                                              | migration 073, `src/lib/db/tokenLimits.ts`                                       |
| Throttle                   | `throttle_delay_ms`                                                                | migration 052                                                                    |
| Budget per key             | daily / weekly / monthly USD, warning threshold (default 0.8)                      | `src/domain/costRules.ts`, `/api/usage/budget`                                   |
| Quota pools                | fair-share allocation across keys, `quota.exceeded` webhook                        | `src/lib/quota/enforce.ts`, `src/lib/quota/QuotaStore.ts`                        |
| Upstream provider quota    | observed provider windows (not controlled by OmniRoute)                            | `src/lib/quota/providerQuotaState.ts`                                            |
| Management credentials     | dashboard JWT, loopback CLI machine token, `manage`/`admin` API keys, CLI tokens   | `src/server/authz/policies/management.ts`, `src/server/authz/accessTokenAuth.ts` |
| CLI access-token scopes    | `read` ⊂ `write` ⊂ `admin`, inferred from method + path                            | `src/lib/accessTokens/scopes.ts`, `src/server/authz/accessScopes.ts`             |
| Narrow API-key scopes      | `mcp:connect`, `self:usage` (migration 075)                                        | `src/shared/constants/managementScopes.ts`                                       |
| Audit                      | `logAuditEvent`, config diffs/rollback, read via `/api/compliance/audit-log`       | `src/lib/compliance/index.ts`, `src/domain/configAudit.ts`                       |

## 2. Gaps found while verifying (evidence)

1. **`budgetGuard` is not wired.** `evaluateBudget` in `src/lib/usage/budgetGuard.ts` (scopes
   global/provider/model/pool; currency/tokens/requests) is imported only by
   `tests/unit/adaptive-circuit-budget-ledger.test.ts`. There is no table, route or usage
   aggregation feeding `InternalBudgetLimit`. The enforced internal budget is `checkBudget` in
   `src/domain/costRules.ts`, called from `src/shared/utils/apiKeyPolicy.ts` and
   `src/domain/policyEngine.ts`.
2. **Budget warnings were log-only.** `emitBudgetWarning` only called `console.warn`.
3. **Admin mutations without an audit row:** `POST /api/usage/budget`, CLI access-token create
   (`/api/cli/tokens`) and revoke, API key deletion and non-scope permission changes in
   `src/app/api/keys/[id]/route.ts`. Scope grants/revokes, ban/activate, create and regenerate
   were already audited by `src/lib/db/apiKeys.ts`.
4. **Provider credentials reachable by any management credential when reveal was on.** With
   `ALLOW_API_KEY_REVEAL=true`, the provider list and detail handlers returned the stored
   `apiKey` to every caller that passed management auth — including a `read` CLI access token,
   because GET requires only `read`. The flag is documented as a dashboard-user opt-in.
5. **Webhook catalogue drift (not fixed here):**
   `src/app/(dashboard)/dashboard/webhooks/components/shared/EventChecklist.tsx` still offers
   `provider.error`, `provider.recovered` and `combo.switched`, which the webhook API rejects.

## 3. Decision

### 3.1 Roles are a naming layer over existing scopes (implemented)

`resolveManagementRole` in `src/server/authz/roles.ts` maps the subject the management policy
already produced to a role. It never grants anything; authorization stays in the policies.

| Role       | Credentials that resolve to it                                                         | Equivalent CLI token scope |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------- |
| `owner`    | dashboard session, loopback CLI machine token, management with login disabled          | `admin` + LOCAL_ONLY       |
| `admin`    | API key with `manage` or `admin`; CLI access token `admin`                             | `admin`                    |
| `operator` | CLI access token `write`                                                               | `write`                    |
| `viewer`   | CLI access token `read`                                                                | `read`                     |
| none       | client API keys, `mcp:connect`-only keys, in-process service principals, no credential | —                          |

API keys remain all-or-nothing for management (a key cannot be an `operator` today). Adding
`write`/`read` management API-key scopes is deferred; it would extend
`MANAGEMENT_API_KEY_SCOPES` and reuse `inferRequiredScope`.

`tests/unit/authz/rbac-role-matrix.test.ts` proves the table equals real policy behaviour.

### 3.2 Admin audit with principal and role (implemented)

`logAdminAuditEvent` in `src/lib/compliance/adminAuditActor.ts` records the pipeline-stamped
principal (`kind:id`) and role, the client IP and request id. New actions: `budget.set`,
`accessToken.create`, `accessToken.revoke`, `apiKey.permissions.update` (field names only),
`apiKey.delete`, `provider.credentials.revealed` (connection ids only). Only successful mutations
are recorded. No event carries key material, token secrets, hashes or display prefixes.

### 3.3 External provider quota vs internal budget (partially implemented)

| Dimension        | External provider quota                  | Internal budget / limit                                                                      |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Owner            | the upstream provider account            | the OmniRoute operator                                                                       |
| OmniRoute's role | observe windows, route around exhaustion | define and enforce                                                                           |
| Code             | `src/lib/quota/providerQuotaState.ts`    | `src/domain/costRules.ts`, `src/lib/usage/apiKeyUsageLimits.ts`, `src/lib/db/tokenLimits.ts` |
| Pool allocation  | —                                        | `src/lib/quota/enforce.ts` (emits `quota.exceeded`)                                          |
| Alert            | —                                        | `budget.threshold_reached` (new)                                                             |

`budget.threshold_reached` is emitted by `src/lib/usage/budgetAlerts.ts` once per budget period,
when `checkBudget` first sees projected spend at or above the warning threshold (the existing
`warningPeriodStart` de-duplication). Payload: `source: "internal_budget"`, key id, interval,
projected spend, limit, percent, threshold, next reset. `quota.exceeded` keeps its meaning.

`budgetGuard` stays unwired: wiring it needs a persisted limit model, a management route, and
token/request counters per provider/model/pool. It is the intended evaluator for workspace and
project budgets (3.4), not a replacement for per-key `checkBudget`, whose semantics differ
(`checkBudget` denies when projected spend is strictly above the limit; `evaluateBudget` denies at
equality).

### 3.4 Workspaces → projects → keys (implemented in v3.8.55)

```
workspace (budget, members → admin | viewer)
  └── project (budget)
        └── api key (existing per-key policy, limits, budget)
```

#### 3.4.1 Schema (migration 178, additive only)

| Object                           | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `workspaces`                     | name (unique), description, `budget_limit_usd` (NULL = none), `budget_interval`, `warning_threshold` |
| `projects`                       | `workspace_id`, name (unique per workspace), description, the same budget columns                    |
| `workspace_members`              | `(workspace_id, principal)` → `role` (`admin` or `viewer`)                                           |
| `api_keys.project_id` (nullable) | the project a key rolls up into; `NULL` for every key that existed before 178                        |
| `warning_period_start` (both)    | start of the budget period whose threshold alert was already sent (de-duplication)                   |

Nothing is dropped, rewritten or backfilled. `tests/unit/workspace-migration-backcompat.test.ts`
applies 178 to a fresh database and to a database at the 177 schema holding keys, budgets and spend,
and checks that the existing rows are unchanged and that a rerun applies nothing.

#### 3.4.2 Roll-up rule

For a level with a budget, spend is read from the **same ledger** the per-key budget uses
(`domain_cost_history` plus the not-yet-flushed spend batch), over that level's own window
(`getBudgetWindow(interval, "00:00")`, UTC):

- `spend(project) = Σ spend(key)` over the keys whose `project_id` is the project;
- `spend(workspace) = Σ spend(key)` over the keys of **all** its projects;
- a key with no project counts nowhere. Spend is attributed by the key's **current** assignment:
  moving a key moves its spend inside the current window with it.

#### 3.4.3 Enforcement: what happens when a child would exceed its parent

A request passes key → project → workspace, most specific first; the first `deny` wins
(`validateBudget` in `src/shared/utils/apiKeyPolicy.ts` and `evaluateRequest` in
`src/domain/policyEngine.ts`). Project and workspace limits are `InternalBudgetLimit`s with the new
`project` / `workspace` scopes, evaluated by `evaluateBudget`, so a level denies when its rolled-up
spend is **at or above** its limit (the per-key `checkBudget` keeps its own rule: strictly above).

- **At runtime a child can never spend past its parent.** A key whose own budget and project budget
  still have room is refused with HTTP 429 (`Workspace internal budget exhausted …`) once its
  workspace is exhausted, including when a sibling project spent it.
- **Configuration:** a project limit may not be larger than its workspace limit **on the same
  interval** (400 `budget_exceeds_parent`, both when the project is written and when the workspace
  is lowered below an existing project). Different intervals are not comparable and are accepted;
  the runtime rule above still caps them. The sum of the projects' limits may exceed the workspace
  limit (over-subscription is allowed; the workspace is the shared cap).
- A level without a limit (`limitUsd: null`) never denies and costs no ledger read.

`budget.threshold_reached` is reused with `source: "project_budget"` or `"workspace_budget"`
(`notifyHierarchyBudgetThresholdReached` in `src/lib/usage/budgetAlerts.ts`), once per level and
budget period, for every level at or above its warning threshold. Changing a level's budget re-arms it.

#### 3.4.4 Authorization

Routes: `/api/workspaces`, `/api/workspaces/{id}`, `…/projects`, `…/projects/{projectId}`,
`…/projects/{projectId}/keys` (PUT replaces the key set), `…/members`, `…/members/{principal}`.

1. `requireManagementAuth` decides whether the credential may use the management API. Mutations under
   `/api/workspaces` are in `ADMIN_MUTATION_PREFIXES`, so a CLI access token needs `admin` to write
   (GET stays `read`).
2. `resolveWorkspaceCaller` names the caller from the same credential: the dashboard session,
   auth-disabled mode, the loopback CLI machine token and trusted in-process service calls are the
   **owner** and see every workspace; a management API key is `api_key:<id>`, a CLI access token is
   `access_token:<id>`. Identity is taken from the credential itself, not from the authz stamp
   headers (only the loopback stamp is honoured, exactly as `requireManagementAuth` already does).
3. `authorizeWorkspace` resolves the workspace, then membership. A workspace the caller is not a
   member of returns the **same 404 body** as a nonexistent one. Project lookups are always scoped
   by the authorized workspace, so a project id of another workspace is also a plain 404. A `viewer`
   member reads; writes need `admin` (403). A non-owner that creates a workspace becomes its `admin`.
4. Assigning a key that sits in another workspace: 404 (same body as an unknown key) when the caller
   cannot see that workspace, 409 `key_in_other_workspace` when it can. A key is never moved
   between workspaces implicitly.

Every successful mutation is recorded with `logAdminAuditEvent` (`workspace.create|update|delete`,
`project.create|update|delete`, `project.keys.set`, `workspace.member.upsert|remove`).

#### 3.4.5 Backwards compatibility

A key with `project_id IS NULL` returns from `checkHierarchyBudget` after one indexed lookup, with no
budget read and no alert. An installation that never creates a workspace therefore enforces exactly
the pre-178 per-key budget; `tests/unit/workspace-migration-backcompat.test.ts` runs the existing
`checkBudget` / policy-engine contract (allowed below, warning at the threshold, allowed at the limit,
denied strictly above) against the migrated schema.

#### 3.4.6 Deviations from the original design (and why)

| Original design                                                   | Implemented                                                                               | Why                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id IS NULL` keys belong to an implicit default workspace | Unassigned keys belong to **no** workspace and are outside the hierarchy                  | A default workspace needs either a backfill (not additive) or a virtual row whose budget would apply to every existing key, which would change behaviour on upgrade. |
| Project carries allowed providers/models                          | Not implemented                                                                           | Per-key allow-lists already exist (migrations 086/149); a project list needs a merge rule with them. Left for a separate change.                                     |
| Wire `evaluateBudget` behind a feature flag                       | No flag                                                                                   | The opt-in is assigning a key to a project; an unassigned key does no extra budget work, so a flag would guard nothing.                                              |
| Member roles reuse `owner/admin/operator/viewer`                  | Membership roles are `admin` and `viewer`; `owner` is a credential role, not a membership | The owner already sees everything; an `operator` membership needs a per-route read/write split that does not exist yet. The credential scope still applies on top.   |
| Limits in currency, tokens or requests                            | Currency (USD) only                                                                       | The only per-key ledger is USD (`domain_cost_history`); token/request counters per level do not exist.                                                               |

### 3.5 Credential exposure (implemented)

`isProviderCredentialRevealAllowed` in `src/lib/apiKeyExposure.ts` returns true only when
`ALLOW_API_KEY_REVEAL` is on **and** the authz pipeline stamped a dashboard subject
(`x-omniroute-auth-kind: dashboard_session`, or `anonymous` with label `auth-disabled` when login
is disabled). It is an allow-list on the trusted stamp, which the pipeline strips from client input
before it stamps: every API key or token is stamped `management_key` or `client_api_key` whatever
header carried it (`Authorization`, `x-api-key`, `x-goog-api-key`), and a handler reached without
the pipeline has no stamp and stays masked. As defense in depth, a request that also carries a
programmatic credential (Bearer API key or CLI token, `x-api-key`, `x-goog-api-key`, loopback CLI
machine token) stays masked. The flag stays default-off. With it
off, no stored provider credential is returned in full after creation. Leaving the flag in place
for the dashboard is a deliberate compatibility decision (documented operator opt-in, danger
level); every reveal is audited.

## 4. Migration path

1. (done) Role naming, admin audit, budget alert, exposure hardening — no schema change.
2. Management API-key scopes `write`/`read` reusing `inferRequiredScope`.
3. (done, v3.8.55) Additive workspace/project tables (migration 178); backfill nothing. No implicit
   default workspace (see 3.4.6).
4. (done, v3.8.55) `evaluateBudget` enforces project/workspace budgets, alerts on the same webhook
   event (`source` distinguishes the level). No feature flag (see 3.4.6).
5. (done, v3.8.55) Membership-based authorization for workspace-scoped routes, with IDOR tests.

## 5. Tests

| File                                                 | Covers                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tests/unit/authz/rbac-role-matrix.test.ts`          | 8 principals × 8 routes (PUBLIC, CLIENT_API, MANAGEMENT read/write/admin) + role resolver           |
| `tests/unit/authz/resource-existence-matrix.test.ts` | 7 principals × 4 id-addressed routes × owned/foreign/nonexistent; no secret in responses or audit   |
| `tests/unit/credential-listing-masking.test.ts`      | API keys, CLI tokens, provider connections never listed in full; reveal hardening                   |
| `tests/unit/admin-audit-rbac-phase8.test.ts`         | new audit events, principal/role attribution, `budget.threshold_reached` once per period            |
| `tests/unit/workspace-budget-rollup.test.ts`         | roll-up sums, deny at the limit, key → project → workspace order, parent cap, alert once per period |
| `tests/unit/workspace-migration-backcompat.test.ts`  | migration 178 on a fresh DB and on a 177 DB; unchanged per-key budget with no workspace             |
| `tests/unit/authz/workspaces-routes.test.ts`         | CRUD, membership roles, IDOR (foreign workspace/project/key = nonexistent), audit, no secrets       |

## 6. Residual risks

- Roles are derived, not assigned: there is still one owner and no per-person identity.
- `ALLOW_API_KEY_REVEAL=true` still returns provider credentials to the dashboard session.
- The audit actor for requests that bypass the pipeline (direct in-process handler calls) is the
  generic `admin`.
- Budget alert delivery is best-effort; a failed webhook is only visible in webhook deliveries.
- Workspace spend is summed per request over the workspace's keys (one indexed ledger sum per key);
  a workspace with many keys costs proportionally more per request.
- A member row can outlive the API key or access token it names; it grants nothing once that
  credential no longer authenticates.
- `/api/keys` is still a global management listing: it now carries each key's `projectId`, visible
  to any management credential, even for projects in workspaces the caller is not a member of.
  Key names and ids were already visible there; workspace-scoping `/api/keys` is future work.
