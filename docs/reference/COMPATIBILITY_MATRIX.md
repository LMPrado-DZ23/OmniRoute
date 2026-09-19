---
title: "Compatibility Matrix"
version: 3.8.54
lastUpdated: 2026-09-14
---

# Compatibility Matrix

🌐 **Languages:** 🇺🇸 English · 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/reference/COMPATIBILITY_MATRIX.md)

> **Read this first.** Every row states **how** we know it. A row is only "tested in CI" when a workflow in `.github/workflows/` runs it; anything else is declared or unverified. When a workflow changes, this page must change with it.

## Legend

| Status               | Meaning                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **Tested (per PR)**  | Runs in `ci.yml` / `quality.yml` on pull requests and pushes.                                           |
| **Tested (nightly)** | Runs on a schedule (`nightly-*.yml`) against the active release branch, not on every PR.                |
| **Built at release** | Built (and in some cases smoke-tested) by a release/publish workflow; not exercised by the test suites. |
| **Best-effort**      | Runs in CI with `continue-on-error`, so a failure does not block.                                       |
| **Declared**         | Allowed by `package.json` `engines`, runtime checks or docs, but no workflow runs it.                   |
| **Not supported**    | Rejected by the runtime check or explicitly out of scope.                                               |

---

## Node.js and other runtimes

Declared range (`package.json` `engines`): `>=22.22.2 <23 || >=24.0.0 <27`. The same range and the secure minimum per major line (22.22.2, 24.0.0, 25.0.0, 26.0.0) are enforced by `bin/nodeRuntimeSupport.mjs`; `npm run check:node-runtime` (`scripts/check/check-supported-node-runtime.ts`) exits non-zero outside it. Recommended version in that file: `24.14.1`.

| Runtime                      | Status                                             | Evidence                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24.x                 | **Tested (per PR)**                                | `ci.yml` sets CI_NODE_VERSION to `"24"` for build, unit shards and E2E shards; `build.yml`, `api-route-typecheck.yml` and `dast-smoke.yml` use `node-version: "24"`; `electron-release.yml` builds with Node 24.                                                                                                     |
| Node.js 26.x                 | **Tested (nightly)**                               | `nightly-compat.yml`: `compat-tests` runs the unit suite (4 shards) on Node 24 and 26 plus `npm run check:node-runtime`; `compat-build-26` runs `npm run build` on Node 26 with `OMNIROUTE_USE_TURBOPACK=0` (webpack fallback). The Docker runtime base image is Node 26 (`Dockerfile`, `FROM node:26-trixie-slim`). |
| Node.js 25.x                 | **Declared**                                       | Inside the `engines` range and listed in `bin/nodeRuntimeSupport.mjs`; no workflow uses Node 25.                                                                                                                                                                                                                     |
| Node.js 22.x (>= 22.22.2)    | **Declared**                                       | Inside the `engines` range; no workflow in `.github/workflows/` sets Node 22.                                                                                                                                                                                                                                        |
| Node.js 23.x, <= 21.x, >= 27 | **Not supported**                                  | Outside the `engines` range; rejected by `check:node-runtime`.                                                                                                                                                                                                                                                       |
| Bun (SQLite path)            | **Tested (per PR)** Linux, **Best-effort** Windows | `ci.yml` job `test-bun-sqlite` runs on `ubuntu-latest` and `windows-latest`, with `continue-on-error` for Windows. `bin/nodeRuntimeSupport.mjs` reports Bun 1.1 or newer as supported.                                                                                                                               |

## Operating systems

| OS                   | Status                        | Evidence                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (x64)          | **Tested (per PR)**           | Test, build and E2E jobs in `ci.yml` run on `ubuntu-latest` (or the self-hosted Linux build runner when enabled).                                                                                                                                                      |
| Windows (x64)        | **Tested (per PR)**, partial  | `ci.yml` `electron-package-smoke` runs on `windows-latest` (bundle preparation incl. the `better-sqlite3` prebuild check; the full pack and headless smoke run on Ubuntu). `test-bun-sqlite` on Windows is best-effort. The unit and E2E suites do not run on Windows. |
| macOS (Intel, arm64) | **Built at release**          | Only `electron-release.yml` uses macOS runners (`macos-15-intel`, `macos-latest`). The arm64 smoke is `continue-on-error`. No per-PR macOS job.                                                                                                                        |
| Linux arm64          | **Built at release** (Docker) | `docker-publish.yml` builds `linux/arm64` images on `ubuntu-24.04-arm`. No test suite runs on arm64.                                                                                                                                                                   |
| Android (Termux)     | **Declared**                  | Documented in [TERMUX_GUIDE.md](../guides/TERMUX_GUIDE.md); no workflow.                                                                                                                                                                                               |

## Install methods

| Method                                          | Status                             | Evidence / notes                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source (`npm ci && npm run build`)              | **Tested (per PR)**                | `ci.yml` build job on Node 24.                                                                                                                                                                                                                                                                                                      |
| Docker image (`ghcr.io/lmprado-dz23/omniroute`) | **Built at release**, boot-checked | `docker-publish.yml` builds and pushes the image, then starts it and requires `http://127.0.0.1:20128/healthz` to answer before leaving the tag published.                                                                                                                                                                          |
| Electron desktop app                            | **Built at release**               | `electron-release.yml` builds Windows, macOS (Intel and arm64) and Linux; smoke on Windows and macOS arm64 is best-effort. [QUICK-START.md](../getting-started/QUICK-START.md) notes installers are not published on this fork's Releases yet.                                                                                      |
| npm global (`npm install -g omniroute`)         | **Declared / not this fork**       | The npm package name `omniroute` is shared with upstream and, per [QUICK-START.md](../getting-started/QUICK-START.md), installs the upstream project. `npm-publish.yml` exists in this repository; `omniroute update --apply` only trusts the registry when the manifest points at this repository (`bin/cli/commands/update.mjs`). |
| pnpm, AUR, Void template, Podman                | **Declared**                       | Documented in [SETUP_GUIDE.md](../guides/SETUP_GUIDE.md) and `contrib/`; no workflow.                                                                                                                                                                                                                                               |

