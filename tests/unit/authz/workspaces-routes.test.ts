/**
 * /api/workspaces/** — route handlers, authentication, membership authorization and IDOR.
 *
 * Principals: owner (dashboard session), two management API keys (A: admin of W1, B: creator
 * and admin of W2), CLI access tokens (admin-scope viewer member of W1, write-scope admin
 * member of W1, admin-scope outsider), a client API key and an anonymous caller.
 *
 * Isolation invariant: for a caller that is not a member, every operation addressing another
 * workspace (or a project / key inside it) answers with the SAME status and body as the same
 * operation on an id that does not exist, and changes nothing.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-workspaces-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "workspaces-routes-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "workspaces-routes-jwt-secret";
process.env.INITIAL_PASSWORD = "workspaces-routes-password";
process.env.APP_LOG_TO_FILE = "false";
delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const accessTokensDb = await import("../../../src/lib/db/accessTokens.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const workspacesDb = await import("../../../src/lib/db/workspaces.ts");
const compliance = await import("../../../src/lib/compliance/index.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { inferRequiredScope } = await import("../../../src/server/authz/accessScopes.ts");
const collectionRoute = await import("../../../src/app/api/workspaces/route.ts");
const workspaceRoute = await import("../../../src/app/api/workspaces/[id]/route.ts");
const projectsRoute = await import("../../../src/app/api/workspaces/[id]/projects/route.ts");
const projectRoute =
  await import("../../../src/app/api/workspaces/[id]/projects/[projectId]/route.ts");
const projectKeysRoute =
  await import("../../../src/app/api/workspaces/[id]/projects/[projectId]/keys/route.ts");
const membersRoute = await import("../../../src/app/api/workspaces/[id]/members/route.ts");
const memberRoute =
  await import("../../../src/app/api/workspaces/[id]/members/[principal]/route.ts");

type Who = "owner" | "keyA" | "keyB" | "viewer" | "writer" | "outsider" | "client" | "anonymous";
interface Reply {
  status: number;
  body: unknown;
}

const secrets = new Map<Who, string>();
const allSecrets: string[] = [];
const bodies: string[] = [];
const ids = { keyA: "", keyB: "", viewer: "", writer: "", w1: "", w2: "", p1: "", p2: "" };

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

async function call(
  who: Who,
  method: string,
  urlPath: string,
  handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  params: Record<string, string> = {},
  body?: unknown
): Promise<Reply> {
  const headers = new Headers({ "x-request-id": `req-${who}-${method}` });
  if (who === "owner") headers.set("cookie", await sessionCookie());
  const secret = secrets.get(who);
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`http://localhost${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve(params) });
  const text = await response.text();
  bodies.push(text);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // compared verbatim
  }
  return { status: response.status, body: parsed };
}

const ws = (who: Who, method: string, id: string, body?: unknown) =>
  call(who, method, `/api/workspaces/${id}`, workspaceRoute[method as "GET"], { id }, body);
const projects = (who: Who, method: string, id: string, body?: unknown) =>
  call(who, method, `/api/workspaces/${id}/projects`, projectsRoute[method as "GET"], { id }, body);
const project = (who: Who, method: string, id: string, projectId: string, body?: unknown) =>
  call(
    who,
    method,
    `/api/workspaces/${id}/projects/${projectId}`,
    projectRoute[method as "GET"],
    { id, projectId },
    body
  );
const projectKeys = (who: Who, id: string, projectId: string, apiKeyIds: string[]) =>
  call(
    who,
    "PUT",
    `/api/workspaces/${id}/projects/${projectId}/keys`,
    projectKeysRoute.PUT,
    { id, projectId },
    { apiKeyIds }
  );
const members = (who: Who, method: string, id: string, body?: unknown) =>
  call(who, method, `/api/workspaces/${id}/members`, membersRoute[method as "GET"], { id }, body);
const removeMember = (who: Who, id: string, principal: string) =>
  call(who, "DELETE", `/api/workspaces/${id}/members/${principal}`, memberRoute.DELETE, {
    id,
    principal,
  });

function field<T>(reply: Reply, key: string): T {
  assert.ok(reply.body && typeof reply.body === "object", `JSON body expected (${reply.status})`);
  return (reply.body as Record<string, T>)[key];
}

function assertSame(actual: Reply, expected: Reply, label: string): void {
  assert.equal(actual.status, expected.status, `${label}: status`);
  assert.deepEqual(actual.body, expected.body, `${label}: body`);
}

const missing = () => `missing-${crypto.randomUUID()}`;

test.before(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  await settingsDb.updateSettings({ requireLogin: true });
  const machine = "machine-workspaces-01";
  const a = await apiKeysDb.createApiKey("ws-manage-a", machine, ["manage"]);
  const b = await apiKeysDb.createApiKey("ws-manage-b", machine, ["manage"]);
  const client = await apiKeysDb.createApiKey("ws-client", machine, []);
  secrets.set("keyA", a.key);
  secrets.set("keyB", b.key);
  secrets.set("client", client.key);
  ids.keyA = a.id;
  ids.keyB = b.id;
  const tokens: Array<[Who, "admin" | "write"]> = [
    ["viewer", "admin"],
    ["writer", "write"],
    ["outsider", "admin"],
  ];
  for (const [who, scope] of tokens) {
    const created = accessTokensDb.createAccessToken({ name: `ws-${who}`, scope, expiresAt: null });
    secrets.set(who, created.secret);
    if (who === "viewer") ids.viewer = created.record.id;
    if (who === "writer") ids.writer = created.record.id;
  }
  allSecrets.push(...secrets.values());
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("the new routes are MANAGEMENT routes; mutations need an admin-scope access token", () => {
  assert.equal(classifyRoute("/api/workspaces").routeClass, "MANAGEMENT");
  assert.equal(classifyRoute("/api/workspaces/x/projects/y/keys").routeClass, "MANAGEMENT");
  assert.equal(inferRequiredScope("GET", "/api/workspaces/x"), "read");
  assert.equal(inferRequiredScope("PATCH", "/api/workspaces/x"), "admin");
  assert.equal(inferRequiredScope("POST", "/api/workspaces"), "admin");
});

test("unauthenticated and client-key callers are refused before any lookup", async () => {
  const list = (who: Who) => call(who, "GET", "/api/workspaces", collectionRoute.GET);
  assert.equal((await list("anonymous")).status, 401);
  assert.equal((await list("client")).status, 403);
  const create = await call(
    "client",
    "POST",
    "/api/workspaces",
    collectionRoute.POST,
    {},
    {
      name: "nope",
    }
  );
  assert.equal(create.status, 403);
  assert.deepEqual(workspacesDb.listWorkspaces(null), []);
});

test("create: owner is not a member; a non-owner creator becomes the workspace admin", async () => {
  const w1 = await call(
    "owner",
    "POST",
    "/api/workspaces",
    collectionRoute.POST,
    {},
    {
      name: "W1",
      budget: { limitUsd: 100, interval: "monthly" },
    }
  );
  assert.equal(w1.status, 201);
  ids.w1 = field<{ id: string }>(w1, "workspace").id;
  const w2 = await call(
    "keyB",
    "POST",
    "/api/workspaces",
    collectionRoute.POST,
    {},
    {
      name: "W2",
      budget: { limitUsd: 40 },
    }
  );
  assert.equal(w2.status, 201);
  ids.w2 = field<{ id: string }>(w2, "workspace").id;

  assert.deepEqual(workspacesDb.listMembers(ids.w1), []);
  assert.deepEqual(
    workspacesDb.listMembers(ids.w2).map((m) => [m.principal, m.role]),
    [[`api_key:${ids.keyB}`, "admin"]]
  );
  const dup = await call(
    "owner",
    "POST",
    "/api/workspaces",
    collectionRoute.POST,
    {},
    {
      name: "W1",
    }
  );
  assert.equal(dup.status, 409);

  for (const [principal, role] of [
    [`api_key:${ids.keyA}`, "admin"],
    [`access_token:${ids.viewer}`, "viewer"],
    [`access_token:${ids.writer}`, "admin"],
  ]) {
    const added = await members("owner", "POST", ids.w1, { principal, role });
    assert.equal(added.status, 200, principal);
  }
  const bad = await members("owner", "POST", ids.w1, { principal: "dashboard", role: "admin" });
  assert.equal(bad.status, 400);

  const p1 = await projects("keyA", "POST", ids.w1, { name: "P1", budget: { limitUsd: 60 } });
  assert.equal(p1.status, 201);
  ids.p1 = field<{ id: string }>(p1, "project").id;
  const p2 = await projects("keyB", "POST", ids.w2, { name: "P2" });
  assert.equal(p2.status, 201);
  ids.p2 = field<{ id: string }>(p2, "project").id;
});

test("list visibility: owner sees all, members see their workspaces, outsiders see none", async () => {
  const names = async (who: Who) =>
    field<Array<{ name: string }>>(
      await call(who, "GET", "/api/workspaces", collectionRoute.GET),
      "workspaces"
    ).map((w) => w.name);
  assert.deepEqual(await names("owner"), ["W1", "W2"]);
  assert.deepEqual(await names("keyA"), ["W1"]);
  assert.deepEqual(await names("keyB"), ["W2"]);
  assert.deepEqual(await names("viewer"), ["W1"]);
  assert.deepEqual(await names("outsider"), []);
});

test("IDOR: another workspace is indistinguishable from a nonexistent one and is not changed", async () => {
  const before = JSON.stringify({
    w: workspacesDb.getWorkspace(ids.w2),
    p: workspacesDb.listProjects(ids.w2),
    m: workspacesDb.listMembers(ids.w2),
  });
  const attempts: Array<[string, (id: string) => Promise<Reply>]> = [
    ["GET workspace", (id) => ws("keyA", "GET", id)],
    ["PATCH workspace", (id) => ws("keyA", "PATCH", id, { budget: { limitUsd: 1 } })],
    ["DELETE workspace", (id) => ws("keyA", "DELETE", id)],
    ["GET projects", (id) => projects("keyA", "GET", id)],
    ["POST project", (id) => projects("keyA", "POST", id, { name: "intruder" })],
    ["GET project", (id) => project("keyA", "GET", id, ids.p2)],
    ["PATCH project", (id) => project("keyA", "PATCH", id, ids.p2, { name: "x" })],
    ["DELETE project", (id) => project("keyA", "DELETE", id, ids.p2)],
    ["PUT keys", (id) => projectKeys("keyA", id, ids.p2, [])],
    ["GET members", (id) => members("keyA", "GET", id)],
    [
      "POST member",
      (id) => members("keyA", "POST", id, { principal: `api_key:${ids.keyA}`, role: "admin" }),
    ],
    ["DELETE member", (id) => removeMember("keyA", id, `api_key:${ids.keyB}`)],
  ];
  for (const [label, attempt] of attempts) {
    const foreign = await attempt(ids.w2);
    const absent = await attempt(missing());
    assert.equal(foreign.status, 404, label);
    assertSame(foreign, absent, label);
  }
  const outsider = await ws("outsider", "GET", ids.w1);
  assertSame(outsider, await ws("outsider", "GET", missing()), "outsider GET");
  const after = JSON.stringify({
    w: workspacesDb.getWorkspace(ids.w2),
    p: workspacesDb.listProjects(ids.w2),
    m: workspacesDb.listMembers(ids.w2),
  });
  assert.equal(after, before, "W2 unchanged by every foreign attempt");
});

test("IDOR: a project id of another workspace is 'not found' inside the caller's workspace", async () => {
  const cases: Array<[string, (projectId: string) => Promise<Reply>]> = [
    ["GET", (pid) => project("keyA", "GET", ids.w1, pid)],
    ["PATCH", (pid) => project("keyA", "PATCH", ids.w1, pid, { budget: { limitUsd: 1 } })],
    ["DELETE", (pid) => project("keyA", "DELETE", ids.w1, pid)],
    ["PUT keys", (pid) => projectKeys("keyA", ids.w1, pid, [])],
  ];
  for (const [label, attempt] of cases) {
    const foreign = await attempt(ids.p2);
    assert.equal(foreign.status, 404, label);
    assertSame(foreign, await attempt(missing()), label);
  }
  assert.ok(workspacesDb.getProject(ids.w2, ids.p2), "P2 still exists in W2");
  assert.equal(workspacesDb.getProject(ids.w2, ids.p2)?.budget.limitUsd, null);
});

test("key assignment: a key in a workspace the caller cannot see is 'not found'; the owner gets 409", async () => {
  const machine = "machine-workspaces-01";
  const foreignKey = await apiKeysDb.createApiKey("ws-foreign-key", machine, []);
  const freeKey = await apiKeysDb.createApiKey("ws-free-key", machine, []);
  allSecrets.push(foreignKey.key, freeKey.key);
  assert.equal((await projectKeys("keyB", ids.w2, ids.p2, [foreignKey.id])).status, 200);

  const hidden = await projectKeys("keyA", ids.w1, ids.p1, [foreignKey.id]);
  assert.equal(hidden.status, 404);
  assertSame(hidden, await projectKeys("keyA", ids.w1, ids.p1, [missing()]), "foreign key");
  const owner = await projectKeys("owner", ids.w1, ids.p1, [foreignKey.id]);
  assert.equal(owner.status, 409);
  assert.deepEqual(workspacesDb.getKeyPlacements([foreignKey.id])[0].projectId, ids.p2);

  const assigned = await projectKeys("keyA", ids.w1, ids.p1, [freeKey.id]);
  assert.equal(assigned.status, 200);
  assert.deepEqual(field<{ apiKeyIds: string[] }>(assigned, "project").apiKeyIds, [freeKey.id]);
});

test("roles: a viewer member reads but cannot write; a write-scope token cannot write either", async () => {
  assert.equal((await ws("viewer", "GET", ids.w1)).status, 200);
  const viewerPatch = await ws("viewer", "PATCH", ids.w1, { name: "renamed" });
  assert.equal(viewerPatch.status, 403);
  const writerPatch = await ws("writer", "PATCH", ids.w1, { name: "renamed" });
  assert.equal(writerPatch.status, 403, "write-scope access token needs admin for mutations");
  assert.equal(workspacesDb.getWorkspace(ids.w1)?.name, "W1");
  assert.equal((await members("viewer", "GET", ids.w1)).status, 200);
  assert.equal(
    (await removeMember("viewer", ids.w1, `api_key:${ids.keyA}`)).status,
    403,
    "a viewer cannot remove members"
  );
});

test("budget rule: a project cannot exceed its workspace on the same interval", async () => {
  const tooBig = await projects("keyA", "POST", ids.w1, { name: "big", budget: { limitUsd: 150 } });
  assert.equal(tooBig.status, 400);
  assert.equal(field<{ code: string }>(tooBig, "error").code, "budget_exceeds_parent");
  const daily = await projects("keyA", "POST", ids.w1, {
    name: "daily",
    budget: { limitUsd: 150, interval: "daily" },
  });
  assert.equal(daily.status, 201, "different interval: allowed, capped at runtime by the parent");
  const raise = await project("keyA", "PATCH", ids.w1, ids.p1, { budget: { limitUsd: 101 } });
  assert.equal(raise.status, 400);
  const shrinkParent = await ws("keyA", "PATCH", ids.w1, { budget: { limitUsd: 50 } });
  assert.equal(shrinkParent.status, 400, "P1 has 60 monthly: the workspace cannot drop to 50");
  const okParent = await ws("keyA", "PATCH", ids.w1, { budget: { limitUsd: 80 } });
  assert.equal(okParent.status, 200);
  assert.equal(workspacesDb.getWorkspace(ids.w1)?.budget.limitUsd, 80);
});

test("detail and deletes: spend per level, non-empty parents are protected", async () => {
  const detail = await ws("keyA", "GET", ids.w1);
  assert.equal(detail.status, 200);
  assert.equal(field<string>(detail, "role"), "admin");
  const spend = field<{ spend: { level: string; limitUsd: number } }>(detail, "workspace").spend;
  assert.equal(spend.level, "workspace");
  assert.equal(spend.limitUsd, 80);
  assert.equal(field<unknown[]>(detail, "projects").length, 2);

  assert.equal((await ws("keyA", "DELETE", ids.w1)).status, 409);
  assert.equal((await project("keyA", "DELETE", ids.w1, ids.p1)).status, 409);
  assert.equal((await projectKeys("keyA", ids.w1, ids.p1, [])).status, 200);
  assert.equal((await project("keyA", "DELETE", ids.w1, ids.p1)).status, 200);
  assert.equal(workspacesDb.getProject(ids.w1, ids.p1), null);
});

test("audit: successful mutations are recorded with the principal; no response or row leaks a secret", () => {
  const actions = compliance
    .getAuditLog({ limit: 500 })
    .map((event: { action: string }) => event.action);
  for (const action of [
    "workspace.create",
    "workspace.update",
    "workspace.member.upsert",
    "project.create",
    "project.keys.set",
    "project.delete",
  ]) {
    assert.ok(actions.includes(action), action);
  }
  const auditText = JSON.stringify(compliance.getAuditLog({ limit: 500 }));
  for (const secret of allSecrets) {
    assert.equal(auditText.includes(secret), false, "audit leaks a secret");
    assert.equal(
      bodies.some((body) => body.includes(secret)),
      false,
      "a response leaks a secret"
    );
  }
});
