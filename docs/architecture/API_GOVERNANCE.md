---
title: "API Governance"
version: 3.8.53
lastUpdated: 2026-09-14
---

# API Governance

> **Source of truth:** `docs/openapi.yaml` (per-operation metadata), `scripts/check/check-api-governance.mjs` + `scripts/check/lib/apiGovernance.mjs` (the gate), `config/quality/api-governance-baseline.json` (frozen debt), `src/lib/api/deprecationHeaders.ts` (deprecation headers).
> **Last updated:** 2026-09-14 — v3.8.53

Every HTTP operation OmniRoute serves is classified, owned, documented and tested. This page defines the stability classes, the metadata each operation must carry, the deprecation policy, and the checklist for adding a route. `npm run check:api-governance` enforces it in the `lint` job of `ci.yml` and in the Fast Quality Gates loop of `quality.yml`.

## Stability classes

Every documented operation carries exactly one `x-stability` value.

| Class (`x-stability`) | Meaning                                                                                               | Compatibility promise                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `stable`              | Public client API that third-party harnesses depend on, pinned by a contract test.                    | No breaking change without the deprecation policy below. Breaking changes are also blocked by `check:openapi-breaking --ratchet`. |
| `experimental`        | Reachable by clients (API key or unauthenticated public route) but not yet pinned by a contract test. | Best effort. May change between releases; changes still go through the oasdiff ratchet and the CHANGELOG.                         |
| `internal`            | Dashboard / management / loopback / operator surface.                                                 | None for external callers. Documented so the route inventory stays complete and the "Try It" allowlist stays explicit.            |
| `deprecated`          | Scheduled for removal. Must also set `deprecated: true` and `x-sunset`.                               | Keeps answering until the sunset date and emits `Deprecation`, `Sunset` and `Link` headers.                                       |

### How the initial classification was derived

The v3.8.53 baseline was classified mechanically from the authorization sources, then the `stable` set was curated by hand:

1. **deprecated** — operations whose handler already rejects the call as deprecated: `PUT` and `POST /api/context/combos/default` (410 since v3.8.32).
2. **stable** — `/api/v1` client operations that have both a contract test that names the path and a documented example: `GET /api/v1`, `GET /api/v1/models`, `POST /api/v1/messages/count_tokens` (contract: `tests/integration/v1-contracts-behavior.test.ts`), `POST /api/v1/chat/completions`, `POST /api/v1/messages`, `POST /api/v1/responses` (contract: `tests/e2e/compat-isolated.test.ts`).
3. **internal** — anything annotated `x-loopback-only`, `x-always-protected` or `x-internal`; anything matched by `isLocalOnlyPath()` / `isAlwaysProtectedPath()` in `src/server/authz/routeGuard.ts`; operations secured by `ManagementSessionAuth`; `/api/v1/management/*`; the catch-all 404 responders; and every other `/api/*` route that `classifyRoute()` (`src/server/authz/classify.ts`) puts in the `MANAGEMENT` class.
4. **experimental** — the rest of the `CLIENT_API` class (`/api/v1`, `/api/v1beta`) and routes that `isPublicApiRoute()` (`src/shared/constants/publicApiRoutes.ts`) classifies as public.

Result at introduction: 709 routes, 1039 operations — 6 stable, 148 experimental, 883 internal, 2 deprecated. `npm run check:api-governance` prints the live counts.

## Required metadata per operation

| Requirement   | Where it lives                                                                                                                                                                                                                                                               | Enforced by                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Owner         | `x-owner` — a handle declared in `.github/CODEOWNERS`.                                                                                                                                                                                                                       | Gate: handle must appear in CODEOWNERS.                                    |
| Tag           | `tags` (first tag groups the operation in the API Explorer and the generated CLI).                                                                                                                                                                                           | Existing spec convention.                                                  |
| Version       | API family from the path (`/api/v1`, `/api/v1beta`, or the unversioned management API) plus `x-since`, the release that introduced the operation. Operations that pre-date governance carry `3.8.53`, meaning "present in or before v3.8.53".                                | Gate: plain semver, not newer than `package.json`.                         |
| Auth          | `security` (`BearerAuth` for API keys, `ManagementSessionAuth` for dashboard sessions) plus the route-guard tier: `x-loopback-only` (LOCAL_ONLY) and `x-always-protected` (ALWAYS_PROTECTED). See [Authorization Guide](./AUTHZ_GUIDE.md).                                   | `check:openapi-security-tiers`; gate: privileged tiers must be `internal`. |
| Scopes        | Management routes accept a session or an API key holding `manage` or `admin` (`MANAGEMENT_API_KEY_SCOPES` in `src/shared/constants/managementScopes.ts`); `/api/mcp/` also accepts `mcp:connect`. Client API keys are limited by per-key model/combo allowlists, not scopes. | Authorization pipeline (`src/server/authz/`).                              |
| Rate limit    | `x-rate-limit`: `api-key-policy` or `none` (see below).                                                                                                                                                                                                                      | Gate: must match what the route source actually calls.                     |
| Example       | `example` / `examples` in the request body or response.                                                                                                                                                                                                                      | Gate: required for `stable`.                                               |
| Stability     | `x-stability`.                                                                                                                                                                                                                                                               | Gate.                                                                      |
| Deprecation   | `deprecated: true` + `x-sunset: "YYYY-MM-DD"`.                                                                                                                                                                                                                               | Gate: both or neither, only with `x-stability: deprecated`.                |
| Contract test | `x-contract-test` — repo path of a test that exercises the operation.                                                                                                                                                                                                        | Gate: required for `stable`; the file must exist and name the path.        |