## Docker images and architectures

Source: `.github/workflows/docker-publish.yml` and `scripts/ci/resolve-docker-publish-version.sh`.

| Variant (tag suffix) | Dockerfile / target                   | Architectures                | Status                                                        |
| -------------------- | ------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| _(none)_             | `Dockerfile`                          | `linux/amd64`, `linux/arm64` | **Built at release**, boot-checked on `/healthz`              |
| `-web`               | `Dockerfile`, target `runner-web`     | `linux/amd64`, `linux/arm64` | **Built at release**                                          |
| `-bun`               | `Dockerfile.bun`                      | `linux/amd64`, `linux/arm64` | **Built at release**, optional (publish continues without it) |
| `-web-bun`           | `Dockerfile.bun`, target `runner-web` | `linux/amd64`, `linux/arm64` | **Built at release**, optional                                |

Channels (the tag before the suffix):

| Tag      | Produced when                                                           | Mutable |
| -------- | ----------------------------------------------------------------------- | ------- |
| `X.Y.Z`  | A `v*` tag push, a GitHub release, or a manual dispatch with a version  | No      |
| `latest` | Promoted only for a stable SemVer (pre-release identifiers are skipped) | Yes     |
| `next`   | Push to the repository's current default `release/v*` branch            | Yes     |
| `main`   | Push to `main`                                                          | Yes     |

Pushes to a `release/v*` branch that is not the default branch publish nothing. More detail: [DOCKER_GUIDE.md](../guides/DOCKER_GUIDE.md#release-channels).

## Client protocols and endpoints

Every endpoint below has a route handler under `src/app/api/`. `/v1/*` and `/v1beta/*` are rewritten to `/api/v1/*` and `/api/v1beta/*` by `next.config.mjs`. The two test columns come from a string search for the path under `tests/` and `tests/e2e/`: they show the path is **referenced** by tests, not that every feature of the protocol is covered.

| Protocol / client format             | Endpoint(s)                                                                                               | Route location                             | Referenced in `tests/` | Referenced in `tests/e2e/` |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------- | -------------------------- |
| OpenAI Chat Completions              | `POST /v1/chat/completions`                                                                               | `src/app/api/v1/chat/completions/route.ts` | Yes                    | Yes                        |
| OpenAI Responses                     | `POST /v1/responses` (+ sub-paths)                                                                        | `src/app/api/v1/responses/route.ts`        | Yes                    | Yes                        |
| Anthropic Messages                   | `POST /v1/messages`, `POST /v1/messages/count_tokens`                                                     | `src/app/api/v1/messages/route.ts`         | Yes                    | Yes                        |
| Model listing (OpenAI format)        | `GET /v1/models`                                                                                          | `src/app/api/v1/models/route.ts`           | Yes                    | Yes                        |
| Google Gemini (`v1beta`)             | `/v1beta/models/...`                                                                                      | `src/app/api/v1beta/models/`               | Yes                    | No                         |
| OpenAI legacy Completions            | `POST /v1/completions`                                                                                    | `src/app/api/v1/completions/route.ts`      | Yes                    | No                         |
| Embeddings                           | `POST /v1/embeddings`                                                                                     | `src/app/api/v1/embeddings/route.ts`       | Yes                    | No                         |
| WebSocket bridge                     | `/v1/ws`                                                                                                  | `src/app/api/v1/ws/route.ts`               | Yes                    | No                         |
| Ollama-style chat                    | `POST /v1/api/chat`                                                                                       | `src/app/api/v1/api/chat/route.ts`         | not checked            | not checked                |
| Images / audio / moderation / rerank | `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/moderations`, `/v1/rerank` | `src/app/api/v1/`                          | not checked            | not checked                |
| MCP (Model Context Protocol)         | SSE transport under `/api/mcp/sse`; stdio via `bin/mcp-server.mjs`                                        | `src/app/api/mcp/`                         | Yes (`api/mcp`)        | Yes (`api/mcp`)            |
| A2A (Agent-to-Agent, JSON-RPC)       | `POST /a2a`                                                                                               | `src/app/a2a/route.ts`                     | No match for `/a2a`    | No                         |

Protocol details: [API_REFERENCE.md](API_REFERENCE.md), [openapi.yaml](../openapi.yaml), [MCP-SERVER.md](../frameworks/MCP-SERVER.md), [A2A-SERVER.md](../frameworks/A2A-SERVER.md). Provider-side coverage (which upstreams exist) is in [PROVIDER_REFERENCE.md](PROVIDER_REFERENCE.md).

---

## Reporting a compatibility problem

Open a **Compatibility Problem** issue (`.github/ISSUE_TEMPLATE/compatibility.yml`) with the exact runtime, OS/architecture, install method and command. Rows marked **Declared** are the most useful to confirm or refute.
