---
title: "Evolution Status"
version: 3.8.54
lastUpdated: 2026-09-19
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

Five further pull requests closed the findings of the independent audits that followed the phases.
The first audit round produced [#37](https://github.com/LMPrado-DZ23/OmniRoute/pull/37) (SDK and
credential handling), [#38](https://github.com/LMPrado-DZ23/OmniRoute/pull/38) (routing and SLO) and
[#39](https://github.com/LMPrado-DZ23/OmniRoute/pull/39) (product and UX). The verification round —
the same three auditors re-checking those fixes on the final tree — produced
[#41](https://github.com/LMPrado-DZ23/OmniRoute/pull/41) (a routing hot-path regression this release
had introduced, plus eight health read paths that were mutating circuit-breaker state) and
[#42](https://github.com/LMPrado-DZ23/OmniRoute/pull/42) (a cross-origin redirect body leak in the
TypeScript SDK, a stale supply-chain claim, and three smaller items).

The consolidated result is in
[`audit/FINAL_THREE_AGENT_REVIEW.md`](../audit/FINAL_THREE_AGENT_REVIEW.md).

## Phase 0: diagnosis

- Toolchain: Node v24.16.0, npm 11.13.0. The declared `engines` range is
  `>=22.22.2 <23 || >=24.0.0 <27`; which of those majors is tested per PR, tested nightly or
  only declared is in [the compatibility matrix](reference/COMPATIBILITY_MATRIX.md), and
  `npm run check:node-runtime` exits non-zero outside the range. Lockfile: `package-lock.json`.
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

A vulnerability register records every advisory with its blast radius and decision, and the sidecar
images are digest-pinned. Measured on the release tree with `npm audit --omit=dev
--package-lock-only`:

| Tree                | info | low | moderate | high  | critical |
| ------------------- | ---- | --- | -------- | ----- | -------- |
| Root production     | 0    | 0   | 0        | **0** | **0**    |
| Electron production | 0    | 0   | 0        | **0** | **0**    |

Re-measured on 2026-09-19 after the `js-yaml` fix below. The Electron tree is also clean in the
full run that includes dev dependencies (`npm audit --package-lock-only`: 0 across every
severity).

The verification round caught this claim being stale: a second, higher advisory on `adm-zip`
(GHSA-7q85-xj36-vmfc, high, fixed in 0.6.1) had appeared in the root production tree through the
optional `@huggingface/transformers` → `onnxruntime-node` chain, while the register still said there
was none. It was fixed rather than re-documented — a lockfile-only bump to 0.6.1 inside the existing
`^0.6.0` override, a three-line diff that took root production from `high: 1, moderate: 2` to zero.

The last remaining `high` was then cleared the same way rather than carried: `js-yaml` 4.3.1, register
id **R-10**, reachable only from the Electron shell's update-check chain (`electron-updater` 6.8.9 →
`js-yaml`), never in the container image, the npm package or the server runtime. A lockfile-only bump
to 4.3.2 inside the existing `^4.2.0` override took Electron production from `high: 1` to zero, and
the shared hoisted copy meant it cleared the dev-tree `electron-builder` entries too. `package.json`
is unchanged; the diff is five lines of `electron/package-lock.json`. **No advisory is accepted as
residual in either shipped production tree.**

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

## Architectural decisions

These are the decisions the phases were built on. Each one was taken to avoid a change that would
have been irreversible or contract-breaking in a patch release.

1. **The routing contract is a type-only module.** `src/shared/contracts/routing.ts` has no runtime
   dependency, so the API, the dashboard, open-sse and the SDKs can share one vocabulary without a
   new package or a circular import.
2. **Preview and live traffic run the same selection engine.** A separate preview implementation
   would drift from the real one. Instead, `selectProviderWithTrace` takes its dependencies as a
   parameter, and preview passes cloned healer/rotator state with a deterministic RNG, so it cannot
   mutate live routing state and cannot consume randomness.
3. **The policy version is derived, not stored.** `rp_<hash>` is computed from the candidate pool,
   weights, mode pack, budget cap and strategy, so two installations with the same configuration
   report the same version and no migration is needed.
4. **The decision store is in-memory, bounded by both count and bytes.** Persisting decisions would
   need a migration and a retention policy; a 30-minute TTL with a 2000-entry cap and a 32 MB budget
   answers the "why did this request go there" question without touching the database.
5. **Management roles are derived from the scopes that already exist.** Introducing a role table in
   a patch release would force a migration on every installation; deriving roles keeps the change
   additive, and the workspace/project hierarchy is deferred to 3.9.x where migrations are expected.
6. **`open-sse/services/combo.ts` was not decomposed here.** It sits at its frozen size cap, so the
   phase-3 work was added around it (`services/routing/`, `services/combo/`) and only a single
   line-count-neutral substitution was made inside it. The decomposition is a 3.8.55+ task with its
   own regression budget.
7. **New behavior that an existing installation would notice is opt-in.** SLO webhook alerts and the
   routing diagnostics log are off by default; upgrading from 3.8.53 changes nothing until an
   operator turns them on.
8. **The SDKs are not published.** The `omniroute` package names belong to the upstream project, and
   publishing an experimental client before the HTTP contract freeze would create a compatibility
   promise this fork is not ready to keep.

## Risks

| Risk                                                                                              | Likelihood | Impact                                                        | Mitigation                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The in-memory decision store grows under a burst of wide candidate pools                          | Low        | Memory pressure on the server process                         | Bounded by count, by a 32 MB byte budget and by a 30-minute TTL; candidates are compacted before storage                                                         |
| An operator enables SLO webhook alerts and gets paged by a breach that is really an idle provider | Low        | Alert fatigue                                                 | An idle open breaker reports `insufficient_data` instead of breaching; alert state resets when alerting is toggled                                               |
| A routing decision id is guessed and read by another caller                                       | Low        | Disclosure of routing metadata (never prompts or credentials) | Management auth on the lookup route; identical `404` for unknown and malformed ids                                                                               |
| The Electron `js-yaml` advisory (R-10) is exploited                                               | Closed     | Build-chain only; no server or dashboard exposure             | **Fixed** 2026-09-19: lockfile-only bump to `js-yaml` 4.3.2; Electron production audit is now clean                                                              |
| The 151 OpenAPI-covered routes without a contract test drift from the served contract             | Medium     | Documentation and SDKs disagree with the server               | The governance baseline tracks them and cannot grow; the SDK drift test covers the documented surface                                                            |
| A gate or test run without isolated `DATA_DIR`/`HOME` touches a developer's real database         | Medium     | Unintended migration on a production install                  | Every command in this release exported isolated `DATA_DIR`, `HOME`, `USERPROFILE` and `APPDATA`; `tests/_setup/isolateDataDir.ts` enforces it in the test runner |

## Known limits of this release

- The **workspace and budget hierarchy** is designed but not implemented (Phase 8 ADR).
- **151 routes** are covered by OpenAPI but have no contract test referencing them yet; the
  governance baseline tracks them.
- ~~The **`js-yaml` R-10** advisory in the Electron chain is accepted as residual.~~ Fixed
  2026-09-19 — `js-yaml` 4.3.2, lockfile only. No advisory is accepted as residual in either
  shipped production tree.
- A live **latency budget** is not enforced per candidate; the contract documents exactly what live
  traffic does enforce, and the remaining work depends on decomposing `open-sse/services/combo.ts`.
- Accessibility was gated on login, dashboard, providers and settings; combos, logs and onboarding
  pages are next.

## Verification commands

Every command below must run with an isolated data directory, or it will open the developer's real
database:

```bash
export DATA_DIR="$(mktemp -d)" HOME="$(mktemp -d)" APPDATA="$(mktemp -d)"
export USERPROFILE="$HOME" DISABLE_SQLITE_AUTO_BACKUP=true
```

| What                         | Command                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck (4 projects)       | `npx tsc --noEmit -p tsconfig.typecheck-core.json` · `-p tsconfig.typecheck-api.json` · `-p tsconfig.typecheck-dashboard.json` · `-p open-sse/tsconfig.json`       |
| Lint at zero warnings        | `npx eslint --max-warnings=0 --suppressions-location config/quality/eslint-suppressions.json --pass-on-unpruned-suppressions --no-warn-ignored`                    |
| Unit tests (node runner)     | `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 <files>` |
| Component tests              | `npx vitest run --config vitest.config.ts`                                                                                                                         |
| Full serialized suite        | `npm test`                                                                                                                                                         |
| Live provider tests (opt-in) | `npm run test:combo:live` and `npm run test:boundary:live`, each gated by its own `RUN_*_LIVE=1`                                                                   |
| API governance               | `npm run check:api-governance`                                                                                                                                     |
| Documentation                | `npm run check:docs-all`                                                                                                                                           |
| Changelog integrity          | `npm run check:changelog-integrity`                                                                                                                                |
| Dependency audit             | `npm audit --omit=dev`                                                                                                                                             |
| Accessibility                | the end-to-end axe specs under `tests/e2e/`                                                                                                                        |

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
