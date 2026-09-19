---
title: "OmniRoute Roadmap"
version: 3.8.54
lastUpdated: 2026-09-19
---

# OmniRoute Roadmap

> Version-gated, not date-gated: each milestone ships when its quality gates pass.
> Current line: **v3.8.x** (this branch). Last updated: 2026-09-19.

OmniRoute is heading from a monolithic router to a **modular AI platform**: a lightweight
core engine, a typed SDK, and everything else as installable modules and plugins. The path
runs through a stabilization rail (3.8.50 → 3.8.59), an LTS anchor (**3.9.0**), and the
modular **4.0**.

## The rail at a glance

```
3.8.50 ─ 3.8.54   PREPARE   non-breaking structural prep (all PRs welcome)
3.8.55 ─ 3.8.59   VALIDATE  stabilization (fixes / docs / i18n / providers only)
3.9.0             LTS       stable/v3 branch · long-term support line
4.0.0-nightly/rc  MODULAR   core + SDK + modules + marketplace (develop branch)
4.0.0             GA        latest switches to v4 · v3 stays supported as LTS
```

## Phase 1 — Preparation (3.8.50 → 3.8.54)

Non-breaking structural work that de-risks the modular split. Every version closes with a
mandatory quality-gate battery before new merges open.

| Version | Focus                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.8.50  | CI safety net on release branches · dead-code cleanup · community-reported catalog/topology bug fixes · contributor "golden path" guide                                                                         |
| 3.8.51  | Executor registry (in-place) · end-to-end provider-journey contract test becomes a CI gate · official scoped-test dev loop · CI lane consolidation (shared install/setup across gate jobs, #8084)               |
| 3.8.52  | `combo.ts` decomposition · routing-strategy registry · unified model-catalog contract for `/v1/models` · one CI policy for PRs to `release/**` and `main` (#8084)                                               |
| 3.8.53  | `chatCore.ts` decomposition · headless mode (`OMNIROUTE_HEADLESS=1`) · local candidate build/promote loop                                                                                                       |
| 3.8.54  | Release infrastructure (dormant): channels, labels, PR templates, merge queue · full-regression authority moves to the merge queue once TIA shadow evidence clears (#8084) · public feature-freeze announcement |

## Evolution plan delivered in 3.8.54

The 3.8.54 line of the `LMPrado-DZ23` fork also carries the phased evolution plan tracked in [docs/EVOLUTION_STATUS.md](docs/EVOLUTION_STATUS.md). It is non-breaking: every HTTP contract is kept, new response fields, headers and endpoints are additive, and new behavior that could surprise an existing installation (SLO webhook alerts, routing diagnostics) is opt-in.

| Area                  | Delivered in 3.8.54                                                                                                | Next                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Typecheck and runtime | Core, API, dashboard and open-sse typecheck at 0 errors; 22 runtime bugs fixed red-first                           | Keep the ratchets at 0                                                             |
| Tests                 | Live tests opt-in behind `RUN_LIVE_TESTS=1`; 5-shard PR fast-path with failure artifacts                           | Bring Fast Quality Gates under 10 minutes                                          |
| Routing               | Router contract, explainable decisions, shared preview/live selection, decision lookup by request id               | Quota-known flag and a live latency budget once `combo.ts` is decomposed           |
| Observability         | Bounded-cardinality metrics, `GET /api/metrics`, configurable SLOs, opt-in alerts                                  | Persist counters; attempt and fallback fields on routing events                    |
| Onboarding            | One-time `INITIAL_PASSWORD` bootstrap, re-runnable wizard, actionable provider errors, end-to-end coverage         | Guided first combo and first key                                                   |
| API governance        | Every operation classified; 100% OpenAPI coverage gate; deprecation headers                                        | Contract tests for the 151 routes no test references yet                           |
| Workspaces and RBAC   | Role layer, admin audit, budget alerts, credential-reveal hardening; design ADR                                    | Workspace and project tables and the budget hierarchy (3.9.x, additive migrations) |
| Accessibility         | 0 serious axe violations on login, dashboard, providers and settings from 375 to 1440 px                           | Combos, logs and onboarding pages; dark-theme contrast                             |
| Supply chain          | Vulnerability register; 0 high/critical in production dependencies; digest-pinned sidecars                         | Lockfile-only refresh PR for the recorded Electron advisory (R-10)                 |
| Documentation         | First 10 minutes, backup/restore, migration, compatibility matrix, routing contract, API governance, SDK reference | Keep pt-BR in step                                                                 |
| SDKs                  | Experimental TypeScript and Python SDKs with contract fixtures and an OpenAPI drift test                           | Decide publication after the HTTP contract freeze in 3.8.59                        |

## Phase 2 — Validation (3.8.55 → 3.8.59)

**External feature PRs pause here** (they get the `v4-feature` label and are re-targeted to
the v4 channel when it opens). Fixes, docs, i18n, and provider updates keep flowing.

| Version | Focus                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.8.55  | Characterization tests for every extraction candidate · coupling re-measurement                                                              |
| 3.8.56  | Extended canary · performance baselines (heap, TTFB, build)                                                                                  |
| 3.8.57  | Security & compliance sweep · publish provenance (OIDC) rehearsal                                                                            |
| 3.8.58  | Full dry-run of the 3.9.0 cut (branches, channels, forward-port) — includes the PR preview-artifact + build-once promotion rehearsal (#8084) |
| 3.8.59  | Final freeze · full-suite audit · GO/NO-GO                                                                                                   |

## Phase 3 — v3.9.0 LTS

After 3.8.59 the next version is **3.9.0** (there is no 3.8.60). It creates the long-lived
branch model:

- **`stable/v3`** — the LTS line (3.9.x). Receives fixes, security patches, and provider
  updates. `npm install omniroute` (aka `latest`) stays on v3 during the whole v4 cycle.
- **`develop`** — v4 development, published as `4.0.0-nightly.*`.
- **`main`** — v4 release candidates (`next`) and, eventually, GA.
- Fixes merged to `stable/v3` are automatically forward-ported to `develop` with full
  contributor credit (`Co-authored-by`).

New features land in the v4 channel. The LTS line is stability-first.

## Phase 4 — v4.0: the modular platform

The monolith is intentionally disassembled on `develop`:

- **`@omniroute/core`** (npm name stays `omniroute`) — just the engine: `/v1/*`, routing,
  combo/fallback, providers.
- **`@omniroute/sdk`** — one typed contract: hooks, extension points, two-phase lifecycle,
  UI contributions. The five extension systems that exist today (plugins, CLI plugins,
  skills, MCP tools, A2A skills) collapse into one declarative manifest.
- **Modules** (`@omniroute/mod-*`) — cloud agents, traffic inspection (MITM), evals,
  webhooks, memory, guardrails, observability and more move out of the core, each with its
  own version and lifecycle.
- **Providers as plugins** — adding a provider stops touching the core.
- **Marketplace** — one-click install with verified integrity (hash pinning, signing,
  sandbox). Free in v1; a paid tier later with revenue share for creators.
- Ships as `4.0.0-nightly.*` → `4.0.0-rc.N` (soak in production) → **4.0.0 GA**, when
  `latest` switches to v4 and v3 enters its announced LTS support window.

**The core is MIT and free, forever.**

## For contributors

| You are sending... | Target today            | From 3.8.55                  | After 3.9.0    |
| ------------------ | ----------------------- | ---------------------------- | -------------- |
| Bug fix / security | active `release/v3.8.x` | same                         | `stable/v3`    |
| Provider update    | active `release/v3.8.x` | same                         | `stable/v3`    |
| Docs / i18n        | active `release/v3.8.x` | same                         | `stable/v3`    |
| New feature        | active `release/v3.8.x` | held with `v4-feature` label | `develop` (v4) |

See `CONTRIBUTING.md` for the golden path per change type.
