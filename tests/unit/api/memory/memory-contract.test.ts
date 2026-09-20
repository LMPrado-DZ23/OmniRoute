// Contract tests for the /api/memory routes an external client depends on.
//
// Covers GET/POST /api/memory, GET/PUT/DELETE /api/memory/{id} and
// GET /api/memory/health. All are guarded by `requireManagementAuth`, so the
// contract is the auth ladder (401 anonymous / 403 under-scoped / 200 manage),
// the paginated list envelope with its `stats` block, the create -> read ->
// update -> delete round-trip, the 400 validation bodies and the 404 paths.
//
// /api/memory/health runs the local extraction self-check (create, list,
// delete a probe memory in SQLite) — no provider is involved.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "memory-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const memoryRoute = await import("../../../../src/app/api/memory/route.ts");
const memoryItemRoute = await import("../../../../src/app/api/memory/[id]/route.ts");
const memoryHealthRoute = await import("../../../../src/app/api/memory/health/route.ts");

type MemoryShape = { id: string; key: string; content: string; type: string };
type ListBody = {
  data: MemoryShape[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  stats: {
    total: number;
    byType: Record<string, number>;
    tokensUsed: number;
    hitRate: number;
    cacheStats: { hits: number; misses: number };
  };
};
type ValidationError = { message: string; details: Array<{ field: string; message: string }> };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(url: string, method = "GET", apiKey?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MEMORY_URL = "http://localhost/api/memory";
const SCOPE = "memory-contract-scope";

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "memory-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("memory-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("memory-readonly", "contract-test", ["read"])).key;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── auth ─────────────────────────────────────────────────────────────────────

it("GET /api/memory answers 401 without a credential", async () => {
  const response = await memoryRoute.GET(req(MEMORY_URL));
  assert.equal(response.status, 401);
  assert.equal(
    (await readJson<{ error: { message: string } }>(response)).error.message,
    "Authentication required"
  );
});

it("POST /api/memory answers 403 for a key without the manage scope", async () => {
  const response = await memoryRoute.POST(
    req(MEMORY_URL, "POST", readOnlyKey, { key: "k", content: "c" })
  );
  assert.equal(response.status, 403);
});

it("GET /api/memory/{id} answers 401 without a credential", async () => {
  const response = await memoryItemRoute.GET(req(`${MEMORY_URL}/anything`), params("anything"));
  assert.equal(response.status, 401);
});

it("GET /api/memory/health answers 401 without a credential", async () => {
  const response = await memoryHealthRoute.GET(req(`${MEMORY_URL}/health`));
  assert.equal(response.status, 401);
});

// ── list / create / read / update / delete ───────────────────────────────────

it("GET /api/memory returns the paginated envelope with stats on an empty scope", async () => {
  const response = await memoryRoute.GET(req(`${MEMORY_URL}?apiKeyId=${SCOPE}`, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<ListBody>(response);
  assert.deepEqual(body.data, []);
  assert.equal(body.total, 0);
  assert.equal(body.page, 1);
  assert.equal(typeof body.limit, "number");
  assert.equal(body.totalPages, 0);
  assert.equal(body.stats.total, 0);
  assert.equal(body.stats.tokensUsed, 0);
  assert.equal(typeof body.stats.hitRate, "number");
  assert.equal(typeof body.stats.cacheStats.hits, "number");
  assert.equal(typeof body.stats.cacheStats.misses, "number");
});

it("POST /api/memory creates a memory that GET /api/memory/{id} reads back", async () => {
  const created = await memoryRoute.POST(
    req(MEMORY_URL, "POST", manageKey, {
      key: "favourite-editor",
      content: "the operator prefers vim",
      type: "factual",
      apiKeyId: SCOPE,
    })
  );
  // KNOWN DESIGN DEBT (pinned, documented in docs/openapi.yaml): the handler
  // answers `200` with `{ success: true, id: <the full MemoryEntry> }` — the
  // field named `id` carries the whole record, not an identifier. The
  // dashboard and CLI consume this shape, so it is kept for compatibility; it
  // blocks promoting this operation to `stable` until an additive fix lands.
  assert.equal(created.status, 200);
  const body = await readJson<{ success: boolean; id: MemoryShape }>(created);
  assert.equal(body.success, true);
  assert.equal(typeof body.id.id, "string");
  assert.ok(body.id.id.length > 0);
  assert.equal(body.id.key, "favourite-editor");
  const createdId = body.id.id;

  const read = await memoryItemRoute.GET(
    req(`${MEMORY_URL}/${createdId}`, "GET", manageKey),
    params(createdId)
  );
  assert.equal(read.status, 200);
  const { memory } = await readJson<{ memory: MemoryShape }>(read);
  assert.equal(memory.id, createdId);
  assert.equal(memory.key, "favourite-editor");
  assert.equal(memory.content, "the operator prefers vim");
  assert.equal(memory.type, "factual");

  const listed = await readJson<ListBody>(
    await memoryRoute.GET(req(`${MEMORY_URL}?apiKeyId=${SCOPE}`, "GET", manageKey))
  );
  assert.equal(listed.total, 1);
  assert.equal(listed.stats.total, 1);
  assert.ok(listed.data.some((entry) => entry.id === createdId));
  assert.ok(listed.stats.tokensUsed > 0, "stored content is counted in tokensUsed");
});

it("PUT /api/memory/{id} updates the content and DELETE removes it", async () => {
  const {
    id: { id },
  } = await readJson<{ id: MemoryShape }>(
    await memoryRoute.POST(
      req(MEMORY_URL, "POST", manageKey, { key: "to-edit", content: "v1", apiKeyId: SCOPE })
    )
  );

  const updated = await memoryItemRoute.PUT(
    req(`${MEMORY_URL}/${id}`, "PUT", manageKey, { content: "v2" }),
    params(id)
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(updated), { success: true });

  const read = await readJson<{ memory: MemoryShape }>(
    await memoryItemRoute.GET(req(`${MEMORY_URL}/${id}`, "GET", manageKey), params(id))
  );
  assert.equal(read.memory.content, "v2");

  const deleted = await memoryItemRoute.DELETE(
    req(`${MEMORY_URL}/${id}`, "DELETE", manageKey),
    params(id)
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await readJson<{ success: boolean }>(deleted), { success: true });

  const gone = await memoryItemRoute.GET(req(`${MEMORY_URL}/${id}`, "GET", manageKey), params(id));
  assert.equal(gone.status, 404);
});

// ── validation and not-found ─────────────────────────────────────────────────

it("POST /api/memory rejects a missing key/content with a field-level 400", async () => {
  const response = await memoryRoute.POST(req(MEMORY_URL, "POST", manageKey, { type: "factual" }));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationError>(response);
  assert.equal(body.message, "Invalid request");
  const fields = body.details.map((detail) => detail.field).sort();
  assert.deepEqual(fields, ["content", "key"]);
});

it("POST /api/memory rejects an unknown memory type with 400", async () => {
  const response = await memoryRoute.POST(
    req(MEMORY_URL, "POST", manageKey, { key: "k", content: "c", type: "gossip" })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationError>(response);
  assert.deepEqual(
    body.details.map((detail) => detail.field),
    ["type"]
  );
});

it("GET /api/memory/{id} answers 404 for an unknown id", async () => {
  const response = await memoryItemRoute.GET(
    req(`${MEMORY_URL}/no-such-memory`, "GET", manageKey),
    params("no-such-memory")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Not found");
});

it("PUT /api/memory/{id} rejects malformed JSON with 400", async () => {
  const response = await memoryItemRoute.PUT(
    new Request(`${MEMORY_URL}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: "{ not json",
    }),
    params("x")
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<{ error: { message: string } }>(response)).error.message,
    "Invalid JSON body"
  );
});

it("DELETE /api/memory/{id} answers 404 for an unknown id", async () => {
  const response = await memoryItemRoute.DELETE(
    req(`${MEMORY_URL}/no-such-memory`, "DELETE", manageKey),
    params("no-such-memory")
  );
  assert.equal(response.status, 404);
  assert.equal((await readJson<{ error: string }>(response)).error, "Memory not found");
});

// ── /api/memory/health ───────────────────────────────────────────────────────

it("GET /api/memory/health reports a working pipeline and leaves no probe behind", async () => {
  const response = await memoryHealthRoute.GET(req(`${MEMORY_URL}/health`, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{ working: boolean; latencyMs: number; error?: string }>(response);
  assert.equal(body.working, true);
  assert.equal(typeof body.latencyMs, "number");
  assert.ok(body.latencyMs >= 0);
  assert.equal(body.error, undefined);

  const probeScope = await readJson<ListBody>(
    await memoryRoute.GET(req(`${MEMORY_URL}?apiKeyId=health-check`, "GET", manageKey))
  );
  assert.equal(probeScope.total, 0, "the self-check deletes its probe memory");
});
