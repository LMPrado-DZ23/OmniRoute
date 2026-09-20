/**
 * Finding #2 residual — the complete authorization matrix
 *   route class × caller origin × credential × requireLogin
 * pinned as one table-driven regression, so no future change can silently widen what
 * `requireLogin=false` or a LAN peer may reach.
 *
 * Route classes (one representative each, resolved through the real classifier and policies):
 *   PUBLIC            GET  /api/monitoring/health
 *   CLIENT_API        POST /api/v1/chat/completions     (gated by REQUIRE_API_KEY, not requireLogin)
 *   MANAGEMENT        GET  /api/keys
 *   LOCAL_ONLY strict POST /api/cli-tools/runtime/foo   (spawn-capable; NO bypass)
 *   LOCAL_ONLY bypass GET  /api/mcp/tools               (manage / mcp:connect / session bypass)
 *   ALWAYS_PROTECTED  GET  /api/shutdown
 * Origins: loopback (127.0.0.1), private LAN (192.168.1.20), public (203.0.113.5) — the real
 * socket peer (never the spoofable Host header).
 * Credentials: none, dashboard session cookie, API key with `manage`, API key with only
 * `mcp:connect`.
 *
 * Invariants this table encodes:
 *   - LOOPBACK_ONLY ≠ TRUSTED_LAN: a LAN or public peer NEVER reaches a strict LOCAL_ONLY path,
 *     whatever it presents; it reaches a bypassable one only with real auth (session, manage
 *     key, or mcp:connect for /api/mcp/) — never anonymously, even with requireLogin=false.
 *   - requireLogin=false relaxes MANAGEMENT only; ALWAYS_PROTECTED still demands auth, and an
 *     mcp:connect-only key is never a management credential.
 *   - CLIENT_API follows REQUIRE_API_KEY; a dashboard session or any valid key authenticates.
 *   - PUBLIC never rejects.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-authz-matrix-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "matrix-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "matrix-jwt-secret";
process.env.INITIAL_PASSWORD = "matrix-initial-password";
delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
delete process.env.OMNIROUTE_DISABLE_CLI_TOKEN;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { publicPolicy } = await import("../../../src/server/authz/policies/public.ts");
const { clientApiPolicy } = await import("../../../src/server/authz/policies/clientApi.ts");
const { managementPolicy } = await import("../../../src/server/authz/policies/management.ts");

const POLICIES = {
  PUBLIC: publicPolicy,
  CLIENT_API: clientApiPolicy,
  MANAGEMENT: managementPolicy,
};

type Origin = "loopback" | "lan" | "public";
type Credential = "none" | "cookie" | "manage-key" | "mcp-key";
type RouteKind =
  | "PUBLIC"
  | "CLIENT_API"
  | "MANAGEMENT"
  | "LOCAL_ONLY_STRICT"
  | "LOCAL_ONLY_BYPASS"
  | "ALWAYS_PROTECTED";

const ORIGIN_IP: Record<Origin, string> = {
  loopback: "127.0.0.1",
  lan: "192.168.1.20",
  public: "203.0.113.5",
};

const ROUTES: Record<RouteKind, { method: string; path: string }> = {
  PUBLIC: { method: "GET", path: "/api/monitoring/health" },
  CLIENT_API: { method: "POST", path: "/api/v1/chat/completions" },
  MANAGEMENT: { method: "GET", path: "/api/keys" },
  LOCAL_ONLY_STRICT: { method: "POST", path: "/api/cli-tools/runtime/foo" },
  LOCAL_ONLY_BYPASS: { method: "GET", path: "/api/mcp/tools" },
  ALWAYS_PROTECTED: { method: "GET", path: "/api/shutdown" },
};

type Expectation =
  { allow: true; kinds: string[] } | { allow: false; status: number; code: string };

const ALLOW = (...kinds: string[]): Expectation => ({ allow: true, kinds });
const REJECT = (status: number, code: string): Expectation => ({ allow: false, status, code });

/** The contract. `login` = requireLogin for MANAGEMENT-class rows, REQUIRE_API_KEY for CLIENT_API. */
function expected(route: RouteKind, origin: Origin, cred: Credential, login: boolean): Expectation {
  switch (route) {
    case "PUBLIC":
      return ALLOW("anonymous");
    case "CLIENT_API":
      if (cred === "cookie") return ALLOW("dashboard_session");
      if (cred === "manage-key" || cred === "mcp-key") return ALLOW("client_api_key");
      if (login) return REJECT(401, "AUTH_002");
      // REQUIRE_API_KEY=false means "this machine and my LAN may call without a key",
      // never "the internet may". This row used to expect ALLOW for every origin,
      // which encoded the open-relay defect as the contract: a published instance
      // routed an anonymous POST /v1/chat/completions on the operator's credentials.
      return origin === "public" ? REJECT(401, "AUTH_002") : ALLOW("anonymous");
    case "MANAGEMENT":
      if (!login) return ALLOW("anonymous");
      if (cred === "none") return REJECT(401, "AUTH_001");
      if (cred === "cookie") return ALLOW("dashboard_session");
      if (cred === "manage-key") return ALLOW("management_key");
      return REJECT(403, "AUTH_001"); // mcp:connect is not a management credential
    case "LOCAL_ONLY_STRICT":
      if (origin !== "loopback") return REJECT(403, "LOCAL_ONLY"); // whatever is presented
      return expected("MANAGEMENT", origin, cred, login);
    case "LOCAL_ONLY_BYPASS":
      if (origin !== "loopback") {
        if (cred === "none") return REJECT(403, "LOCAL_ONLY"); // even with requireLogin=false
        if (cred === "cookie") return ALLOW("dashboard_session");
        return ALLOW("management_key"); // manage or mcp:connect bypass
      }
      // A presented key is identified before the requireLogin relaxation on bypassable
      // paths (it is what the bypass keys on), so the subject may be either.
      if (!login)
        return ALLOW(
          "anonymous",
          ...(cred === "none" || cred === "cookie" ? [] : ["management_key"])
        );
      if (cred === "none") return REJECT(401, "AUTH_001");
      if (cred === "cookie") return ALLOW("dashboard_session");
      return ALLOW("management_key"); // manage or the /api/mcp/ mcp:connect carve-out
    case "ALWAYS_PROTECTED":
      if (cred === "none") return REJECT(401, "AUTH_001"); // requireLogin=false does not help
      if (cred === "cookie") return ALLOW("dashboard_session");
      if (cred === "manage-key") return ALLOW("management_key");
      return REJECT(403, "AUTH_001");
  }
}

