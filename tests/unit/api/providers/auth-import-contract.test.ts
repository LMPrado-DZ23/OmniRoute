// Contract tests for the Claude / Codex credential IMPORT routes.
//
//   POST /api/providers/claude-auth/import      POST /api/providers/codex-auth/import
//   POST /api/providers/claude-auth/import-bulk POST /api/providers/codex-auth/import-bulk
//   POST /api/providers/claude-auth/zip-extract POST /api/providers/codex-auth/zip-extract
//
// These routes turn an uploaded credentials file into a stored provider
// connection, so the contract that matters most is: the auth ladder, that the
// response NEVER echoes the imported tokens back, the coded 400s for every
// malformed file, and the per-entry success/failure accounting of the bulk
// variants.
//
// NO LIVE PROVIDER CALLS: the Claude import enriches the connection from
// https://api.anthropic.com/api/claude_cli/bootstrap. `globalThis.fetch` is
// replaced by a stub that answers that one URL with a canned body and THROWS for
// any other outbound request.
//
// ORDER MATTERS: importing the routes loads open-sse/utils/proxyFetch.ts, which
// REPLACES globalThis.fetch with its proxy-aware `patchedFetch` (wrapping the
// real fetch). A stub installed before the imports is silently bypassed and the
// handler would reach the real network. So the stub is installed AFTER every
// import, `before()` asserts it is the live global, and each network-dependent
// test asserts the stub actually served the bootstrap call. All tokens are fake.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-import-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "auth-import-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const claudeImport = await import("../../../../src/app/api/providers/claude-auth/import/route.ts");
const claudeBulk =
  await import("../../../../src/app/api/providers/claude-auth/import-bulk/route.ts");
const claudeZip =
  await import("../../../../src/app/api/providers/claude-auth/zip-extract/route.ts");
const codexImport = await import("../../../../src/app/api/providers/codex-auth/import/route.ts");
const codexBulk = await import("../../../../src/app/api/providers/codex-auth/import-bulk/route.ts");
const codexZip = await import("../../../../src/app/api/providers/codex-auth/zip-extract/route.ts");

// Installed only now — after proxyFetch has patched the global (see header).
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const outboundCalls: string[] = [];
const unexpectedCalls: string[] = [];
const realFetch = globalThis.fetch;

async function stubFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outboundCalls.push(url);
  if (url === BOOTSTRAP_URL) {
    return Response.json({
      account_uuid: `acct-uuid-${outboundCalls.length}`,
      organization_uuid: "org-uuid-contract",
      organization_name: "Contract Org",
      account_email: "bootstrap@example.com",
    });
  }
  unexpectedCalls.push(url);
  throw new Error(`contract test blocked an unexpected outbound request: ${url}`);
}
globalThis.fetch = stubFetch;

