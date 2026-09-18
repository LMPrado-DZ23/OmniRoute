/**
 * Pure rules behind scripts/check/check-api-governance.mjs.
 *
 * Existence reason: every HTTP operation OmniRoute serves must carry governance
 * metadata in docs/openapi.yaml (stability class, owner, since-version, rate-limit
 * mechanism, contract test, sunset date) and every route must be documented and
 * referenced by at least one test. Policy: docs/architecture/API_GOVERNANCE.md.
 *
 * Everything here is side-effect free so tests/unit/check-api-governance.test.ts can
 * drive it with in-memory fixtures; the CLI wrapper does the filesystem work.
 */

export const STABILITY_CLASSES = ["stable", "experimental", "internal", "deprecated"];
export const RATE_LIMIT_MECHANISMS = ["api-key-policy", "none"];
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"];

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIVILEGED_TIER_KEYS = ["x-loopback-only", "x-always-protected", "x-internal"];
// A route that runs enforceApiKeyPolicy() — directly, or through the shared chat
// handler (src/sse/handlers/chat.ts) — is subject to per-API-key rate limits.
const API_KEY_POLICY_RE = /\benforceApiKeyPolicy\b|\bhandleChat\b/;

/** "3.8.53" → [3, 8, 53]; null when not plain semver. */
export function parseSemver(version) {
  const m = SEMVER_RE.exec(String(version ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b (both must be semver). */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Flatten `paths` into one entry per documented operation. */
export function listOperations(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec?.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op && typeof op === "object")
        out.push({ method, path, op, key: operationKey(method, path) });
    }
  }
  return out;
}

/** Canonical operation identity used by baselines and the use-case catalog. */
export function operationKey(method, path) {
  return `${String(method).toUpperCase()} ${path}`;
}

/** HTTP handlers a route.ts exports (same export forms tests/unit/openapi-coverage.test.ts reads). */
export function exportedMethods(source) {
  return HTTP_METHODS.filter((method) => {
    const name = method.toUpperCase();
    return (
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(source) ||
      new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`).test(source) ||
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)
    );
  });
}

/** The rate-limit mechanism a route's own source proves it runs. */
export function deriveRateLimit(source) {
  return API_KEY_POLICY_RE.test(source) ? "api-key-policy" : "none";
}

/** True when an `example` or `examples` key appears anywhere inside the operation. */
export function hasExample(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasExample);
  for (const [key, value] of Object.entries(node)) {
    if (key === "example" || key === "examples") return true;
    if (hasExample(value)) return true;
  }
  return false;
}

/** Owner handles (`@user`, `@org/team`) declared in a CODEOWNERS file. */
export function parseCodeowners(text) {
  const owners = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    for (const token of trimmed.split(/\s+/).slice(1)) {
      if (token.startsWith("@")) owners.add(token);
    }
  }
  return owners;
}

/** A test file "references" an operation when it names its path, with or without `/api`. */
export function testReferencesPath(testSource, path) {
  const text = String(testSource ?? "");
  return text.includes(path) || (path.startsWith("/api/") && text.includes(path.slice(4)));
}

function checkIdentity(op, ctx) {
  const errors = [];
  if (!STABILITY_CLASSES.includes(op["x-stability"])) {
    errors.push(`x-stability must be one of ${STABILITY_CLASSES.join("|")}`);
  }
  if (typeof op["x-owner"] !== "string" || !ctx.owners.has(op["x-owner"])) {
    errors.push(`x-owner must be a handle declared in .github/CODEOWNERS`);
  }
  const since = op["x-since"];
  if (!parseSemver(since)) errors.push(`x-since must be a plain semver release`);
  else if (ctx.currentVersion && compareSemver(since, ctx.currentVersion) > 0) {
    errors.push(`x-since ${since} is newer than package.json ${ctx.currentVersion}`);
  }
  if (!RATE_LIMIT_MECHANISMS.includes(op["x-rate-limit"])) {
    errors.push(`x-rate-limit must be one of ${RATE_LIMIT_MECHANISMS.join("|")}`);
  }
  return errors;
}

function checkRateLimitTruth(entry, ctx) {
  const source = ctx.routeSourceFor(entry.path);
  if (source === null) return [];
  const derived = deriveRateLimit(source);
  const declared = entry.op["x-rate-limit"];
  if (!RATE_LIMIT_MECHANISMS.includes(declared) || declared === derived) return [];
  return [`x-rate-limit is "${declared}" but the route source implies "${derived}"`];
}

function checkContractTest(entry, ctx) {
  const testPath = entry.op["x-contract-test"];
  if (testPath === undefined) {
    return entry.op["x-stability"] === "stable" ? ["stable operation needs x-contract-test"] : [];
  }
  const source = typeof testPath === "string" ? ctx.readRepoFile(testPath) : null;
  if (source === null) return [`x-contract-test ${String(testPath)} does not exist`];
  if (!testReferencesPath(source, entry.path)) {
    return [`x-contract-test ${testPath} never references ${entry.path}`];
  }
  return [];
}

function checkStableRequirements(op) {
  if (op["x-stability"] !== "stable") return [];
  const errors = [];
  if (!hasExample(op)) errors.push("stable operation needs a request or response example");
  if (!Array.isArray(op.security) || op.security.length === 0) {
    errors.push("stable operation needs a non-empty security declaration");
  }
  return errors;
}

function checkDeprecation(op) {
  const errors = [];
  const isDeprecatedClass = op["x-stability"] === "deprecated";
  if (isDeprecatedClass !== (op.deprecated === true)) {
    errors.push("deprecated: true and x-stability: deprecated must be set together");
  }
  const sunset = op["x-sunset"];
  if (isDeprecatedClass && !(typeof sunset === "string" && ISO_DATE_RE.test(sunset))) {
    errors.push("deprecated operation needs x-sunset (YYYY-MM-DD)");
  }
  if (!isDeprecatedClass && sunset !== undefined) {
    errors.push("x-sunset is only allowed on deprecated operations");
  }
  return errors;
}

function checkTierConsistency(op) {
  const privileged = PRIVILEGED_TIER_KEYS.filter((key) => op[key] === true);
  if (privileged.length === 0) return [];
  if (op["x-stability"] === "internal" || op["x-stability"] === "deprecated") return [];
  return [`${privileged.join(", ")} operation must be internal or deprecated`];
}

/**
 * Governance violations of one documented operation.
 * ctx: { owners: Set<string>, currentVersion: string, readRepoFile(rel): string|null,
 *        routeSourceFor(path): string|null }
 */
export function checkOperation(entry, ctx) {
  const op = entry.op;
  const errors = [
    ...checkIdentity(op, ctx),
    ...checkRateLimitTruth(entry, ctx),
    ...checkContractTest(entry, ctx),
    ...checkStableRequirements(op),
    ...checkDeprecation(op),
    ...checkTierConsistency(op),
  ];
  return errors.map((message) => `${entry.key}: ${message}`);
}

/**
 * Route inventory vs spec.
 * routes: Array<{ url: string, source: string }>
 * Returns undocumented routes/methods (always violations) and phantom operations
 * (documented verbs the route does not export — ratcheted by the caller).
 */
export function checkRouteCoverage(routes, spec) {
  const paths = spec?.paths ?? {};
  const undocumented = [];
  const phantom = [];
  for (const route of routes) {
    const item = paths[route.url];
    if (!item) {
      undocumented.push(`${route.url}: route has no documented path`);
      continue;
    }
    const exported = exportedMethods(route.source);
    for (const method of exported) {
      if (!item[method])
        undocumented.push(`${operationKey(method, route.url)}: exported handler is undocumented`);
    }
    for (const method of HTTP_METHODS) {
      if (item[method] && !exported.includes(method)) phantom.push(operationKey(method, route.url));
    }
  }
  return { undocumented, phantom };
}

/** Normalized `app/api/.../route` import token for a route URL's source file. */
export function routeImportToken(routeFileRel) {
  return String(routeFileRel)
    .replace(/\\/g, "/")
    .replace(/^.*?src\/app\/api\//, "app/api/")
    .replace(/\/route\.tsx?$/, "/route");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Routes no test references — neither by importing their route module nor, for
 * parameter-free routes, by quoting their URL.
 * routes: Array<{ url: string, file: string }>
 */
export function findUntestedRoutes(routes, testCorpus) {
  const corpus = String(testCorpus ?? "");
  return routes
    .filter((route) => {
      if (corpus.includes(routeImportToken(route.file))) return false;
      if (route.url.includes("{")) return true;
      return !new RegExp(`["'\`]${escapeRegex(route.url)}(?:[?"'\`/]|$)`).test(corpus);
    })
    .map((route) => route.url)
    .sort();
}

const USE_CASE_ROW_RE = /^\|\s*(\d+)\s*\|[^|]*\|\s*`([A-Z]+) (\/[^`\s]+)`\s*\|\s*`([a-z]+)`\s*\|/;

/** Rows of the use-case catalog table: `| n | title | \`METHOD /path\` | \`stability\` |`. */
export function parseUseCases(markdown) {
  const cases = [];
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const m = USE_CASE_ROW_RE.exec(line);
    if (m) cases.push({ index: Number(m[1]), key: `${m[2]} ${m[3]}`, stability: m[4] });
  }
  return cases;
}

