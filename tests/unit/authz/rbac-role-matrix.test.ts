/**
 * Phase 8 — management role matrix: principal × route class, through the REAL classifier and
 * policies (no mocks), with requireLogin=true and REQUIRE_API_KEY=true.
 *
 * Principals (8): dashboard session, manage-scope API key, CLI access tokens with scope
 * admin / write / read, API key without management scope, API key with only `mcp:connect`,
 * no credential.
 * Routes (8): PUBLIC, CLIENT_API, and six MANAGEMENT routes spanning the `read`, `write` and
 * `admin` requirements of `inferRequiredScope`.
 *
 * Contract: a MANAGEMENT request is allowed iff the principal has a management role
 * (`src/server/authz/roles.ts`) whose equivalent access scope satisfies the route's required
 * scope, and the allowed subject resolves back to exactly that role. The role model is
 * therefore a naming of what the policies already enforce — never a second source of truth.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import type { PolicyContext, RoutePolicy } from "../../../src/server/authz/context.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-rbac-role-matrix-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "rbac-role-matrix-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "rbac-role-matrix-jwt-secret";
process.env.INITIAL_PASSWORD = "rbac-role-matrix-password";
delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
delete process.env.OMNIROUTE_DISABLE_CLI_TOKEN;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../../src/lib/db/accessTokens.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { publicPolicy } = await import("../../../src/server/authz/policies/public.ts");
const { clientApiPolicy } = await import("../../../src/server/authz/policies/clientApi.ts");
const { managementPolicy } = await import("../../../src/server/authz/policies/management.ts");
const { resolveManagementRole } = await import("../../../src/server/authz/roles.ts");
const { inferRequiredScope } = await import("../../../src/server/authz/accessScopes.ts");
const { scopeSatisfies } = await import("../../../src/lib/accessTokens/scopes.ts");

type Role = "owner" | "admin" | "operator" | "viewer";
type Principal =
  | "owner-session"
  | "admin-api-key"
  | "admin-token"
  | "operator-token"
  | "viewer-token"
  | "client-api-key"
  | "mcp-connect-key"
  | "anonymous";

const PRINCIPALS: readonly Principal[] = [
  "owner-session",
  "admin-api-key",
  "admin-token",
  "operator-token",
  "viewer-token",
  "client-api-key",
  "mcp-connect-key",
  "anonymous",
];

const PRINCIPAL_ROLE: Record<Principal, Role | null> = {
  "owner-session": "owner",
  "admin-api-key": "admin",
  "admin-token": "admin",
  "operator-token": "operator",
  "viewer-token": "viewer",
  "client-api-key": null,
  "mcp-connect-key": null,
  anonymous: null,
};

/** Documented role → equivalent CLI access-token scope (docs/architecture/WORKSPACES_RBAC.md). */
const ROLE_SCOPE = { owner: "admin", admin: "admin", operator: "write", viewer: "read" } as const;

interface RouteCase {
  method: string;
  path: string;
  routeClass: "PUBLIC" | "CLIENT_API" | "MANAGEMENT";
}

const ROUTES: readonly RouteCase[] = [
  { method: "GET", path: "/api/monitoring/health", routeClass: "PUBLIC" },
  { method: "POST", path: "/api/v1/chat/completions", routeClass: "CLIENT_API" },
  { method: "GET", path: "/api/keys", routeClass: "MANAGEMENT" },
  { method: "POST", path: "/api/keys", routeClass: "MANAGEMENT" },
  { method: "POST", path: "/api/usage/budget", routeClass: "MANAGEMENT" },
  { method: "GET", path: "/api/providers", routeClass: "MANAGEMENT" },
  { method: "POST", path: "/api/providers", routeClass: "MANAGEMENT" },
  { method: "GET", path: "/api/cli/tokens", routeClass: "MANAGEMENT" },
];

const POLICIES: Record<string, RoutePolicy> = {
  PUBLIC: publicPolicy,
  CLIENT_API: clientApiPolicy,
  MANAGEMENT: managementPolicy,
};

type Expectation =
  { allow: true; role: Role | null } | { allow: false; status: number; code: string | null };

function expected(route: RouteCase, principal: Principal): Expectation {
  if (route.routeClass === "PUBLIC") return { allow: true, role: null };
  if (route.routeClass === "CLIENT_API") {
    // Any valid inference API key or a dashboard session; a CLI access token is a
    // management credential, never a client credential.
    if (principal === "owner-session" || principal.endsWith("-key")) {
      return { allow: true, role: null };
    }
    return { allow: false, status: 401, code: null };
  }
  if (principal === "anonymous") return { allow: false, status: 401, code: "AUTH_001" };
  const role = PRINCIPAL_ROLE[principal];
  if (role === null) return { allow: false, status: 403, code: "AUTH_001" };
  if (!scopeSatisfies(ROLE_SCOPE[role], inferRequiredScope(route.method, route.path))) {
    return { allow: false, status: 403, code: "AUTH_SCOPE" };
  }
  return { allow: true, role };
}

const secrets = new Map<Principal, string>();

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

