---
title: "Evolution Status"
version: 3.8.54
lastUpdated: 2026-09-18
---

# OmniRoute evolution status

Release line `release/v3.8.54` of the `LMPrado-DZ23/OmniRoute` fork, based on `release/v3.8.53`
(`2560ec3a4`). A new branch was needed because `release/v3.8.53` is frozen by its tag.

This file tracks the phased evolution plan: diagnose first, make the typecheck green, and only then
add capability. Every number below comes from a command that was actually run; the command is named
next to the result. Each phase landed as its own pull request against `release/v3.8.54`.

The release is **non-breaking**. Existing HTTP contracts are kept; new response fields, headers and
endpoints are additive; and behavior that could surprise an existing installation (SLO webhook
alerts, routing diagnostics) is opt-in and off by default.

## Phases

| Phase | Scope                                                            | PR                                                       | Merge commit | Status |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------- | ------------ | ------ |
| 0     | Diagnosis of the current state (no code changes)                 | [#24](https://github.com/LMPrado-DZ23/OmniRoute/pull/24) | `48e5412f6`  | Done   |
| 1     | Runtime bugs and typecheck (core, API, dashboard, open-sse at 0) | [#24](https://github.com/LMPrado-DZ23/OmniRoute/pull/24) | `48e5412f6`  | Done   |
| 2     | Test suite organization (fast / serialized / integration / live) | [#25](https://github.com/LMPrado-DZ23/OmniRoute/pull/25) | `2ac9f74a6`  | Done   |
| 3     | Router contract and explainable decisions                        | [#30](https://github.com/LMPrado-DZ23/OmniRoute/pull/30) | `00a7c057f`  | Done   |
| 4     | Route explanation (correlation, lookup, diagnostics)             | [#34](https://github.com/LMPrado-DZ23/OmniRoute/pull/34) | `20d5b2ca2`  | Done   |
| 5     | Observability and SLOs                                           | [#33](https://github.com/LMPrado-DZ23/OmniRoute/pull/33) | `67b461b62`  | Done   |
| 6     | Onboarding (first use)                                           | [#36](https://github.com/LMPrado-DZ23/OmniRoute/pull/36) | `0fdd34fbb`  | Done   |
| 7     | API governance                                                   | [#26](https://github.com/LMPrado-DZ23/OmniRoute/pull/26) | `8ab38f721`  | Done   |
| 8     | Costs, workspaces and RBAC                                       | [#31](https://github.com/LMPrado-DZ23/OmniRoute/pull/31) | `8167211a4`  | Done   |
| 9     | Accessibility                                                    | [#32](https://github.com/LMPrado-DZ23/OmniRoute/pull/32) | `6edf22fda`  | Done   |
| 10    | Supply chain                                                     | [#27](https://github.com/LMPrado-DZ23/OmniRoute/pull/27) | `931c32956`  | Done   |
| 11    | Documentation                                                    | [#28](https://github.com/LMPrado-DZ23/OmniRoute/pull/28) | `9403957c7`  | Done   |
| 12    | SDKs                                                             | [#29](https://github.com/LMPrado-DZ23/OmniRoute/pull/29) | `a7623af65`  | Done   |

Three further pull requests closed the findings of the independent audit that followed the phases:
[#37](https://github.com/LMPrado-DZ23/OmniRoute/pull/37) (SDK and credential handling),
[#38](https://github.com/LMPrado-DZ23/OmniRoute/pull/38) (routing and SLO) and
[#39](https://github.com/LMPrado-DZ23/OmniRoute/pull/39) (product and UX).
The consolidated result is in [`audit/FINAL_THREE_AGENT_REVIEW.md`](../audit/FINAL_THREE_AGENT_REVIEW.md).

## Phase 0: diagnosis

- Toolchain: Node v24.16.0 (inside the supported `>=24.0.0 <27` range), npm 11.13.0,
  `package-lock.json`.
- Inventory: 3400 files in `src/`, 5736 in `tests/`, 709 `route.ts` files under `src/app/api`.
- Baseline before any change:

| Command                                                 | Exit | Errors |
| ------------------------------------------------------- | ---- | ------ |
| `npx tsc --noEmit -p tsconfig.typecheck-core.json`      | 0    | 0      |
| `npx tsc --noEmit -p tsconfig.typecheck-api.json`       | 2    | 289    |
| `npx tsc --noEmit -p tsconfig.typecheck-dashboard.json` | 2    | 201    |
| `npm run lint`                                          | 0    | 0      |

- Root cause of most API errors: the API and dashboard projects run with `strictNullChecks: false`,
  so `if (!result.ok)` does not narrow `{ ok: true } | { ok: false }` unions. Fixes use type
  predicates at the type's origin instead of casts at call sites.

## Phase 1: runtime and typecheck

| Command                                                 | Exit | Errors |
| ------------------------------------------------------- | ---- | ------ |
| `npx tsc --noEmit -p tsconfig.typecheck-core.json`      | 0    | 0      |
| `npx tsc --noEmit -p tsconfig.typecheck-api.json`       | 0    | 0      |
| `npx tsc --noEmit -p tsconfig.typecheck-dashboard.json` | 0    | 0      |
| `npx tsc --noEmit -p open-sse/tsconfig.json`            | 0    | 0      |
| `npm run lint`                                          | 0    | —      |

No `any`, `@ts-ignore`, `@ts-expect-error` or new broad casts were added; two unused
`@ts-expect-error` comments were removed. No test was removed, skipped or weakened.

**22 runtime bugs** were found through the typecheck and fixed red-first — each has a regression
test that failed before the fix and passes after it. Two of them were access-policy or data-loss
defects: `PATCH /api/keys/[id]` silently dropped `blockedModels`, so a key kept serving models the
operator had blocked; and `POST /api/cli-tools/omp-settings` (plus the cline, kilo and letta
settings routes) replaced an unreadable CLI config file with only OmniRoute's own keys.
`POST /api/omniroute/route/preview` failed for every valid request.

### How each commit was verified

1. The targeted tests run before the patch, and their failures are recorded.
2. The patch is applied and formatted with Prettier.
3. All four TypeScript projects run: core, API, dashboard and open-sse.
4. Nothing is committed unless all of these hold: core and open-sse report 0 errors; no error
   signature (`file | code | message`) is new; the API + dashboard total strictly decreases; the
   targeted tests add no failure; ESLint (`--max-warnings=0`) and Prettier pass on the changed
   files; and, for a bug fix, the regression test written first passes after the fix.

The frozen typecheck baselines in `config/quality/` are ratcheted down in the same commit.

## Phase 2: test suite organization

Live tests now require an explicit `RUN_LIVE_TESTS=1` — before this phase, some integration files
sent real provider traffic whenever `OMNIROUTE_API_KEY` happened to be exported. `npm test` runs
the serialized suite. The pull-request unit fast-path was split from 4 shards into 5 and keeps its
failure logs as artifacts.

Measured on CI: the 5 shards run in **7m31s–10m0s** (they were 9.4–10.8 min with 4 shards), which
moved the critical path off the unit tests.

## Phase 3: router contract

A new `src/shared/contracts/routing.ts` defines `RoutingRequest`, `RoutingCandidate`,
`RoutingDecision` and `ProviderAttempt`, with:

- score **factors** per candidate, so a decision can be explained instead of guessed;
- explicit **exclusion reasons** (`not_in_candidate_pool`, `capability_missing`, `quota_exhausted`,
  `circuit_open`, `cost_over_budget`, …) instead of a silent drop;
- **unknown** quota state kept distinct from **exhausted**;
- a **policy version** (`rp_<hash>`) stamped on every decision, derived from the candidate pool,
  weights, mode pack, budget cap and strategy;
- preview and live selection running the **same engine**, with preview never touching live routing
  state and never calling `Math.random`.

Failover now stays inside the request cost cap, and a permanent provider error is never retried on
the same candidate (`open-sse/services/routing/attemptPolicy.ts`).

Evidence: 14 decision scenarios plus the existing auto-combo suites, **159/159** passing.

## Phase 4: route explanation

Every routed response carries `X-OmniRoute-Decision-Id` and `X-OmniRoute-Policy-Version`, including
streaming responses. `GET /api/omniroute/route/decisions/{id}` returns the decision behind a request
id or a decision id under management auth, with an identical `404` for an unknown and for a
malformed id. The dashboard gained a decision lookup card on the analytics page.

`OMNIROUTE_ROUTING_DIAGNOSTICS=1` promotes the decision summary from debug to info; it is off by
default and the summary never contains prompts, responses or credentials.

Evidence: correlation suite **6/6**, lookup component **3/3** under Vitest, **49** tests in the
phase overall. The contract is documented in [`docs/routing/ROUTING_CONTRACT.md`](routing/ROUTING_CONTRACT.md).

## Phase 5: observability and SLOs

Bounded-cardinality routing metrics and `GET /api/metrics` (Prometheus text or JSON, management
auth). SLO targets are configurable, with `slo.breached`, `slo.recovered` and
`provider.circuit_open` webhook alerts that are **opt-in**. `/api/telemetry/summary` `errorRate` was
corrected to failed / routed requests — it previously reported quota-monitor errors / requests.

Evidence: **428/428** regression tests on the phase branch.

## Phase 6: onboarding

The first-use flow now works end to end for a brand-new installation: the `INITIAL_PASSWORD`
bootstrap is one-time (it no longer re-applies on every boot), the wizard can be re-run, and a
failing provider check returns an actionable message instead of a generic error. The first-use path,
the re-run and the narrow layouts are covered by end-to-end tests, and the copy is localized.

## Phase 7: API governance

Every OpenAPI operation is classified with `x-stability` (`internal` / `experimental` / `stable` /
`deprecated`), `x-owner`, `x-since`, `x-rate-limit` and, for stable operations, `x-contract-test`.
A `check:api-governance` gate enforces the metadata, and the OpenAPI coverage gate is at **100%**.
Deprecations emit RFC 9745 `Deprecation` and RFC 8594 `Sunset` headers.

Evidence at the phase PR: gate **PASS** over **709 routes / 1039 operations**.

## Phase 8: costs, workspaces and RBAC

Management roles are derived from the scopes that already exist, so no migration is needed. Budget,
CLI token and API key admin mutations are written to the audit trail, and an internal budget warning
now emits a `budget.threshold_reached` webhook. Revealing a provider credential was hardened: it
requires a dashboard session and is refused for a programmatic management credential.

Evidence: authorization matrix (owned / foreign / nonexistent resource, at the route-handler level)
**302/302**. The workspace and budget hierarchy itself is deliberately **not** implemented in this
release; the design is recorded as an ADR under `docs/architecture/` and is planned for 3.9.x as
additive migrations.

## Phase 9: accessibility

A WCAG 2.2 AA pass over login, dashboard, providers and settings: dialog semantics and focus
management shared through `useDialogFocus`, explicit labels on checkboxes, toggles and the login
password field, theme-aware contrast tokens, operable sidebar section headers, and a single skip
link with a focusable main target.

Evidence: **0** serious axe violations from **375 px to 1440 px**, including keyboard flows, gated
in the end-to-end suite. The settings page baseline went from 5 violations to 0.

## Phase 10: supply chain

A vulnerability register records every advisory with its blast radius and decision. The production
dependency audit reports **0 high/critical**. Sidecar images are digest-pinned.

One advisory is accepted as residual: `js-yaml` 4.3.1 (high) reachable only from the Electron shell
chain, register id **R-10**. It needs an Electron lockfile refresh, which is out of scope for this
release; it does not affect the server or dashboard runtime.

## Phase 11: documentation

New pages: first 10 minutes, backup and restore, migration guide and compatibility matrix, each with
a pt-BR version. New issue forms for provider failure, documentation, regression and compatibility.

Evidence: `npm run check:docs-all` exit **0**.

## Phase 12: SDKs

Experimental TypeScript and Python SDKs, sharing contract fixtures with an OpenAPI drift test so the
SDKs cannot silently diverge from the served contract.

Evidence: TypeScript **45/45**, Python **12** passing. They are **not published** to npm or PyPI:
the package names belong to the upstream project, and publication waits for the HTTP contract freeze
planned for 3.8.59.

## Known limits of this release

- The **workspace and budget hierarchy** is designed but not implemented (Phase 8 ADR).
- **151 routes** are covered by OpenAPI but have no contract test referencing them yet; the
  governance baseline tracks them.
- The **`js-yaml` R-10** advisory in the Electron chain is accepted as residual.
- A live **latency budget** is not enforced per candidate; the contract documents exactly what live
  traffic does enforce, and the remaining work depends on decomposing `open-sse/services/combo.ts`.
- Accessibility was gated on login, dashboard, providers and settings; combos, logs and onboarding
  pages are next.

## Windows host notes

Some gates and suites fail on a Windows development host for reasons unrelated to this branch; each
was reproduced unchanged on the `v3.8.53` tree, and Linux CI is the reference:

- `check-open-sse-typecheck.mjs`, `check-api-typecheck.mjs` and `check-dashboard-typecheck.mjs` fail
  with `spawnSync npx.cmd EINVAL` (they spawn `npx.cmd` without a shell); run `tsc` directly plus
  `scripts/check/typecheckBaseline.mjs` instead.
- `check:lockfile`, `check:licenses` and `check-dead-code.mjs` hit the POSIX `.bin` shims; invoke the
  tool directly.
- EPERM when removing a temp directory while SQLite still holds the file, the libuv handle-closing
  assertion at process exit, and inode-reuse checks that rely on POSIX rename semantics.

Tests that isolate the home directory set `USERPROFILE` as well as `HOME`
(`tests/helpers/tempHome.ts`). Every gate and test run for this release exported isolated
`DATA_DIR`, `HOME`, `USERPROFILE` and `APPDATA`, after an earlier unisolated run applied a migration
to the developer's real database.