let manageKey = "";
let mcpKey = "";

async function dashboardCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

async function headersFor(cred: Credential): Promise<Headers> {
  const headers = new Headers();
  if (cred === "cookie") headers.set("cookie", await dashboardCookie());
  if (cred === "manage-key") headers.set("authorization", `Bearer ${manageKey}`);
  if (cred === "mcp-key") headers.set("authorization", `Bearer ${mcpKey}`);
  return headers;
}

function ctxFor(route: RouteKind, origin: Origin, headers: Headers) {
  const { method, path: routePath } = ROUTES[route];
  const classification = classifyRoute(routePath, method);
  return {
    classification,
    requestId: `req_${route}_${origin}`,
    request: {
      method,
      headers,
      url: `http://localhost${routePath}`,
      nextUrl: { pathname: routePath },
      ip: ORIGIN_IP[origin],
    },
  };
}

async function setLogin(route: RouteKind, on: boolean) {
  if (route === "CLIENT_API") {
    process.env.REQUIRE_API_KEY = on ? "true" : "false";
    await settingsDb.updateSettings({ requireLogin: true });
  } else {
    delete process.env.REQUIRE_API_KEY;
    await settingsDb.updateSettings({ requireLogin: on });
  }
}

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  manageKey = (await apiKeysDb.createApiKey("matrix-manage", "machine-matrix-01", ["manage"])).key;
  mcpKey = (await apiKeysDb.createApiKey("matrix-mcp", "machine-matrix-02", ["mcp:connect"])).key;
});