async function contextFor(route: RouteCase, principal: Principal): Promise<PolicyContext> {
  const headers = new Headers();
  if (principal === "owner-session") headers.set("cookie", await sessionCookie());
  const secret = secrets.get(principal);
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  return {
    classification: classifyRoute(route.path, route.method),
    requestId: `req_rbac_${principal}`,
    request: {
      method: route.method,
      headers,
      url: `http://localhost${route.path}`,
      nextUrl: { pathname: route.path },
      ip: "203.0.113.5",
    },
  };
}

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.REQUIRE_API_KEY = "true";
  const machine = "machine-rbac-0001";
  secrets.set(
    "admin-api-key",
    (await apiKeysDb.createApiKey("rbac-manage", machine, ["manage"])).key
  );
  secrets.set("client-api-key", (await apiKeysDb.createApiKey("rbac-client", machine, [])).key);
  secrets.set(
    "mcp-connect-key",
    (await apiKeysDb.createApiKey("rbac-mcp", machine, ["mcp:connect"])).key
  );
  for (const [principal, scope] of [
    ["admin-token", "admin"],
    ["operator-token", "write"],
    ["viewer-token", "read"],
  ] as const) {
    const { secret } = accessTokensDb.createAccessToken({
      name: `rbac-${scope}`,
      scope,
      expiresAt: null,
    });
    secrets.set(principal, secret);
  }
});

test.after(() => {
  core.resetDbInstance();
  delete process.env.REQUIRE_API_KEY;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("representative routes land in the intended class and scope tier", () => {
  const tiers = ROUTES.map((route) => ({
    route: `${route.method} ${route.path}`,
    routeClass: classifyRoute(route.path, route.method).routeClass,
    scope: route.routeClass === "MANAGEMENT" ? inferRequiredScope(route.method, route.path) : null,
  }));
  assert.deepEqual(tiers, [
    { route: "GET /api/monitoring/health", routeClass: "PUBLIC", scope: null },
    { route: "POST /api/v1/chat/completions", routeClass: "CLIENT_API", scope: null },
    { route: "GET /api/keys", routeClass: "MANAGEMENT", scope: "read" },
    { route: "POST /api/keys", routeClass: "MANAGEMENT", scope: "write" },
    { route: "POST /api/usage/budget", routeClass: "MANAGEMENT", scope: "write" },
    { route: "GET /api/providers", routeClass: "MANAGEMENT", scope: "read" },
    { route: "POST /api/providers", routeClass: "MANAGEMENT", scope: "admin" },
    { route: "GET /api/cli/tokens", routeClass: "MANAGEMENT", scope: "admin" },
  ]);
});

for (const route of ROUTES) {
  test(`role matrix ${route.method} ${route.path} (${PRINCIPALS.length} principals)`, async () => {
    const failures: string[] = [];
    for (const principal of PRINCIPALS) {
      const want = expected(route, principal);
      const ctx = await contextFor(route, principal);
      const policy = POLICIES[ctx.classification.routeClass];
      assert.ok(policy, `no policy for ${ctx.classification.routeClass}`);
      const got = await policy.evaluate(ctx);
      if (want.allow && !got.allow) {
        failures.push(`${principal}: expected ALLOW, got ${got.status} ${got.code}`);
      } else if (!want.allow && got.allow) {
        failures.push(`${principal}: expected ${want.status}, got ALLOW(${got.subject.kind})`);
      } else if (!want.allow && !got.allow) {
        if (got.status !== want.status || (want.code !== null && got.code !== want.code)) {
          failures.push(
            `${principal}: expected ${want.status} ${want.code ?? "*"}, got ${got.status} ${got.code}`
          );
        }
      } else if (want.allow && got.allow && route.routeClass === "MANAGEMENT") {
        const role = resolveManagementRole(got.subject);
        if (role !== want.role)
          failures.push(`${principal}: expected role ${want.role}, got ${role}`);
      }
    }
    assert.deepEqual(failures, [], `role matrix deviations:\n${failures.join("\n")}`);
  });
}

test("resolveManagementRole covers every subject label the policies emit", () => {
  const cases: Array<[Parameters<typeof resolveManagementRole>[0], Role | null]> = [
    [{ kind: "dashboard_session" }, "owner"],
    [{ kind: "dashboard_session", label: "dashboard-session-local-only-bypass" }, "owner"],
    [{ kind: "anonymous", label: "auth-disabled" }, "owner"],
    [{ kind: "anonymous" }, null],
    [{ kind: "management_key", label: "local-cli-token" }, "owner"],
    [{ kind: "management_key", label: "access-token:admin" }, "admin"],
    [{ kind: "management_key", label: "access-token:write" }, "operator"],
    [{ kind: "management_key", label: "access-token:read" }, "viewer"],
    [{ kind: "management_key", label: "access-token:root" }, null],
    [{ kind: "management_key", label: "api-key-manage-scope" }, "admin"],
    [{ kind: "management_key", label: "api-key-admin-scope-local-only-bypass" }, "admin"],
    [{ kind: "management_key", label: "api-key-mcp-connect-scope-mcp-carve-out" }, null],
    [{ kind: "management_key", label: "internal-service-token" }, null],
    [{ kind: "management_key", label: "codex-ws-bridge-secret" }, null],
    [{ kind: "management_key" }, null],
    [{ kind: "client_api_key", label: "api-key-manage-scope" }, null],
  ];
  for (const [subject, role] of cases) {
    assert.equal(resolveManagementRole(subject), role, JSON.stringify(subject));
  }
});
