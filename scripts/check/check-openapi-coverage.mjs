#!/usr/bin/env node
/**
 * Validates that docs/openapi.yaml documents every implemented route.
 * Internal routes are documented too, tagged `x-stability: internal` (and
 * `x-internal` / `x-loopback-only` where applicable) — documented is not the same
 * as public. Per-operation governance rules live in check-api-governance.mjs.
 *
 * Fails if coverage < 100%.
 */

import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { apiRoot, collectApiRouteUrlPaths } from "./lib/apiRoutes.mjs";

const ROOT = process.cwd();
const API_ROOT = apiRoot(ROOT);
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");
// History: a "no regressions" floor (36, then 30 in the 2026-08-30 velocity phase) while
// the backlog tracked by #2701 was undocumented. The 2026-08-31 docs audit documented the
// backlog (704/709) and the 2026-09-14 API-governance change documented the last five
// routes, so the gate now enforces the absolute target: no new route without docs.
const THRESHOLD = 100;

if (!fs.existsSync(API_ROOT)) {
  console.error(`[openapi-coverage] FAIL — API root not found: ${API_ROOT}`);
  process.exit(1);
}

if (!fs.existsSync(OPENAPI_PATH)) {
  console.error(`[openapi-coverage] FAIL — openapi.yaml not found: ${OPENAPI_PATH}`);
  process.exit(1);
}

const implementedPaths = collectApiRouteUrlPaths(ROOT).sort((a, b) => a.localeCompare(b));
const raw = yaml.load(fs.readFileSync(OPENAPI_PATH, "utf-8"));
const documentedPaths = new Set(Object.keys(raw.paths || {}));

let covered = 0;
const missing = [];

for (const p of implementedPaths) {
  if (documentedPaths.has(p)) {
    covered++;
  } else {
    missing.push(p);
  }
}

const total = implementedPaths.length;
const coverage = (covered / total) * 100;

if (coverage >= THRESHOLD) {
  console.log(
    `[openapi-coverage] PASS — ${coverage.toFixed(1)}% (${covered}/${total} routes documented)`
  );
  process.exit(0);
} else {
  console.error(`[openapi-coverage] FAIL — coverage ${coverage.toFixed(1)}% < ${THRESHOLD}%`);
  console.error(`Missing routes (${missing.length}):`);
  missing.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}