test.after(() => {
  core.resetDbInstance();
  delete process.env.REQUIRE_API_KEY;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("classifier assigns the representative routes to the intended classes / tiers", async () => {
  const { isLocalOnlyPath, isAlwaysProtectedPath, isLocalOnlyBypassableByManageScope } =
    await import("../../../src/server/authz/routeGuard.ts");
  assert.equal(classifyRoute(ROUTES.PUBLIC.path, "GET").routeClass, "PUBLIC");
  assert.equal(classifyRoute(ROUTES.CLIENT_API.path, "POST").routeClass, "CLIENT_API");
  for (const kind of [
    "MANAGEMENT",
    "LOCAL_ONLY_STRICT",
    "LOCAL_ONLY_BYPASS",
    "ALWAYS_PROTECTED",
  ] as const) {
    assert.equal(
      classifyRoute(ROUTES[kind].path, ROUTES[kind].method).routeClass,
      "MANAGEMENT",
      kind
    );
  }
  assert.equal(isLocalOnlyPath(ROUTES.LOCAL_ONLY_STRICT.path, "POST"), true);
  assert.equal(isLocalOnlyBypassableByManageScope(ROUTES.LOCAL_ONLY_STRICT.path), false);
  assert.equal(isLocalOnlyPath(ROUTES.LOCAL_ONLY_BYPASS.path, "GET"), true);
  assert.equal(isLocalOnlyBypassableByManageScope(ROUTES.LOCAL_ONLY_BYPASS.path), true);
  assert.equal(isAlwaysProtectedPath(ROUTES.ALWAYS_PROTECTED.path), true);
  assert.equal(isLocalOnlyPath(ROUTES.MANAGEMENT.path, "GET"), false);
  assert.equal(isAlwaysProtectedPath(ROUTES.MANAGEMENT.path), false);
});

const ROUTE_KINDS = Object.keys(ROUTES) as RouteKind[];
const ORIGINS: Origin[] = ["loopback", "lan", "public"];
const CREDS: Credential[] = ["none", "cookie", "manage-key", "mcp-key"];

for (const login of [true, false]) {
  for (const route of ROUTE_KINDS) {
    const loginLabel =
      route === "CLIENT_API" ? `REQUIRE_API_KEY=${login}` : `requireLogin=${login}`;
    test(`matrix ${route} ${ROUTES[route].method} ${ROUTES[route].path} — ${loginLabel} (${ORIGINS.length * CREDS.length} cells)`, async () => {
      await setLogin(route, login);
      const failures: string[] = [];
      for (const origin of ORIGINS) {
        for (const cred of CREDS) {
          const want = expected(route, origin, cred, login);
          const ctx = ctxFor(route, origin, await headersFor(cred));
          const policy = POLICIES[ctx.classification.routeClass];
          const got = await policy.evaluate(ctx as never);
          const cell = `${origin}/${cred}`;
          if (want.allow) {
            if (!got.allow) {
              failures.push(
                `${cell}: expected ALLOW(${want.kinds.join("|")}), got ${got.status} ${got.code}`
              );
            } else if (!want.kinds.includes(got.subject.kind)) {
              failures.push(
                `${cell}: expected subject ${want.kinds.join("|")}, got ${got.subject.kind}`
              );
            }
          } else if (got.allow) {
            failures.push(
              `${cell}: expected ${want.status} ${want.code}, got ALLOW(${got.subject.kind}/${got.subject.label ?? ""})`
            );
          } else if (got.status !== want.status || got.code !== want.code) {
            failures.push(
              `${cell}: expected ${want.status} ${want.code}, got ${got.status} ${got.code}`
            );
          }
        }
      }
      assert.deepEqual(failures, [], `matrix deviations:\n${failures.join("\n")}`);
    });
  }
}
