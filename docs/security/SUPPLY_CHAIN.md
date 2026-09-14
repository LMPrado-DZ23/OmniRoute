---
title: "Supply-Chain Gates"
---

# Supply-Chain Gates (Phase 8 · Block A)

OmniRoute publishes npm + Docker artifacts. These gates provide provenance,
inventory (SBOM) and CVE scanning, all OSS, plugged into release workflows.
**Advisory-first** posture — they report now, promote to blocking after the 1st
green release.

| Gate                  | Tool                                           | Where                         | Blocks?                  | Output                                        |
| --------------------- | ---------------------------------------------- | ----------------------------- | ------------------------ | --------------------------------------------- |
| SLSA provenance (npm) | `npm --provenance` (OIDC)                      | `npm-publish.yml`             | only if publish fails    | badge npmjs / `npm audit signatures`          |
| SBOM npm              | `@cyclonedx/cyclonedx-npm`                     | `npm-publish.yml`             | only if generation fails | Release asset + artifact                      |
| SBOM image            | `anchore/sbom-action` (syft)                   | `docker-publish.yml` (merge)  | advisory                 | CycloneDX artifact                            |
| Trivy CVE (SARIF)     | `aquasecurity/trivy-action`                    | `docker-publish.yml` (merge)  | advisory                 | SARIF (HIGH+CRITICAL) → Security tab          |
| Trivy CRITICAL gate   | `aquasecurity/trivy-action`                    | `docker-publish.yml` (merge)  | **blocking**             | `exit-code: '1'` on fixable CRITICAL          |
| osv vulnCount         | `osv-scanner` (`check:vuln-ratchet --ratchet`) | `ci.yml` (`quality-extended`) | **blocking**             | ratchets `metrics.vulnCount` (direction:down) |
| OpenSSF Scorecard     | `ossf/scorecard-action`                        | `scorecard.yml` (cron)        | advisory                 | SARIF → Security + badge                      |

The image CVE ratchet uses **two steps** in `docker-publish.yml`: the SARIF step
(`HIGH,CRITICAL`, `exit-code: 0`) keeps HIGH+CRITICAL visible in the Security tab
without blocking; the _CRITICAL gate_ step (`severity: CRITICAL`, `ignore-unfixed: true`,
`exit-code: 1`) fails the release on a CRITICAL CVE **with a fix available**. `ignore-unfixed`
prevents blocking the release for a base-image CVE without an upstream patch.

## ⚠️ CVE Variance (blocking osv/Trivy gates)

osv and Trivy compare deps against CVE databases that **continuously grow**. A PR
that **touches no dependencies** can suddenly turn red because a new CVE was
disclosed in an existing dep (osv: measured `vulnCount` > baseline; Trivy: a new
fixable CRITICAL in the image). **This is EXPECTED operational behavior of a blocking
CVE gate, not a product regression.**

When osv or Trivy go red due to a newly disclosed CVE, the remedy is:

1. **Bump the affected dep** (preferred) — upgrade to the patched version via `package.json`
   `overrides` (transitive deps) or rebuild the image on a patched base.
2. **If there is no upstream fix:**
   - **osv:** re-baseline `metrics.vulnCount` in `config/quality/quality-baseline.json`
     (`npm run quality:ratchet -- --update` does not cover dedicated gates — edit the value by
     hand, `direction:down`) with a justification note + tracking issue.
   - **Trivy:** add an entry in `.trivyignore` (CVE-ID per line) with a justification
     comment + tracking issue. `ignore-unfixed: true` already covers CVEs without
     patches automatically.

Both gates **gracefully SKIP** (exit 0) when the tool is absent or the measurement
fails (osv-scanner not in PATH, osv.dev/network unreachable, invalid JSON) — a
**measurement** failure never blocks, only a **measured** regression blocks.

## Backlog: Scorecard advisory → blocking

After the 1st green release with Scorecard reporting:

- Scorecard: score ratchet (freezes the measured score; cannot decrease).

Complements the Phase 7 gates (osv-scanner, gitleaks, actionlint+zizmor): zizmor
audits the workflows themselves; Scorecard measures the repo posture in aggregate.

## Phase 10 verification (2026-09-14)

Point-in-time verification of each supply-chain control, run on commit `1a8b612fb`
(Node v24.16.0, npm 11.13.0, Windows host). Each item lists what exists, where it lives, the
command run and its result, and the gaps. Per-advisory dependency findings are in the
[Vulnerability Register](./VULNERABILITY_REGISTER.md).

### Dependency audit (npm)

- **Exists:** `audit:deps` (`package.json` L243) runs `npm audit`. It blocks on critical and
  only warns on high, then chains `audit:electron` (L244). CI runs it at `ci.yml` L104.
- **Ran:**
  - `npm audit --omit=dev --audit-level=high`: exit 0; 0 critical, 0 high, 3 moderate
    (one advisory, R-01).
  - `npm audit`: exit 1; 0 critical, 4 high, 6 moderate, 1 low (9 advisories, all high ones
    dev-only).
  - `npm --prefix electron audit --package-lock-only`: 1 high (`js-yaml` 4.3.1,
    GHSA-2883-xcg3-v3hh; register R-10).
  - The `--package-lock-only` variants of the root runs give identical numbers.
- **Gaps:** dev-tree high advisories only warn, by design. The CI promptfoo job installs a
  global `promptfoo@0.122.0` (`.github/workflows/dast-smoke.yml` L84) that no lockfile audit
  covers.

### Node engine

- **Exists:**
  - `engines.node` is `>=22.22.2 <23 || >=24.0.0 <27` (`package.json` L68–L70).
  - `.nvmrc` and `.node-version` pin `24`.
  - CI uses Node 24 (CI_NODE_VERSION in `ci.yml` L23 and `quality.yml` L21).
  - The image base is `node:26-trixie-slim` (`Dockerfile` L4), inside the range.
- **Ran:** `node -v` → v24.16.0; `npm -v` → 11.13.0.
- **Gaps:** `.npmrc` does not set `engine-strict`, so an unsupported Node gets a warning, not
  a failure. The requirement was not changed.

### Lockfile integrity

- **Exists:** `check:lockfile` (`package.json` L224) → `scripts/check/check-lockfile.mjs`:
  lockfile-lint with `--validate-https --validate-integrity --allowed-hosts npm`, then
  `npm ls --workspaces --depth=0 --package-lock-only`. CI runs it at `ci.yml` L162.
- **Ran:**
  - `npm run check:lockfile` failed (exit 1) on this Windows host with empty lockfile-lint
    output. The script calls `execFileSync` on `node_modules/.bin/lockfile-lint`, a POSIX
    shell shim, which fails with `ENOENT` on win32 (reproduced).
  - The same policy run directly passed:
    `node node_modules/lockfile-lint/bin/lockfile-lint.js --path package-lock.json --type npm --validate-https --validate-integrity --allowed-hosts npm`
    → "No issues detected", exit 0.
  - `npm ls --workspaces --depth=0 --package-lock-only` → exit 0.
- **Gaps:**
  - The gate script cannot run on Windows. Linux CI is unaffected.
  - `pnpm-workspace.yaml` exists without a pnpm lockfile, so a pnpm install is unlocked.
    `package-lock.json` is the only locked install path.

### Native dependencies and install scripts

- **Exists:**
  - Optional native dependencies `better-sqlite3`, `keytar` and `onnxruntime-node`
    (`package.json` L378–L384); `sharp` (L360).
  - The root `postinstall` (L279) runs `scripts/build/postinstall.mjs`. It copies native
    binaries into the standalone `dist/node_modules`, tries a prebuilt `better-sqlite3`
    download through node-pre-gyp (L148–L190), falls back to a rebuild (L202–L216), patches
    node-gyp `common.gypi` for Termux/Android, and warms up native runtimes.
  - `pnpm-workspace.yaml` lists the packages allowed to run build scripts.
  - The image installs with `npm ci --include=optional ... --ignore-scripts` and rebuilds
    only `better-sqlite3` through node-gyp (`Dockerfile` L109–L113).