type Connection = Record<string, unknown> & { id: string; provider: string };
type CodedError = { error: string; code: string };
type BulkResult = {
  success: number;
  failed: number;
  total: number;
  created: Connection[];
  errors: Array<{ index: number; name: string; message: string }>;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function post(url: string, body: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function postBytes(url: string, bytes: Uint8Array, apiKey: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/zip", Authorization: `Bearer ${apiKey}` },
    body: bytes,
  });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function claudeFile(suffix: string) {
  return {
    claudeAiOauth: {
      accessToken: `fake-claude-access-${suffix}`,
      refreshToken: `fake-claude-refresh-${suffix}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ["user:inference"],
    },
  };
}

function codexFile(accountId: string) {
  return {
    tokens: {
      id_token: fakeJwt({
        email: `${accountId}@example.com`,
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
      access_token: `fake-codex-access-${accountId}`,
      refresh_token: `fake-codex-refresh-${accountId}`,
    },
  };
}

/** The imported secrets must never come back in a response body. */
function assertNoTokens(body: unknown, ...secrets: string[]) {
  const text = JSON.stringify(body);
  for (const secret of secrets) assert.ok(!text.includes(secret), `response leaked ${secret}`);
  for (const field of ['"accessToken"', '"refreshToken"', '"idToken"', '"apiKey"']) {
    assert.ok(!text.includes(field), `response carries a ${field} field`);
  }
}

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  assert.equal(globalThis.fetch, stubFetch, "the network stub must be the live global fetch");
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "auth-import-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("import-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("import-readonly", "contract-test", ["read"])).key;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── auth ladder (all six) ────────────────────────────────────────────────────

const ROUTES = [
  ["claude-auth/import", claudeImport.POST],
  ["claude-auth/import-bulk", claudeBulk.POST],
  ["claude-auth/zip-extract", claudeZip.POST],
  ["codex-auth/import", codexImport.POST],
  ["codex-auth/import-bulk", codexBulk.POST],
  ["codex-auth/zip-extract", codexZip.POST],
] as const;

for (const [suffix, handler] of ROUTES) {
  it(`POST /api/providers/${suffix} answers 401 without a credential`, async () => {
    const response = await handler(post(`http://localhost/api/providers/${suffix}`, {}));
    assert.equal(response.status, 401);
  });

  it(`POST /api/providers/${suffix} answers 403 for a key without the manage scope`, async () => {
    const response = await handler(
      post(`http://localhost/api/providers/${suffix}`, {}, readOnlyKey)
    );
    assert.equal(response.status, 403);
  });
}

// ── /api/providers/claude-auth/import ────────────────────────────────────────

const CLAUDE_IMPORT = "http://localhost/api/providers/claude-auth/import";

it("POST claude-auth/import stores the connection, enriched, without echoing tokens", async () => {
  const response = await claudeImport.POST(
    post(CLAUDE_IMPORT, { source: { kind: "json", json: claudeFile("one") } }, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ connection: Connection; created: boolean }>(response);
  assert.equal(body.created, true);
  assert.equal(body.connection.provider, "claude");
  assert.equal(body.connection.authType, "oauth");
  assertNoTokens(body, "fake-claude-access-one", "fake-claude-refresh-one");
  assert.deepEqual(outboundCalls, [BOOTSTRAP_URL], "the bootstrap was served by the stub");
  assert.deepEqual(unexpectedCalls, []);
});

it("POST claude-auth/import accepts the file pasted as text", async () => {
  const callsBefore = outboundCalls.length;
  const response = await claudeImport.POST(
    post(
      CLAUDE_IMPORT,
      { source: { kind: "text", text: JSON.stringify(claudeFile("two")) }, name: "pasted" },
      manageKey
    )
  );
  assert.equal(response.status, 200);
  assertNoTokens(await readJson<unknown>(response), "fake-claude-access-two");
  assert.deepEqual(outboundCalls.slice(callsBefore), [BOOTSTRAP_URL]);
  assert.deepEqual(unexpectedCalls, []);
});

it("POST claude-auth/import answers 400 invalid_json for unparseable pasted text", async () => {
  const response = await claudeImport.POST(
    post(CLAUDE_IMPORT, { source: { kind: "text", text: "{ nope" } }, manageKey)
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<CodedError>(response)).code, "invalid_json");
});

it("POST claude-auth/import answers 400 missing_refresh_token for an incomplete file", async () => {
  const file = claudeFile("three");
  const response = await claudeImport.POST(
    post(
      CLAUDE_IMPORT,
      {
        source: {
          kind: "json",
          json: { claudeAiOauth: { accessToken: file.claudeAiOauth.accessToken } },
        },
      },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<CodedError>(response)).code, "missing_refresh_token");
});

it("POST claude-auth/import rejects an unknown source kind with a field-level 400", async () => {
  const response = await claudeImport.POST(
    post(CLAUDE_IMPORT, { source: { kind: "url", url: "https://x" } }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string }> } }>(response);
  assert.ok(body.error.details.some((detail) => detail.field.startsWith("source")));
});

// ── /api/providers/codex-auth/import ─────────────────────────────────────────

const CODEX_IMPORT = "http://localhost/api/providers/codex-auth/import";

it("POST codex-auth/import stores the connection without echoing tokens (no network)", async () => {
  const before = outboundCalls.length;
  const response = await codexImport.POST(
    post(CODEX_IMPORT, { source: { kind: "json", json: codexFile("acct-a") } }, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ connection: Connection; created: boolean }>(response);
  assert.equal(body.created, true);
  assert.equal(body.connection.provider, "codex");
  assertNoTokens(body, "fake-codex-access-acct-a", "fake-codex-refresh-acct-a");
  assert.equal(outboundCalls.length, before, "the Codex import makes no outbound request");
});

it("POST codex-auth/import answers 400 invalid_auth_file for a foreign auth_mode", async () => {
  const response = await codexImport.POST(
    post(
      CODEX_IMPORT,
      { source: { kind: "json", json: { ...codexFile("acct-b"), auth_mode: "apikey" } } },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<CodedError>(response)).code, "invalid_auth_file");
});

it("POST codex-auth/import answers 400 missing_id_token when id_token is absent", async () => {
  const file = codexFile("acct-c");
  const response = await codexImport.POST(
    post(
      CODEX_IMPORT,
      {
        source: {
          kind: "json",
          json: {
            tokens: {
              access_token: file.tokens.access_token,
              refresh_token: file.tokens.refresh_token,
            },
          },
        },
      },
      manageKey
    )
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<CodedError>(response)).code, "missing_id_token");
});

