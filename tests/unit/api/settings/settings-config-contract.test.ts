// Contract tests for the mutating /api/settings configuration routes.
//
// Covers /api/settings/ip-filter, /api/settings/system-prompt and
// /api/settings/thinking-budget — all three PUT routes that change how the
// gateway treats live traffic, all three guarded by `requireManagementAuth`
// and validated by a `.strict()` Zod schema.
//
// Contract under test: the auth ladder (401 anonymous / 403 under-scoped /
// 200 manage), the GET config envelope, the read-back of a PUT, and the three
// distinct 400 bodies (malformed JSON, empty update, unrecognized key).
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-config-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "settings-config-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const ipFilterRoute = await import("../../../../src/app/api/settings/ip-filter/route.ts");
const systemPromptRoute = await import("../../../../src/app/api/settings/system-prompt/route.ts");
const thinkingBudgetRoute =
  await import("../../../../src/app/api/settings/thinking-budget/route.ts");

type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string; keys?: string[] }> };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function get(url: string, apiKey?: string): Request {
  return new Request(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
}

function put(url: string, body: unknown, apiKey?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return new Request(url, { method: "PUT", headers, body: JSON.stringify(body) });
}

function putRaw(url: string, body: string, apiKey: string): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body,
  });
}

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "settings-config-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("settings-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("settings-readonly", "contract-test", ["read"])).key;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── /api/settings/ip-filter ──────────────────────────────────────────────────

const IP_FILTER_URL = "http://localhost/api/settings/ip-filter";

it("GET /api/settings/ip-filter answers 401 without a credential", async () => {
  const response = await ipFilterRoute.GET(get(IP_FILTER_URL));
  assert.equal(response.status, 401);
  assert.equal(
    (await readJson<{ error: { message: string } }>(response)).error.message,
    "Authentication required"
  );
});

it("PUT /api/settings/ip-filter answers 403 for a key without the manage scope", async () => {
  const response = await ipFilterRoute.PUT(put(IP_FILTER_URL, { enabled: true }, readOnlyKey));
  assert.equal(response.status, 403);
});