- **Ran:** static review only. Running an install would modify the shared `node_modules`.
- **Gaps:**
  - Installing the published npm package runs install scripts that reach the network
    (tracked as SC-9).
  - The third-party `onnxruntime-node` install script downloads CUDA provider libraries from
    NuGet on linux/x64 and extracts them with `adm-zip` (register R-01).

### Docker base images

| File                                             | Base image                                   | Pin status                              |
| ------------------------------------------------ | -------------------------------------------- | --------------------------------------- |
| `Dockerfile` L4                                  | `node:26-trixie-slim`                        | tag + digest                            |
| `Dockerfile.bun` L2, L59                         | `oven/bun:1.4.0-slim`                        | tag + digest                            |
| `docker/devin-bridge/Dockerfile` L3              | `node:26.0.0-bookworm-slim`                  | tag + digest (pinned 2026-09-14)        |
| `docker/chatgpt-web-codex-browser/Dockerfile` L3 | `mcr.microsoft.com/playwright:v1.62.0-noble` | tag + digest (pinned 2026-09-14)        |
| `docker/vnc-browser/chromium/Dockerfile` L17     | `linuxserver/chromium:latest`                | moving tag + digest (pinned 2026-09-14) |
| `docker/devin-bridge/compose.yml` L102, L130     | `node:26.0.0-bookworm-slim`                  | tag + digest (pinned 2026-09-14)        |

- **Ran:**
  - `docker buildx imagetools inspect <image>` resolved each multi-arch index digest by
    reading the manifest only (no pull, no container).
  - `tests/unit/workflows-supply-chain-pins.test.ts` now covers every `docker/**/Dockerfile`
    and the devin-bridge compose file: 6/6 pass.
  - Negative check: with the old tag-only `FROM` restored, the image test fails.
- **Gaps:**
  - Dependabot's `docker` entry watches only `directory: "/"` (`.github/dependabot.yml`
    L91–L92), so sidecar digest bumps are manual.
  - `linuxserver/chromium` has no versioned tag in use; refreshing it means resolving a new
    digest on purpose.

### SBOM

- **Exists:**
  - Image CycloneDX via `anchore/sbom-action` (`docker-publish.yml` L554–L562), with
    `continue-on-error: true`; skipped for the `main` build.
  - npm CycloneDX via `npx @cyclonedx/cyclonedx-npm` (`npm-publish.yml` L269–L293), kept as
    a workflow artifact and a release asset.
  - No other workflow produces an SBOM.
- **Ran:** not run locally (release workflows only).
- **Gaps:**
  - The image SBOM step is advisory.
  - `docker-publish.yml` builds only `Dockerfile` and `Dockerfile.bun` (build contexts at
    L221–L291), so the sidecar images have no SBOM.

### Trivy

- **Exists:**
  - An advisory SARIF scan for HIGH and CRITICAL (`docker-publish.yml` L575–L586).
  - A blocking CRITICAL gate with `ignore-unfixed: true` and `exit-code: "1"` (L597–L608).
  - The SARIF upload (L610–L616).
  - `.trivyignore` has no active entries.
- **Ran:** not available locally (`trivy` is not in PATH).
- **Gaps:** only the published image is scanned; the sidecar images are not.

### Gitleaks

- **Exists:**
  - A version-pinned, checksum-verified install (`ci.yml` L364–L370).
  - A blocking ratchet, `npm run check:secrets -- --ratchet` (`ci.yml` L412).
  - `.gitleaks.toml` extends the default ruleset.
