// Contract tests for the API-key group routes.
//
// Covers the four routes that govern which API keys may reach which models:
//   /api/keys/groups, /api/keys/groups/{id},
//   /api/keys/groups/{id}/keys, /api/keys/groups/{id}/permissions
//
// The handlers are driven directly (no HTTP server, no provider calls) against a
// throwaway SQLite database, and the assertions are the documented contract:
// status codes, response envelope shape, and the 400/404 failure bodies.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-groups-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "key-groups-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const groupsRoute = await import("../../../../src/app/api/keys/groups/route.ts");
const groupRoute = await import("../../../../src/app/api/keys/groups/[id]/route.ts");
const groupKeysRoute = await import("../../../../src/app/api/keys/groups/[id]/keys/route.ts");
const groupPermissionsRoute =
  await import("../../../../src/app/api/keys/groups/[id]/permissions/route.ts");

type KeyGroupShape = {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string }> };
};
type PlainErrorBody = { error: string };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let groupId = "";

before(async () => {
  const created = await groupsRoute.POST(
    jsonRequest("http://localhost/api/keys/groups", "POST", {
      name: "contract-fixture",
      description: "fixture group",
    })
  );
  assert.equal(created.status, 201);
  groupId = (await readJson<{ group: KeyGroupShape }>(created)).group.id;
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/keys/groups ─────────────────────────────────────────────────────────

it("GET /api/keys/groups returns a { groups: [...] } envelope", async () => {
  const response = await groupsRoute.GET();
  assert.equal(response.status, 200);
  const body = await readJson<{ groups: KeyGroupShape[] }>(response);
  assert.ok(Array.isArray(body.groups));
  const fixture = body.groups.find((group) => group.id === groupId);
  assert.ok(fixture, "the created group is listed");
  assert.equal(fixture.name, "contract-fixture");
  assert.equal(fixture.description, "fixture group");
  assert.equal(fixture.isActive, true);
  assert.equal(typeof fixture.createdAt, "string");
  assert.equal(typeof fixture.updatedAt, "string");
});

it("POST /api/keys/groups creates a group and answers 201 with the new row", async () => {
  const response = await groupsRoute.POST(
    jsonRequest("http://localhost/api/keys/groups", "POST", { name: "created-by-contract-test" })
  );
  assert.equal(response.status, 201);
  const body = await readJson<{ group: KeyGroupShape }>(response);
  assert.equal(body.group.name, "created-by-contract-test");
  assert.equal(body.group.description, "");
  assert.match(body.group.id, /^[0-9a-f-]{36}$/);
});

it("POST /api/keys/groups rejects a blank name with 400 and names the field", async () => {
  const response = await groupsRoute.POST(
    jsonRequest("http://localhost/api/keys/groups", "POST", { name: "   " })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["name"]
  );
  assert.equal(body.error.details[0].message, "name is required");
});

// ── /api/keys/groups/{id} ────────────────────────────────────────────────────

it("GET /api/keys/groups/{id} returns the group with permissions and members", async () => {
  const response = await groupRoute.GET(
    new Request(`http://localhost/api/keys/groups/${groupId}`),
    params(groupId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    group: KeyGroupShape & { permissions: unknown[]; memberCount: number };
    members: unknown[];
  }>(response);
  assert.equal(body.group.id, groupId);
  assert.ok(Array.isArray(body.group.permissions));
  assert.equal(typeof body.group.memberCount, "number");
  assert.ok(Array.isArray(body.members));
});

it("GET /api/keys/groups/{id} answers 404 for an unknown group", async () => {
  const response = await groupRoute.GET(
    new Request("http://localhost/api/keys/groups/does-not-exist"),
    params("does-not-exist")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "Group not found");
});

it("PUT /api/keys/groups/{id} applies a partial update", async () => {
  const response = await groupRoute.PUT(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}`, "PUT", {
      description: "renamed by contract test",
    }),
    params(groupId)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ group: KeyGroupShape }>(response);
  assert.equal(body.group.description, "renamed by contract test");
  assert.equal(body.group.name, "contract-fixture", "untouched fields are preserved");
});

it("PUT /api/keys/groups/{id} rejects an empty update body with 400", async () => {
  const response = await groupRoute.PUT(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}`, "PUT", {}),
    params(groupId)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.ok(body.error.details.length > 0);
});

it("DELETE /api/keys/groups/{id} answers 404 for an unknown group", async () => {
  const response = await groupRoute.DELETE(
    new Request("http://localhost/api/keys/groups/does-not-exist", { method: "DELETE" }),
    params("does-not-exist")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "Group not found");
});

it("DELETE /api/keys/groups/{id} removes the group and it stops being listed", async () => {
  const created = await groupsRoute.POST(
    jsonRequest("http://localhost/api/keys/groups", "POST", { name: "to-be-deleted" })
  );
  const doomedId = (await readJson<{ group: KeyGroupShape }>(created)).group.id;

  const response = await groupRoute.DELETE(
    new Request(`http://localhost/api/keys/groups/${doomedId}`, { method: "DELETE" }),
    params(doomedId)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(response), { success: true });

  const after404 = await groupRoute.GET(
    new Request(`http://localhost/api/keys/groups/${doomedId}`),
    params(doomedId)
  );
  assert.equal(after404.status, 404);
});

// ── /api/keys/groups/{id}/keys ───────────────────────────────────────────────

it("POST/GET/DELETE /api/keys/groups/{id}/keys round-trips a membership", async () => {
  const { id: keyId } = await apiKeysDb.createApiKey("group-member", "contract-test", ["manage"]);

  const added = await groupKeysRoute.POST(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}/keys`, "POST", { keyId }),
    params(groupId)
  );
  assert.equal(added.status, 201);
  assert.deepEqual(await readJson<{ success: boolean }>(added), { success: true });

  const listed = await groupKeysRoute.GET(
    new Request(`http://localhost/api/keys/groups/${groupId}/keys`),
    params(groupId)
  );
  assert.equal(listed.status, 200);
  const members = await readJson<{ members: Array<{ keyId: string; groupId: string }> }>(listed);
  assert.ok(
    members.members.some((member) => member.keyId === keyId && member.groupId === groupId),
    "the added key is a member"
  );

  const removed = await groupKeysRoute.DELETE(
    new Request(`http://localhost/api/keys/groups/${groupId}/keys?keyId=${keyId}`, {
      method: "DELETE",
    }),
    params(groupId)
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(removed), { success: true });
});

it("GET /api/keys/groups/{id}/keys answers 404 for an unknown group", async () => {
  const response = await groupKeysRoute.GET(
    new Request("http://localhost/api/keys/groups/nope/keys"),
    params("nope")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "Group not found");
});

it("POST /api/keys/groups/{id}/keys rejects a missing keyId with 400", async () => {
  const response = await groupKeysRoute.POST(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}/keys`, "POST", {}),
    params(groupId)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["keyId"]
  );
});

it("DELETE /api/keys/groups/{id}/keys requires the keyId query param", async () => {
  const response = await groupKeysRoute.DELETE(
    new Request(`http://localhost/api/keys/groups/${groupId}/keys`, { method: "DELETE" }),
    params(groupId)
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "keyId query param required");
});

