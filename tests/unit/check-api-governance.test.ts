import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBaseline,
  checkOperation,
  checkRouteCoverage,
  checkUseCases,
  compareSemver,
  deriveRateLimit,
  exportedMethods,
  findUntestedRoutes,
  hasExample,
  listOperations,
  parseCodeowners,
  parseUseCases,
  routeImportToken,
  summarizeStability,
} from "../../scripts/check/lib/apiGovernance.mjs";
import { runApiGovernanceCheck } from "../../scripts/check/check-api-governance.mjs";

// Explicit shapes for the .mjs exports — keeps the test free of implicit any.
type Op = Record<string, unknown>;
type Spec = { paths: Record<string, Record<string, Op>> };
type Entry = { method: string; path: string; op: Op; key: string };
type Ctx = {
  owners: Set<string>;
  currentVersion: string;
  readRepoFile: (rel: string) => string | null;
  routeSourceFor: (url: string) => string | null;
};
type Route = { url: string; file: string; source: string };

const listOps = listOperations as (spec: Spec) => Entry[];
const checkOp = checkOperation as (entry: Entry, ctx: Ctx) => string[];
const coverage = checkRouteCoverage as (
  routes: Route[],
  spec: Spec
) => { undocumented: string[]; phantom: string[] };
const untested = findUntestedRoutes as (routes: Route[], corpus: string) => string[];
const useCases = parseUseCases as (
  md: string
) => Array<{ index: number; key: string; stability: string }>;
const checkCases = checkUseCases as (
  cases: Array<{ index: number; key: string; stability: string }>,
  spec: Spec,
  minimum?: number
) => string[];
const ratchet = applyBaseline as (
  found: string[],
  frozen: string[]
) => { fresh: string[]; stale: string[] };
const run = runApiGovernanceCheck as (root?: string) => {
  violations: string[];
  summary: { routes: number; operations: number; stability: Record<string, number> } | null;
};

const CONTRACT_TEST = "tests/integration/example.contract.test.ts";

function governed(extra: Op = {}): Op {
  return {
    "x-stability": "experimental",
    "x-owner": "@owner",
    "x-since": "3.8.53",
    "x-rate-limit": "none",
    responses: { "200": { description: "OK" } },
    ...extra,
  };
}

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    owners: new Set(["@owner"]),
    currentVersion: "3.8.53",
    readRepoFile: (rel) => (rel === CONTRACT_TEST ? 'await fetch("/v1/chat/completions")' : null),
    routeSourceFor: () => null,
    ...overrides,
  };
}

function violationsFor(path: string, method: string, op: Op, context: Ctx = ctx()): string[] {
  const entry = listOps({ paths: { [path]: { [method]: op } } })[0];
  return checkOp(entry, context);
}

// --- metadata rules ---------------------------------------------------------------------

test("a fully governed experimental operation passes", () => {
  assert.deepEqual(violationsFor("/api/v1/embeddings", "post", governed()), []);
});

test("missing governance extensions are each reported", () => {
  const errors = violationsFor("/api/foo", "get", { responses: {} });
  assert.equal(errors.length, 4);
  assert.ok(errors.every((e) => e.startsWith("GET /api/foo: ")));
  assert.ok(errors.some((e) => e.includes("x-stability")));
  assert.ok(errors.some((e) => e.includes("x-owner")));
  assert.ok(errors.some((e) => e.includes("x-since")));
  assert.ok(errors.some((e) => e.includes("x-rate-limit")));
});

