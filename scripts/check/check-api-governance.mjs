#!/usr/bin/env node
/**
 * API governance gate — no route or operation without governance metadata, docs and a test.
 *
 * Enforces the policy in docs/architecture/API_GOVERNANCE.md against the real route tree
 * (same walk as check:api-docs-refs, via lib/apiRoutes.mjs) and docs/openapi.yaml:
 *   1. every src/app/api route is a documented path, and every exported handler verb is a
 *      documented operation;
 *   2. every operation carries x-stability / x-owner (CODEOWNERS handle) / x-since /
 *      x-rate-limit, and x-rate-limit matches what the route source actually runs;
 *   3. stable ⇒ x-contract-test that exists and references the path, an example, security;
 *   4. deprecated ⇔ `deprecated: true`, and needs x-sunset;
 *   5. x-loopback-only / x-always-protected / x-internal ⇒ internal (or deprecated);
 *   6. docs/reference/API_USE_CASES.md lists >= 10 documented operations with matching stability;
 *   7. every route is referenced by at least one test under tests/ (ratchet).
 *
 * Ratchet (config/quality/api-governance-baseline.json): routes with no test reference and
 * "phantom" operations (documented verbs the route does not export) that pre-date the gate
 * are frozen. A new entry fails; an entry that no longer applies fails as stale so the debt
 * can only shrink. Everything else is a hard rule with no allowlist.
 *
 * Usage: node scripts/check/check-api-governance.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { apiRoot, toApiUrlPath } from "./lib/apiRoutes.mjs";
import {
  applyBaseline,
  checkOperation,
  checkRouteCoverage,
  checkUseCases,
  findUntestedRoutes,
  listOperations,
  parseCodeowners,
  parseUseCases,
  summarizeStability,
} from "./lib/apiGovernance.mjs";

export const SPEC_REL = "docs/openapi.yaml";
export const USE_CASES_REL = "docs/reference/API_USE_CASES.md";
export const BASELINE_REL = "config/quality/api-governance-baseline.json";
const CODEOWNERS_REL = ".github/CODEOWNERS";
const TEST_ROOT_REL = "tests";
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

function readText(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : null;
}

// `skip` only applies to the tests/ walk: under src/app/api a directory named like a build
// artifact (e.g. /api/agent-skills/coverage) is a real route segment.
function walkFiles(dir, accept, skip = new Set(), out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, accept, skip, out);
    else if (entry.isFile() && accept(entry.name)) out.push(full);
  }
  return out;
}

/** Route inventory: URL template, repo-relative file, and source text. */
function collectRoutes(root) {
  const api = apiRoot(root);
  return walkFiles(api, (name) => /^route\.tsx?$/.test(name)).map((abs) => ({
    url: toApiUrlPath(path.dirname(abs), api),
    file: path.relative(root, abs).split(path.sep).join("/"),
    source: fs.readFileSync(abs, "utf8"),
  }));
}

function loadBaseline(root) {
  const text = readText(root, BASELINE_REL);
  if (text === null) return { untestedRoutes: [], phantomOperations: [] };
  const json = JSON.parse(text);
  return {
    untestedRoutes: Array.isArray(json.untestedRoutes) ? json.untestedRoutes : [],
    phantomOperations: Array.isArray(json.phantomOperations) ? json.phantomOperations : [],
  };
}

function ratchetMessages(found, frozen, label) {
  const { fresh, stale } = applyBaseline(found, frozen);
  return [
    ...fresh.map((entry) => `${entry}: ${label} (not in ${BASELINE_REL})`),
    ...stale.map(
      (entry) => `${entry}: stale ${BASELINE_REL} entry — delete it (${label} resolved)`
    ),
  ];
}

/** Run every rule against a repo checkout. Pure w.r.t. the filesystem it reads. */
export function runApiGovernanceCheck(root = process.cwd()) {
  const specText = readText(root, SPEC_REL);
  if (specText === null) return { violations: [`${SPEC_REL} not found`], summary: null };
  const spec = yaml.load(specText);
  const routes = collectRoutes(root);
  const routeByUrl = new Map(routes.map((route) => [route.url, route]));
  const pkg = JSON.parse(readText(root, "package.json") ?? "{}");
  const ctx = {
    owners: parseCodeowners(readText(root, CODEOWNERS_REL)),
    currentVersion: typeof pkg.version === "string" ? pkg.version.replace(/[-+].*$/, "") : "",
    readRepoFile: (rel) => readText(root, rel),
    routeSourceFor: (url) => routeByUrl.get(url)?.source ?? null,
  };

  const operations = listOperations(spec);
  const coverage = checkRouteCoverage(routes, spec);
  const testFiles = walkFiles(
    path.join(root, TEST_ROOT_REL),
    (name) => TEST_FILE_RE.test(name),
    SKIP_DIRS
  );
  const corpus = testFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const untested = findUntestedRoutes(routes, corpus);
  const baseline = loadBaseline(root);

  const violations = [
    ...coverage.undocumented,
    ...operations.flatMap((entry) => checkOperation(entry, ctx)),
    ...checkUseCases(parseUseCases(readText(root, USE_CASES_REL)), spec),
    ...ratchetMessages(untested, baseline.untestedRoutes, "route has no test reference"),
    ...ratchetMessages(
      coverage.phantom,
      baseline.phantomOperations,
      "documented verb is not exported"
    ),
  ];
  const summary = {
    routes: routes.length,
    operations: operations.length,
    stability: summarizeStability(spec),
    untestedRoutes: untested.length,
    phantomOperations: coverage.phantom.length,
  };
  return { violations, summary };
}

function main() {
  const { violations, summary } = runApiGovernanceCheck();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ violations, summary }, null, 2));
  } else if (violations.length === 0) {
    const s = summary.stability;
    console.log(
      `[api-governance] PASS — ${summary.routes} routes, ${summary.operations} operations ` +
        `(stable ${s.stable}, experimental ${s.experimental}, internal ${s.internal}, deprecated ${s.deprecated}); ` +
        `frozen debt: ${summary.untestedRoutes} untested routes, ${summary.phantomOperations} phantom operations`
    );
  } else {
    console.error(`[api-governance] FAIL — ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error("Policy: docs/architecture/API_GOVERNANCE.md");
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