- **Ran:** not available locally (`gitleaks` is not in PATH).
- **Gaps:** by design, the gate skips with exit 0 when the binary is absent.

### osv-scanner (vulnCount ratchet)

- **Exists:**
  - A pinned, checksum-verified install (`ci.yml` L371–L376).
  - A blocking ratchet, `npm run check:vuln-ratchet -- --ratchet` (`ci.yml` L420–L421),
    against `metrics.vulnCount` = 27 in `config/quality/quality-baseline.json`.
- **Ran:**
  - `node scripts/check/check-vuln-ratchet.mjs` and `--ratchet` both printed
    `vulnCount=SKIP reason=binary-absent`, exit 0.
  - Approximation through the osv.dev batch API over `package-lock.json`: 9 advisory IDs,
    1 non-dev.
- **Gaps:**
  - 27 is the velocity-phase ceiling (22 → 27 in `_relax_velocity_2026_08_30`), not a
    measurement.
  - The historical seed note quoting 13 is now reconciled in
    `_vuln_baseline_reconcile_2026_09_14_phase10`.
  - The value is not tightened without a CI osv-scanner measurement.

### Semgrep

- **Exists:** `.github/workflows/semgrep.yml` runs on pull requests to `main`/`release/**` and
  on pushes to `main`:
  - container `semgrep/semgrep:1.176.1` pinned by digest (L20)
  - rulesets `p/owasp-top-ten` and `p/secrets`
  - SARIF uploaded as an artifact
- **Ran:** not available locally.
- **Gaps:** advisory only; the scan ends with `|| true` (L28–L29).

### CodeQL

- **Exists:**
  - An advanced workflow (`.github/workflows/codeql.yml`, `security-extended` queries),
    triggered only by `workflow_dispatch` because it conflicts with the repository's default
    setup (L1–L10).
  - The `codeqlAlerts` ratchet reads the default-setup alerts.
- **Ran:** not run.
- **Gaps:** the advanced workflow stays disabled until the owner switches the repository
  setting. That is an external configuration, so it was left unchanged.

### Scorecard

- **Exists:** `.github/workflows/scorecard.yml`, run on a weekly cron (L4–L6) and on push.
- **Ran:** not run.
- **Gaps:** advisory (see the backlog above).

### Dependabot

- **Exists:** `.github/dependabot.yml` covers:
  - npm at `/`, weekly (L3–L4), grouped into production and development. `react`, `next`,
    `eslint`, `typescript`, `jscpd` and `ioredis` majors are ignored. `@huggingface/transformers`,
    `onnxruntime-node` and `eslint-plugin-react-hooks` are frozen completely (L53–L68 for the
    ONNX pair).
  - github-actions (L78)
  - npm at `/electron` (L83–L84)
  - docker at `/` (L91–L92)
- **Ran:** static review.
- **Gaps:**
  - The frozen `@huggingface/transformers` / `onnxruntime-node` pair means the R-01 chain
    never receives grouped version bumps.
  - The docker entry does not cover `docker/*`.

### Licenses

- **Exists:** `check:licenses` (`package.json` L229) → `scripts/check/check-licenses.mjs`. It
  runs license-checker-rseidelsohn `--production --json` against
  `config/quality/.license-allowlist.json`. CI runs it at `ci.yml` L163.
- **Ran:**
  - `npm run check:licenses` failed before scanning: `node_modules/.bin/license-checker-rseidelsohn`
    is missing from the linked `node_modules`.
  - The same checker via its JS entry,
    `node node_modules/license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js --production --json`,
    classified with the script's exported `loadAllowlist` / `classifyLicense`: 120 packages,
    120 allowed, 0 exceptions, 0 violations.
- **Gaps:**
  - The local result reflects the linked `node_modules` of another checkout, not a clean
    `npm ci` tree: 120 packages scanned against 890 production entries counted by npm audit.
    CI is authoritative.
  - On Windows the script would hit the same `.bin` shim problem as `check:lockfile`.