it("POST codex-auth/import rejects malformed JSON with 400", async () => {
  const response = await codexImport.POST(
    new Request(CODEX_IMPORT, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${manageKey}` },
      body: "{ nope",
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<{ error: string }>(response)).error, "Invalid JSON body");
});

// ── bulk imports ─────────────────────────────────────────────────────────────

it("POST claude-auth/import-bulk reports per-entry success and failure", async () => {
  const response = await claudeBulk.POST(
    post(
      "http://localhost/api/providers/claude-auth/import-bulk",
      {
        entries: [
          { json: claudeFile("bulk-1"), name: "good" },
          { json: { claudeAiOauth: {} }, name: "broken" },
        ],
      },
      manageKey
    )
  );
  assert.equal(response.status, 200);
  const body = await readJson<BulkResult>(response);
  assert.equal(body.total, 2);
  assert.equal(body.success, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.created.length, 1);
  assert.deepEqual(
    body.errors.map((error) => [error.index, error.name]),
    [[1, "broken"]]
  );
  assert.match(body.errors[0].message, /accessToken is missing/);
  assertNoTokens(body, "fake-claude-access-bulk-1", "fake-claude-refresh-bulk-1");
  assert.deepEqual(unexpectedCalls, []);
});

it("POST claude-auth/import-bulk rejects an empty entries array with 400", async () => {
  const response = await claudeBulk.POST(
    post("http://localhost/api/providers/claude-auth/import-bulk", { entries: [] }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ field: string; message: string }> } }>(
    response
  );
  assert.equal(body.error.details[0].field, "entries");
  assert.equal(body.error.details[0].message, "At least one entry is required");
});

it("POST codex-auth/import-bulk reports per-entry success and failure", async () => {
  const response = await codexBulk.POST(
    post(
      "http://localhost/api/providers/codex-auth/import-bulk",
      { entries: [{ json: codexFile("acct-bulk") }, { json: { tokens: {} } }] },
      manageKey
    )
  );
  assert.equal(response.status, 200);
  const body = await readJson<BulkResult>(response);
  assert.equal(body.total, 2);
  assert.equal(body.success, 1);
  assert.equal(body.failed, 1);
  assert.equal(body.errors[0].index, 1);
  assert.equal(body.errors[0].name, "entry 2", "unnamed entries are labelled by position");
  assertNoTokens(body, "fake-codex-access-acct-bulk");
});

it("POST codex-auth/import-bulk rejects more than 50 entries with 400", async () => {
  const entries = Array.from({ length: 51 }, () => ({ json: {} }));
  const response = await codexBulk.POST(
    post("http://localhost/api/providers/codex-auth/import-bulk", { entries }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<{ error: { details: Array<{ message: string }> } }>(response);
  assert.equal(body.error.details[0].message, "At most 50 entries per bulk import");
});

// ── zip-extract ──────────────────────────────────────────────────────────────

it("POST claude-auth/zip-extract lists each .json entry with its parsed content", async () => {
  const fixture = claudeFile("zip");
  const zip = zipSync({
    "a.json": strToU8(JSON.stringify(fixture)),
    "b.json": strToU8("not json"),
    "readme.txt": strToU8("ignored"),
  });
  const response = await claudeZip.POST(
    postBytes("http://localhost/api/providers/claude-auth/zip-extract", zip, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    entries: Array<{ name: string; json: unknown; parseError: string | null }>;
  }>(response);
  const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual([...byName.keys()].sort(), ["a.json", "b.json"], "non-.json files are skipped");
  assert.equal(byName.get("a.json")?.parseError, null);
  assert.deepEqual(byName.get("a.json")?.json, fixture, "entry content round-trips exactly");
  assert.equal(byName.get("b.json")?.parseError, "Not valid JSON");
  assert.equal(byName.get("b.json")?.json, null);
});

it("POST codex-auth/zip-extract answers 400 extract_failed for a non-ZIP body", async () => {
  const response = await codexZip.POST(
    postBytes(
      "http://localhost/api/providers/codex-auth/zip-extract",
      strToU8("definitely not a zip archive"),
      manageKey
    )
  );
  assert.equal(response.status, 400);
  assert.equal((await readJson<CodedError>(response)).code, "extract_failed");
});

it("POST claude-auth/zip-extract answers 400 extract_failed for a ZIP without .json", async () => {
  const response = await claudeZip.POST(
    postBytes(
      "http://localhost/api/providers/claude-auth/zip-extract",
      zipSync({ "notes.txt": strToU8("hi") }),
      manageKey
    )
  );
  assert.equal(response.status, 400);
  const body = await readJson<CodedError>(response);
  assert.equal(body.code, "extract_failed");
  assert.match(body.error, /no \.json files/);
});

it("POST codex-auth/zip-extract answers 413 file_too_large from Content-Length", async () => {
  const response = await codexZip.POST(
    new Request("http://localhost/api/providers/codex-auth/zip-extract", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "content-length": String(12 * 1024 * 1024),
        Authorization: `Bearer ${manageKey}`,
      },
      body: strToU8("x"),
    })
  );
  assert.equal(response.status, 413);
  assert.equal((await readJson<CodedError>(response)).code, "file_too_large");
});
