---
title: "Routing Contract and Route Explanation"
version: 3.8.54
lastUpdated: 2026-09-18
---

# Routing Contract and Route Explanation

This page describes the contract the router uses to decide which provider serves a request, how
a decision can be previewed without calling a provider, and how a live decision is explained after
the request ran. It covers the `auto` combo strategy, which is where OmniRoute scores candidates.

## Types

The types live in `src/shared/contracts/routing.ts` and are shared by `src/` and `open-sse/`.

| Type                     | Purpose                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RoutingRequest`         | What is routed: `requestId`, `model`, `protocol`, optional `capabilities`, `workspaceId`, `policyId`, `stream`, `budget`                                                |
| `RoutingBudget`          | Optional `maxCost` (USD) and `maxLatencyMs`; read by previews and by the `attemptPolicy.ts` library, not by live traffic (see Guarantees)                               |
| `RoutingCandidate`       | One provider/model: `score`, weighted `factors`, `eligible`, `exclusionReasons`, `quota`, `circuit`, estimated cost and latency                                         |
| `RoutingDecision`        | `decisionId`, `requestId`, `selected`, `candidates`, `policyVersion`, `generatedAt`, `liveRequestExecuted`, `selectionMode`, `strategy`, optional `omittedCandidates`   |
| `ProviderAttempt`        | One upstream call: provider, model, attempt number, start time, duration, status, `outcome`                                                                             |
| `RoutingExclusionReason` | `not_in_candidate_pool`, `model_not_found`, `capability_missing`, `quota_exhausted`, `circuit_open`, `self_healing_excluded`, `cost_over_budget`, `latency_over_budget` |

Candidates never carry connection or account identifiers, prompts or credentials.

## Guarantees

| Guarantee                                   | How it holds                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview uses the live selection algorithm   | Live selection and preview both run `selectProviderWithTrace()` in `open-sse/services/autoCombo/engine.ts`                                                                                                                                                     |
| Preview calls no provider, changes no state | The preview passes `previewSelectionDeps()`: clones of the self-healing and rotation state, exploration off                                                                                                                                                    |
| Policy version on every decision            | `computeRoutingPolicyVersion()` hashes combo name, candidate pool, weights, mode pack, budget, exploration rate and router strategy (`rp_` + 16 hex characters)                                                                                                |
| Every exclusion has a reason                | `hardExclusionReasons()` and the engine trace in `open-sse/services/autoCombo/routingDecision.ts`                                                                                                                                                              |
| Unknown quota is not exhausted              | `quota: "unknown"` stays eligible and is scored neutral; only a quota cutoff produces `quota_exhausted`                                                                                                                                                        |
| No blind retry of permanent errors          | Live: the combo loops retry the same target only on 408, 429, 500, 502, 503 and 504 (`isRetryableAttemptStatus()` in `open-sse/services/routing/attemptPolicy.ts`)                                                                                             |
| Auto combo failover stays in the cost cap   | Live, `rules` router strategy only: `orderTargetsByCostBudget()` drops (`strict`) or moves last (`cheapest`) targets whose estimated 1K-token request cost exceeds `budgetCap`. Explicit router strategies (`cost`, `latency`, `lkgp`, ...) ignore `budgetCap` |
| Deterministic circuit breaker               | `src/shared/utils/circuitBreaker.ts` accepts an injected clock; `peekState()` reads the effective state without changing it                                                                                                                                    |
| End-to-end correlation                      | Live decisions are recorded under the request id the client receives (`x-request-id`) and under their decision id                                                                                                                                              |

## Previewing a decision

`POST /api/omniroute/route/preview` requires management authentication and never calls a
provider.

- `{ "candidates": [...] }` keeps the original adaptive what-if ranking and its response shape.
- `{ "engine": "auto", "request"?, "policy"?, "candidates": [...] }` runs the live auto-combo engine
  on the supplied candidates and returns the full decision.

```bash
curl -s -X POST http://localhost:20128/api/omniroute/route/preview \
  -H "Authorization: Bearer $OMNIROUTE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "engine": "auto",
    "request": { "model": "auto/coding", "budget": { "maxLatencyMs": 1500 } },
    "policy": { "name": "preview" },
    "candidates": [
      { "provider": "alpha", "model": "alpha-model", "costPer1MTokens": 1, "p95LatencyMs": 300, "quotaRemaining": 80 },
      { "provider": "beta", "model": "beta-model", "costPer1MTokens": 1, "p95LatencyMs": 3000 }
    ]
  }'
```

The answer contains `selected`, `candidates` and `decision` (with `policyVersion` and
`liveRequestExecuted: false`), plus the `x-request-id` and `x-omniroute-decision-id` headers. A
candidate without `quotaRemaining` is reported with `quota: "unknown"`.

## Explaining a live request

1. The v1 chat completions, responses and messages routes run inside the request id the
   authorization pipeline stamps, so the router records its decision under that id.
2. Non-streaming responses carry `X-OmniRoute-Decision-Id` and `X-OmniRoute-Policy-Version`.
   Streaming responses are sent before routing finishes; use the request id instead.
3. `GET /api/omniroute/route/decisions/{id}` returns a decision by decision id or request id.
   Decisions are kept in memory for 30 minutes; unknown and malformed ids both return 404.
4. `GET /api/usage/route-explain/{id}` adds `routingDecision` to the call-log explanation when a
   decision is still retained for that request id.
5. The dashboard Route Trace tab has a lookup card for a request id or decision id.

```bash
curl -s http://localhost:20128/api/omniroute/route/decisions/<request-id> \
  -H "Authorization: Bearer $OMNIROUTE_TOKEN"
```

## Diagnostic mode

Every recorded decision is logged at debug level with its decision id, policy version and request
id. Set `OMNIROUTE_ROUTING_DIAGNOSTICS=1` to also log a counts-only summary at info level:
candidate count, eligible count, exclusion reasons, strategy and selection mode. Neither log line
contains prompts, credentials or connection identifiers.

## Limits

- Decisions are recorded for the `auto` combo strategy; other combo strategies keep the combo
  decision trace (`/api/usage/combo-trace/{id}`).
- Live candidates do not yet distinguish unknown quota from a known value, because the candidate
  builder lives in a file at its size cap; preview candidates do.
- Live traffic has no per-request `RoutingBudget` input. The only live cost limit is the auto
  combo's `budgetCap` on the `rules` path, checked per attempt against a 1K-token estimate; there
  is no cumulative spend check and no live latency budget.
- `classifyAttemptOutcome()`, `isPermanentAttemptOutcome()`, `canRetrySameCandidate()`,
  `checkFailoverBudget()` and `planNextAttempt()` are a tested library with no live caller yet.
  Previews apply `maxCost` and `maxLatencyMs` as exclusions.
- Decisions are held in memory and are lost on restart. A stored live decision keeps at most 40
  candidates (the selected one always), full factors only for the selected candidate and the 10
  best, and reports the rest as `omittedCandidates`. The store also has a 32 MB size budget, so
  under heavy traffic a decision can be evicted before its 30 minutes are up.