it("GET /api/settings/ip-filter returns the full filter config envelope", async () => {
  const response = await ipFilterRoute.GET(get(IP_FILTER_URL, manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{
    enabled: boolean;
    mode: string;
    blacklist: string[];
    whitelist: string[];
    tempBans: unknown[];
  }>(response);
  assert.equal(typeof body.enabled, "boolean");
  assert.ok(["blacklist", "whitelist"].includes(body.mode));
  assert.ok(Array.isArray(body.blacklist));
  assert.ok(Array.isArray(body.whitelist));
  assert.ok(Array.isArray(body.tempBans));
});

it("PUT /api/settings/ip-filter applies a blacklist entry and reads it back", async () => {
  const response = await ipFilterRoute.PUT(
    put(IP_FILTER_URL, { enabled: true, mode: "blacklist", addBlacklist: "203.0.113.7" }, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ enabled: boolean; mode: string; blacklist: string[] }>(response);
  assert.equal(body.enabled, true);
  assert.equal(body.mode, "blacklist");
  assert.ok(body.blacklist.includes("203.0.113.7"));

  const removed = await ipFilterRoute.PUT(
    put(IP_FILTER_URL, { removeBlacklist: "203.0.113.7" }, manageKey)
  );
  assert.equal(removed.status, 200);
  assert.ok(!(await readJson<{ blacklist: string[] }>(removed)).blacklist.includes("203.0.113.7"));
});

it("PUT /api/settings/ip-filter rejects malformed JSON with a field-level 400", async () => {
  const response = await ipFilterRoute.PUT(putRaw(IP_FILTER_URL, "{ not json", manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.deepEqual(body.error.details, [{ field: "body", message: "Invalid JSON body" }]);
});

it("PUT /api/settings/ip-filter rejects an empty update with 400", async () => {
  const response = await ipFilterRoute.PUT(put(IP_FILTER_URL, {}, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.details[0].message, "No valid fields to update");
});

it("PUT /api/settings/ip-filter names an unrecognized key in the 400 body", async () => {
  const response = await ipFilterRoute.PUT(put(IP_FILTER_URL, { enabledd: true }, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.ok(
    body.error.details.some((detail) => detail.keys?.includes("enabledd")),
    "the rejected key is reported back to the caller"
  );
});

// ── /api/settings/system-prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT_URL = "http://localhost/api/settings/system-prompt";

it("GET /api/settings/system-prompt answers 401 without a credential", async () => {
  const response = await systemPromptRoute.GET(get(SYSTEM_PROMPT_URL));
  assert.equal(response.status, 401);
});

it("PUT /api/settings/system-prompt answers 403 for a key without the manage scope", async () => {
  const response = await systemPromptRoute.PUT(
    put(SYSTEM_PROMPT_URL, { enabled: true }, readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("PUT /api/settings/system-prompt persists the prompt and GET reads it back", async () => {
  const response = await systemPromptRoute.PUT(
    put(
      SYSTEM_PROMPT_URL,
      { enabled: true, prefixPrompt: "be brief", suffixPrompt: "cite sources" },
      manageKey
    )
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    enabled: boolean;
    prefixPrompt: string;
    suffixPrompt: string;
  }>(response);
  assert.equal(body.enabled, true);
  assert.equal(body.prefixPrompt, "be brief");
  assert.equal(body.suffixPrompt, "cite sources");

  const read = await systemPromptRoute.GET(get(SYSTEM_PROMPT_URL, manageKey));
  assert.equal(read.status, 200);
  assert.deepEqual(await readJson<unknown>(read), body);

  const persisted = await settingsDb.getSettings();
  assert.equal(
    (persisted.systemPrompt as { prefixPrompt?: string } | undefined)?.prefixPrompt,
    "be brief",
    "the PUT is written through to the settings row"
  );
});

it("PUT /api/settings/system-prompt rejects an empty update with 400", async () => {
  const response = await systemPromptRoute.PUT(put(SYSTEM_PROMPT_URL, {}, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.details[0].message, "No valid fields to update");
});

it("PUT /api/settings/system-prompt rejects an over-long prompt with 400", async () => {
  const response = await systemPromptRoute.PUT(
    put(SYSTEM_PROMPT_URL, { prefixPrompt: "x".repeat(50001) }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["prefixPrompt"]
  );
});

// ── /api/settings/thinking-budget ────────────────────────────────────────────

const THINKING_BUDGET_URL = "http://localhost/api/settings/thinking-budget";

it("GET /api/settings/thinking-budget answers 401 without a credential", async () => {
  const response = await thinkingBudgetRoute.GET(get(THINKING_BUDGET_URL));
  assert.equal(response.status, 401);
});

it("PUT /api/settings/thinking-budget answers 403 for a key without the manage scope", async () => {
  const response = await thinkingBudgetRoute.PUT(
    put(THINKING_BUDGET_URL, { mode: "auto" }, readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("PUT /api/settings/thinking-budget persists the mode and GET reads it back", async () => {
  const response = await thinkingBudgetRoute.PUT(
    put(THINKING_BUDGET_URL, { mode: "custom", customBudget: 4096 }, manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ mode: string; customBudget: number }>(response);
  assert.equal(body.mode, "custom");
  assert.equal(body.customBudget, 4096);

  const read = await thinkingBudgetRoute.GET(get(THINKING_BUDGET_URL, manageKey));
  assert.equal(read.status, 200);
  const current = await readJson<{ mode: string; customBudget: number }>(read);
  assert.equal(current.mode, "custom");
  assert.equal(current.customBudget, 4096);
});

it("PUT /api/settings/thinking-budget rejects an unknown mode with 400", async () => {
  const response = await thinkingBudgetRoute.PUT(
    put(THINKING_BUDGET_URL, { mode: "turbo" }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["mode"]
  );
});

it("PUT /api/settings/thinking-budget rejects a budget above the cap with 400", async () => {
  const response = await thinkingBudgetRoute.PUT(
    put(THINKING_BUDGET_URL, { customBudget: 131073 }, manageKey)
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["customBudget"]
  );
});

it("PUT /api/settings/thinking-budget rejects an empty update with 400", async () => {
  const response = await thinkingBudgetRoute.PUT(put(THINKING_BUDGET_URL, {}, manageKey));
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.details[0].message, "No valid fields to update");
});
