---
title: "Workspaces, Budgets and RBAC (ADR)"
version: 3.8.53
lastUpdated: 2026-09-18
---

# Workspaces, Budgets and RBAC (ADR)

> **Status:** accepted for the incremental path below. Phase 8 ships the role naming layer, admin
> audit coverage, the internal budget alert and credential-exposure hardening; workspaces and
> projects are designed here and **not implemented**.
> **Source of truth:** `src/server/authz/roles.ts`, `src/server/authz/accessScopes.ts`,
> `src/shared/constants/managementScopes.ts`, `src/domain/costRules.ts`,
> `src/lib/compliance/adminAuditActor.ts`, `src/lib/apiKeyExposure.ts`.

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

### 3.4 Workspaces → projects → keys (designed, not implemented)

```
workspace (budget, members→role)
  └── project (budget, allowed providers/models)
        └── api key (existing per-key policy, limits, budget)
```

- **Schema (additive):** `workspaces`, `projects`, `workspace_members(workspace_id, principal,
role)`; nullable `project_id` on `api_keys`. Rows with `project_id IS NULL` belong to an implicit
  default workspace, so every existing key keeps working unchanged.
- **Budget hierarchy:** a request must pass key → project → workspace, most specific first; the
  first `deny` wins; `warn` fires per level. Project/workspace limits use `InternalBudgetLimit`
  with a new `workspace`/`project` scope.
- **Authorization:** routes addressing a workspace resource resolve the resource, then check
  membership. A resource outside the caller's workspaces returns the same `404` body as a
  nonexistent one (already the contract for id-addressed management routes, see
  `tests/unit/authz/resource-existence-matrix.test.ts`).
- **Credential rules carried over:** reveal-once for keys and CLI tokens, masked provider
  credentials, lifecycle columns from migration 032.

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
3. Additive workspace/project tables with an implicit default workspace; backfill nothing.
4. Wire `evaluateBudget` for project/workspace budgets behind a feature flag, with alerts on the
   same webhook event (`source` distinguishes the level).
5. Membership-based authorization for workspace-scoped routes, extending the resource matrix.

## 5. Tests

| File                                                 | Covers                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tests/unit/authz/rbac-role-matrix.test.ts`          | 8 principals × 8 routes (PUBLIC, CLIENT_API, MANAGEMENT read/write/admin) + role resolver         |
| `tests/unit/authz/resource-existence-matrix.test.ts` | 7 principals × 4 id-addressed routes × owned/foreign/nonexistent; no secret in responses or audit |
| `tests/unit/credential-listing-masking.test.ts`      | API keys, CLI tokens, provider connections never listed in full; reveal hardening                 |
| `tests/unit/admin-audit-rbac-phase8.test.ts`         | new audit events, principal/role attribution, `budget.threshold_reached` once per period          |

## 6. Residual risks

- Roles are derived, not assigned: there is still one owner and no per-person identity.
- `ALLOW_API_KEY_REVEAL=true` still returns provider credentials to the dashboard session.
- The audit actor for requests that bypass the pipeline (direct in-process handler calls) is the
  generic `admin`.
- Budget alert delivery is best-effort; a failed webhook is only visible in webhook deliveries.