it("DELETE /api/keys/groups/{id}/keys answers 404 when the key is not a member", async () => {
  const response = await groupKeysRoute.DELETE(
    new Request(`http://localhost/api/keys/groups/${groupId}/keys?keyId=not-a-member`, {
      method: "DELETE",
    }),
    params(groupId)
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "Key not found in group");
});

// ── /api/keys/groups/{id}/permissions ────────────────────────────────────────

it("POST/GET/DELETE /api/keys/groups/{id}/permissions round-trips a rule", async () => {
  const created = await groupPermissionsRoute.POST(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}/permissions`, "POST", {
      modelPattern: "gpt-4*",
      accessType: "deny",
      provider: "openai",
    }),
    params(groupId)
  );
  assert.equal(created.status, 201);
  const permission = (
    await readJson<{
      permission: {
        id: string;
        groupId: string;
        modelPattern: string;
        provider: string | null;
        accessType: string;
      };
    }>(created)
  ).permission;
  assert.equal(permission.groupId, groupId);
  assert.equal(permission.modelPattern, "gpt-4*");
  assert.equal(permission.accessType, "deny");
  assert.equal(permission.provider, "openai");

  const listed = await groupPermissionsRoute.GET(
    new Request(`http://localhost/api/keys/groups/${groupId}/permissions`),
    params(groupId)
  );
  assert.equal(listed.status, 200);
  const permissions = await readJson<{ permissions: Array<{ id: string }> }>(listed);
  assert.ok(permissions.permissions.some((rule) => rule.id === permission.id));

  const removed = await groupPermissionsRoute.DELETE(
    new Request(
      `http://localhost/api/keys/groups/${groupId}/permissions?permissionId=${permission.id}`,
      { method: "DELETE" }
    ),
    params(groupId)
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(removed), { success: true });
});

it("POST /api/keys/groups/{id}/permissions rejects an unknown accessType with 400", async () => {
  const response = await groupPermissionsRoute.POST(
    jsonRequest(`http://localhost/api/keys/groups/${groupId}/permissions`, "POST", {
      modelPattern: "gpt-4*",
      accessType: "maybe",
    }),
    params(groupId)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["accessType"]
  );
});

it("GET /api/keys/groups/{id}/permissions answers 404 for an unknown group", async () => {
  const response = await groupPermissionsRoute.GET(
    new Request("http://localhost/api/keys/groups/nope/permissions"),
    params("nope")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<PlainErrorBody>(response)).error, "Group not found");
});

it("DELETE /api/keys/groups/{id}/permissions requires the permissionId query param", async () => {
  const response = await groupPermissionsRoute.DELETE(
    new Request(`http://localhost/api/keys/groups/${groupId}/permissions`, { method: "DELETE" }),
    params(groupId)
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<PlainErrorBody>(response)).error,
    "permissionId query param required"
  );
});