### Rate-limit mechanisms

- **`api-key-policy`** — the route calls `enforceApiKeyPolicy()` (`src/shared/utils/apiKeyPolicy.ts`) directly or through the shared chat handler `handleChat()` (`src/sse/handlers/chat.ts`). The policy runs `checkRateLimit()` (`src/shared/utils/rateLimiter.ts`) with the key's own rate-limit rules. There is **no implicit cap**: keys without rules are unlimited unless `DEFAULT_RATE_LIMIT_PER_DAY` is set, which applies a daily limit plus 5× weekly and 20× monthly windows. Windows are tracked in Redis when `REDIS_URL` is set and in process memory otherwise; a Redis evaluation error fails open. A rejected call returns HTTP 429. Chat routes additionally pass through process-wide body admission (`src/shared/middleware/chatBodyAdmission.ts`), which sheds load under memory pressure and is not a per-client rate limit.
- **`none`** — the route runs no request-rate limiter of its own. Upstream provider 429s and quota handling still apply where the route proxies a provider.

The gate derives the mechanism from each `route.ts` and fails when the declared value disagrees, so the spec cannot claim a limiter the code does not run.

## Deprecation policy

1. **Announce.** Set `x-stability: deprecated`, `deprecated: true` and `x-sunset` on the operation, add a CHANGELOG entry, and emit the headers from the handler with `buildDeprecationHeaders()` (`src/lib/api/deprecationHeaders.ts`):
   - `Deprecation: @<unix-seconds>` — RFC 9745 structured-field date of the deprecation;
   - `Sunset: <IMF-fixdate>` — RFC 8594 date after which the operation may stop responding;
   - `Link: <policy-url>; rel="deprecation", <policy-url>; rel="sunset"`.
     The `Sunset` header and `x-sunset` must name the same date (the route test asserts it for `/api/context/combos/default`).
2. **Minimum notice.** `stable`: at least 90 days between the first release that emits the headers and the sunset date, spanning at least one minor release. `experimental`: at least 30 days. `internal`: no minimum, but the operation is still marked and documented before removal.
3. **Replacement.** The deprecation response or description must name the replacement (for example, `/api/settings/compression` for the deprecated combo-default writes).
4. **Sunset.** Until the sunset date the operation keeps its documented behaviour (or its documented 410). After it, the handler and the spec entry may be removed in a dedicated change. Removing an operation is an oasdiff breaking change, so that change must carry a reviewed `openapiBreaking` rebaseline in `config/quality/quality-baseline.json`; `x-sunset` is the extension oasdiff reads for its sunset checks.

Current deprecations:

| Operation                          | Deprecated | Sunset     | Replacement                                      |
| ---------------------------------- | ---------- | ---------- | ------------------------------------------------ |
| `PUT /api/context/combos/default`  | 2026-06-21 | 2026-12-31 | Edit engines through `/api/settings/compression` |
| `POST /api/context/combos/default` | 2026-06-21 | 2026-12-31 | Edit engines through `/api/settings/compression` |

## Adding or changing a route

1. Create the `route.ts` under `src/app/api/`. Classify it in `src/server/authz/routeGuard.ts` if it spawns processes or is destructive (Hard Rules #15/#17; `check:route-guard-membership`).
2. Document **every exported verb** in `docs/openapi.yaml` with `tags`, `summary`, `security`, `responses`, the route-guard annotations, and the governance extensions: `x-stability` (new routes start as `internal` or `experimental`), `x-owner`, `x-since` (the release that ships it), `x-rate-limit`.
3. Add a test that imports the route module or calls its URL. A route with no test reference fails the gate.
4. To promote an operation to `stable`: add a contract test that names the path, set `x-contract-test`, add a request or response example, and make sure `security` is declared.
5. Run `npm run check:api-governance`, `npm run check:openapi-coverage`, `npm run check:api-docs-refs` and `npm run check:openapi-security-tiers`.

The client-facing catalog of common flows is [API Use Cases](../reference/API_USE_CASES.md); the gate checks that every operation it lists exists and that its stability matches the spec.

## Ratchet baseline

Two kinds of debt existed when the gate was introduced and are frozen in `config/quality/api-governance-baseline.json`. Entries may only be removed: a new entry fails, and an entry that no longer applies fails as stale.

- **`untestedRoutes`** — routes no file under `tests/` references, either by importing the route module or by quoting a parameter-free URL. Writing those tests is backlog.
- **`phantomOperations`** — verbs documented in the spec that the route does not export. Deleting them is an oasdiff breaking change, so each removal needs its own reviewed rebaseline rather than being bundled into an unrelated change.

Everything else (undocumented routes or verbs, missing metadata, stable without a contract test, deprecated without a sunset) is a hard rule with no allowlist.

## Known limitations

- `x-since` cannot tell apart operations that existed before v3.8.53; only operations added later carry their real release.
- Test-reference detection is textual. It proves a test names the route, not that the test asserts its contract; that stronger guarantee is only required for `stable` via `x-contract-test`.
- `tests/e2e/compat-isolated.test.ts` runs through `npm run test:compat` and is not wired into a CI workflow today, so three of the six stable operations are pinned by a contract test that CI does not execute.
- The generated modules (`src/app/docs/lib/openapi.generated.ts`, `bin/cli/api-commands/`) do not surface the governance extensions.
