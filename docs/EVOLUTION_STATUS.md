# OmniRoute evolution status

Branch `evolution/phase-0-1`, based on `release/v3.8.53` (`2560ec3a4`).
Last update: 2026-09-14 · HEAD `5b7227748` · 90 commits on top of the base.

This file tracks the phased stabilization plan: diagnose first, then make the typecheck green, and
only then move to new capabilities. Every number below comes from a command run on this branch; the
commands are listed next to each result.

## Phases

| Phase | Scope                                                                   | Status      |
| ----- | ----------------------------------------------------------------------- | ----------- |
| 0     | Diagnosis of the current state (no code changes)                        | Done        |
| 1     | Runtime bugs and typecheck (core, API, dashboard at exit 0)             | Done        |
| 2     | Test suite organization (fast / serialized / integration / live opt-in) | Planned     |
| 3     | Router contract (`RoutingRequest`, decision types)                      | Planned     |
| 4     | Route explanation                                                       | Not started |
| 5     | Observability and SLOs                                                  | Not started |
| 6     | Onboarding                                                              | Not started |
| 7     | API governance                                                          | Not started |
| 8     | Costs, workspaces and RBAC                                              | Not started |
| 9     | Accessibility                                                           | Not started |
| 10    | Supply chain                                                            | Not started |
| 11    | Documentation                                                           | Not started |
| 12    | SDKs                                                                    | Not started |

Phases 2 to 12 wait for Phase 1, as the plan requires: no new capability is added while any of the
three typecheck projects still reports errors.

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

### Result

| Command                                                 | Exit | Errors |
| ------------------------------------------------------- | ---- | ------ |
| `npx tsc --noEmit -p tsconfig.typecheck-core.json`      | 0    | 0      |
| `npx tsc --noEmit -p tsconfig.typecheck-api.json`       | 0    | 0      |
| `npx tsc --noEmit -p tsconfig.typecheck-dashboard.json` | 0    | 0      |
| `npx tsc --noEmit -p open-sse/tsconfig.json`            | 0    | 0      |
| `npm run lint`                                          | 0    | —      |

No `any`, `@ts-ignore`, `@ts-expect-error` or new broad casts were added. Two unused
`@ts-expect-error` comments were removed. No test was removed, skipped or weakened.

### How each commit was verified

Every commit went through the same local gate:

1. The targeted tests run before the patch, and their failures are recorded.
2. The patch is applied and formatted with Prettier.
3. All four TypeScript projects run: core, API, dashboard and open-sse.
4. Nothing is committed unless all of these hold:
   - core and open-sse report 0 errors;
   - no error signature (`file | code | message`) is new compared with the previous run;
   - the API + dashboard total strictly decreases;
   - the targeted tests add no failure;
   - ESLint (`--max-warnings=0`) and Prettier pass on the changed files;
   - for bug fixes, the regression test written first passes after the fix.

The frozen typecheck baselines in `config/quality/` are ratcheted down in the same commit.

The progress requirement was added after one commit removed a union member only to expose another
with the same error lines; that commit was reverted (`a6b87e300`).

### Bugs found through the typecheck and fixed (red-first)

Each fix below has a regression test that failed on this host before the fix and passes after it.