/** Every catalog row must name a documented operation with the same stability class. */
export function checkUseCases(cases, spec, minimum = 10) {
  const byKey = new Map(listOperations(spec).map((entry) => [entry.key, entry.op]));
  const errors = [];
  const distinct = new Set(cases.map((c) => c.key));
  if (distinct.size < minimum) {
    errors.push(`use-case catalog lists ${distinct.size} distinct operations, needs >= ${minimum}`);
  }
  for (const useCase of cases) {
    const op = byKey.get(useCase.key);
    if (!op) {
      errors.push(`use case ${useCase.index}: ${useCase.key} is not a documented operation`);
    } else if (op["x-stability"] !== useCase.stability) {
      errors.push(
        `use case ${useCase.index}: ${useCase.key} is "${op["x-stability"]}" in the spec, catalog says "${useCase.stability}"`
      );
    }
  }
  return errors;
}

/**
 * Ratchet: `found` entries outside `frozen` are new violations; `frozen` entries no
 * longer found are stale (debt paid — the baseline entry must be deleted).
 */
export function applyBaseline(found, frozen) {
  const foundSet = new Set(found);
  const frozenSet = new Set(frozen ?? []);
  return {
    fresh: [...foundSet].filter((entry) => !frozenSet.has(entry)).sort(),
    stale: [...frozenSet].filter((entry) => !foundSet.has(entry)).sort(),
  };
}

/** Operation counts per stability class (unknown values grouped as "invalid"). */
export function summarizeStability(spec) {
  const counts = Object.fromEntries(STABILITY_CLASSES.map((c) => [c, 0]));
  counts.invalid = 0;
  for (const { op } of listOperations(spec)) {
    const cls = STABILITY_CLASSES.includes(op["x-stability"]) ? op["x-stability"] : "invalid";
    counts[cls] += 1;
  }
  return counts;
}