test("an owner that is not in CODEOWNERS fails", () => {
  const errors = violationsFor("/api/foo", "get", governed({ "x-owner": "@stranger" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CODEOWNERS/);
});

test("x-since newer than package.json fails", () => {
  const errors = violationsFor("/api/foo", "get", governed({ "x-since": "3.9.0" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /newer than package\.json/);
});

test("a declared rate limit that the route source contradicts fails", () => {
  const context = ctx({
    routeSourceFor: () => "export async function POST() { return handleChat(); }",
  });
  const errors = violationsFor("/api/v1/chat/completions", "post", governed(), context);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /implies "api-key-policy"/);
});

test("stable needs a contract test, an example and security", () => {
  const errors = violationsFor(
    "/api/v1/chat/completions",
    "post",
    governed({ "x-stability": "stable" })
  );
  assert.ok(errors.some((e) => e.includes("needs x-contract-test")));
  assert.ok(errors.some((e) => e.includes("example")));
  assert.ok(errors.some((e) => e.includes("security")));
});

test("a stable operation with an existing, path-referencing contract test passes", () => {
  const op = governed({
    "x-stability": "stable",
    "x-contract-test": CONTRACT_TEST,
    security: [{ BearerAuth: [] }],
    requestBody: { content: { "application/json": { example: { model: "m" } } } },
  });
  assert.deepEqual(violationsFor("/api/v1/chat/completions", "post", op), []);
});

test("a contract test that does not exist or never names the path fails", () => {
  const missing = violationsFor(
    "/api/v1/models",
    "get",
    governed({ "x-contract-test": "tests/nope.test.ts" })
  );
  assert.match(missing[0], /does not exist/);
  const unrelated = violationsFor(
    "/api/v1/models",
    "get",
    governed({ "x-contract-test": CONTRACT_TEST })
  );
  assert.match(unrelated[0], /never references \/api\/v1\/models/);
});

test("deprecated requires deprecated: true and an ISO x-sunset", () => {
  const errors = violationsFor("/api/old", "put", governed({ "x-stability": "deprecated" }));
  assert.ok(errors.some((e) => e.includes("set together")));
  assert.ok(errors.some((e) => e.includes("x-sunset")));
  const ok = governed({ "x-stability": "deprecated", deprecated: true, "x-sunset": "2026-12-31" });
  assert.deepEqual(violationsFor("/api/old", "put", ok), []);
});

test("x-sunset or deprecated: true on a non-deprecated operation fails", () => {
  const sunsetOnly = violationsFor("/api/foo", "get", governed({ "x-sunset": "2026-12-31" }));
  assert.ok(sunsetOnly.some((e) => e.includes("only allowed on deprecated")));
  const flagOnly = violationsFor("/api/foo", "get", governed({ deprecated: true }));
  assert.ok(flagOnly.some((e) => e.includes("set together")));
});

test("loopback-only / always-protected operations cannot be experimental or stable", () => {
  const errors = violationsFor("/api/mcp/sse", "get", governed({ "x-loopback-only": true }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be internal or deprecated/);
  const internal = governed({ "x-loopback-only": true, "x-stability": "internal" });
  assert.deepEqual(violationsFor("/api/mcp/sse", "get", internal), []);
});

// --- route coverage + tests --------------------------------------------------------------

test("an undocumented route and an undocumented exported verb are violations", () => {
  const spec: Spec = { paths: { "/api/a": { get: governed() } } };
  const routes: Route[] = [
    {
      url: "/api/a",
      file: "src/app/api/a/route.ts",
      source: "export async function GET() {}\nexport const POST = handler;",
    },
    { url: "/api/b", file: "src/app/api/b/route.ts", source: "export async function GET() {}" },
  ];
  const result = coverage(routes, spec);
  assert.deepEqual(result.undocumented, [
    "POST /api/a: exported handler is undocumented",
    "/api/b: route has no documented path",
  ]);
  assert.deepEqual(result.phantom, []);
});

test("a documented verb the route does not export is a phantom operation", () => {
  const spec: Spec = { paths: { "/api/a": { get: governed(), delete: governed() } } };
  const routes: Route[] = [
    { url: "/api/a", file: "src/app/api/a/route.ts", source: "export { GET } from './impl';" },
  ];
  assert.deepEqual(coverage(routes, spec).phantom, ["DELETE /api/a"]);
});

test("routes count as tested via a route-module import or a quoted static URL", () => {
  const routes: Route[] = [
    { url: "/api/a/{id}", file: "src/app/api/a/[id]/route.ts", source: "" },
    { url: "/api/b", file: "src/app/api/b/route.ts", source: "" },
    { url: "/api/c/{id}", file: "src/app/api/c/[id]/route.ts", source: "" },
  ];
  const corpus = 'await import("../../src/app/api/a/[id]/route.ts");\nfetch("/api/b?x=1");';
  assert.deepEqual(untested(routes, corpus), ["/api/c/{id}"]);
  assert.equal(routeImportToken("src\\app\\api\\a\\[id]\\route.tsx"), "app/api/a/[id]/route");
});

test("a URL prefix of a longer path does not count as a test reference", () => {
  const routes: Route[] = [{ url: "/api/b", file: "src/app/api/b/route.ts", source: "" }];
  assert.deepEqual(untested(routes, 'fetch("/api/bx")'), ["/api/b"]);
});

// --- use-case catalog --------------------------------------------------------------------

const CATALOG = [
  "| # | Use case | Operation | Stability |",
  "| - | -------- | --------- | --------- |",
  "| 1 | Chat | `POST /api/v1/chat/completions` | `stable` |",
  "| 2 | Health | `GET /api/health` | `experimental` |",
].join("\n");

test("the use-case table is parsed into operation keys", () => {
  assert.deepEqual(useCases(CATALOG), [
    { index: 1, key: "POST /api/v1/chat/completions", stability: "stable" },
    { index: 2, key: "GET /api/health", stability: "experimental" },
  ]);
});

test("catalog rows must name documented operations with the spec's stability", () => {
  const spec: Spec = {
    paths: {
      "/api/v1/chat/completions": { post: governed({ "x-stability": "stable" }) },
      "/api/health": { get: governed({ "x-stability": "internal" }) },
    },
  };
  const cases = [...useCases(CATALOG), { index: 3, key: "GET /api/ghost", stability: "stable" }];
  const errors = checkCases(cases, spec, 3);
  assert.deepEqual(errors, [
    'use case 2: GET /api/health is "internal" in the spec, catalog says "experimental"',
    "use case 3: GET /api/ghost is not a documented operation",
  ]);
  assert.match(checkCases(useCases(CATALOG), spec)[0], /needs >= 10/);
});

// --- helpers + ratchet ---------------------------------------------------------------------

test("ratchet splits new violations from stale baseline entries", () => {
  assert.deepEqual(ratchet(["a", "b"], ["b", "c"]), { fresh: ["a"], stale: ["c"] });
});

test("helpers: semver, rate-limit derivation, examples, CODEOWNERS, exported verbs", () => {
  assert.ok(compareSemver("3.8.53", "3.8.9") > 0);
  assert.ok(Number.isNaN(compareSemver("3.8", "3.8.1")));
  assert.equal(deriveRateLimit("await enforceApiKeyPolicy(req, model)"), "api-key-policy");
  assert.equal(deriveRateLimit("export async function GET() {}"), "none");
  assert.equal(
    hasExample({ responses: { "200": { content: { "a/b": { examples: {} } } } } }),
    true
  );
  assert.equal(hasExample({ responses: {} }), false);
  assert.deepEqual(
    [...parseCodeowners("# c\n* @a @org/team\ndocs/ @b\n")],
    ["@a", "@org/team", "@b"]
  );
  assert.deepEqual(
    (exportedMethods as (s: string) => string[])("export { GET, HEAD } from './x';"),
    ["get", "head"]
  );
  const counts = (summarizeStability as (s: Spec) => Record<string, number>)({
    paths: { "/a": { get: governed(), post: { "x-stability": "bogus" } } },
  });
  assert.equal(counts.experimental, 1);
  assert.equal(counts.invalid, 1);
});

// --- live repository -----------------------------------------------------------------------

test("the live repository passes the API governance gate", () => {
  const { violations, summary } = run();
  assert.deepEqual(violations, []);
  assert.ok(summary && summary.stability.stable >= 1);
  assert.equal(summary?.stability.invalid, 0);
});