| Area                      | Bug                                                                                                                                                                                                                                                                                                                                                                  | Commit                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| API                       | `POST /api/oauth/codex/import` returned 500 for any invalid body (`parsed.error.errors` does not exist in Zod 4)                                                                                                                                                                                                                                                     | `23eda42d6`                                     |
| API                       | `/v1/images/edits`, `/v1/rerank`, `/v1/segment`, `/v1/web/fetch`, `/v1/classify`, `/v1/moderations`, `/v1/ocr`, `/v1/audio/*`, `/v1/music`, `/v1/videos`, `/v1/images/generations`, `/v1/search` and the provider-scoped image/embedding routes did not recognize a pool where every connection is expired: generic 401/500 instead of 401/402 with a reconnect hint | `42eea0cac` … `14fe24d0c`                       |
| API (data loss)           | `POST /api/cli-tools/omp-settings` replaced an unreadable `models.yml` with only the OmniRoute provider                                                                                                                                                                                                                                                              | `fa64d34c5`                                     |
| API (data loss)           | cline, kilo and letta settings routes rewrote the CLI's config/auth files with only OmniRoute's keys when a file was JSONC or unreadable                                                                                                                                                                                                                             | `3cdc7457b` `a4c041aaa` `e6d7369fd` `4f82d6833` |
| API                       | Codex responses WebSocket bridge threw `logger.warn is not a function` when proxy resolution failed                                                                                                                                                                                                                                                                  | `6e4b27df2`                                     |
| Runtime                   | The omp CLI database handle leaked when a statement threw (file locked on Windows)                                                                                                                                                                                                                                                                                   | `aa9455450`                                     |
| Electron                  | A denied privileged IPC call (remote dashboard) was read as success: autostart shown as on, denial object stored as the data dir                                                                                                                                                                                                                                     | `5b5107658`                                     |
| API                       | `POST /api/copilot/chat` answered invalid bodies with the message "[object Object]"                                                                                                                                                                                                                                                                                  | `c5c7ba02a`                                     |
| API (access policy, HIGH) | `PATCH /api/keys/[id]` dropped `blockedModels`: blocking only models returned 400, and blocks sent with other fields were silently not saved, so the key kept serving models the operator had blocked                                                                                                                                                                | `0c3e4f790`                                     |
| Routing                   | `POST /api/omniroute/route/preview` failed for every valid request (`candidates.map is not a function`)                                                                                                                                                                                                                                                              | `32a183983`                                     |
| OAuth                     | Cursor login cloud sync went to `/sync/undefined`                                                                                                                                                                                                                                                                                                                    | `922414d1c`                                     |
| Logging                   | Corrupted tier config warnings logged "[object Object]" as the tag and lost the error                                                                                                                                                                                                                                                                                | `e619be9f2`                                     |
| Logging                   | Quota analytics and reset failures were logged without their error                                                                                                                                                                                                                                                                                                   | `a11be31e2`                                     |
| Combos                    | Partial explicit scoring weights that summed to 1 skipped normalization (missing factors could produce NaN scores)                                                                                                                                                                                                                                                   | `1a340e622`                                     |
| API                       | `PUT /api/settings/cache-config` and `POST /api/settings/models-dev` returned no response (500) for invalid bodies instead of 400                                                                                                                                                                                                                                    | `af31ed499`                                     |
| Dashboard                 | Provider param-filter section: failed load stuck on the skeleton, no save/reset toasts, unrelated toasts discarded the draft                                                                                                                                                                                                                                         | `34b68beaf`                                     |
| Dashboard                 | Traffic inspector merged view of streamed responses was always empty                                                                                                                                                                                                                                                                                                 | `04afa6fef`                                     |
| Dashboard                 | Custom hosts dialog showed no validation message for an invalid host                                                                                                                                                                                                                                                                                                 | `6121c757e`                                     |
| Dashboard                 | Runtime page crashed (`nodeMap is not defined`) whenever a quota monitor with a provider was shown                                                                                                                                                                                                                                                                   | `f89c2470e`                                     |
| Dashboard                 | Badge dropped the `title` tooltip (memory type explanations never shown)                                                                                                                                                                                                                                                                                             | `1a3c2a201`                                     |
| Dashboard                 | Compatible providers' model param-filter editor requested `/api/providers/undefined/param-filters`                                                                                                                                                                                                                                                                   | `cedc3ea0a`                                     |
| API                       | `/v1/messages/count_tokens` called the provider with no key when every connection was expired (now answers the local estimate)                                                                                                                                                                                                                                       | `f0397c60e`                                     |

### Findings recorded but not changed

- `search/providers` reports a fully expired pool as `"configured"`; the status contract only allows
  `configured | missing | rate_limited` and the dashboard consumes it, so fixing it needs a contract
  decision (new value or mapping to `missing`).
- `useOpenExternal` in the Electron renderer ignores a privileged-IPC denial (link has no effect in
  remote mode); depends on the window-open policy.
- `scripts/check/check-api-typecheck.mjs` and `check-dashboard-typecheck.mjs` fail on Windows with
  `spawn EINVAL` (they spawn `npx.cmd` without a shell); baselines were ratcheted with the gate's own
  parser instead.
- `tests/unit/cli-tray.test.ts` reads the Windows registry and Startup folder, which home-directory
  variables cannot isolate.

## Environment notes (Windows host)

Some suites fail on this Windows host for reasons unrelated to the branch; each was reproduced
unchanged on the `v3.8.53` tree. Linux CI is the reference for these:

- EPERM when removing a temp dir while SQLite still holds the file;
- the libuv handle-closing assertion (`src\winsync.c`) at process exit;
- inode reuse checks that rely on POSIX rename semantics.

Tests that isolate the home directory now set `USERPROFILE` as well as `HOME`
(`tests/helpers/tempHome.ts`), so they no longer read or write the real home directory on Windows.

## Next steps

1. Phase 2 — test suite organization: explicit opt-in for live tests (today some integration files
   send real traffic whenever `OMNIROUTE_API_KEY` is exported), `npm test` running the serialized
   suite, and a layer matrix (command, duration, network, secrets, runs on PR).
2. Phase 3 — a shared routing contract: a new `routing.ts` module next to the existing
   `src/shared/contracts/quota.ts`, with pure adapters from the existing scorer, combo trace and
   strategy types, without changing the live request path.
3. Phases 4 to 12 in sequence, each in its own pull request against `release/v3.8.54`.
