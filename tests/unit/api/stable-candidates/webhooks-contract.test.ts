// Contract tests for GET /api/webhooks and POST /api/webhooks — operations an
// external client depends on and candidates for promotion to `stable`.
//
// Contract under test: the requireManagementAuth ladder, the { webhooks, total }
// listing with the signing secret masked, pagination via limit/offset, 201 on
// create, and the 400 bodies (unknown event, private/SSRF URL, telegram without
// storage encryption). Creating a webhook stores a row; nothing is delivered,
// so no outbound request is ever made.
//
// These tests do NOT change any operation's `x-stability`; promotion is a
// separate decision.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-webhooks-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "webhooks-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
delete process.env.STORAGE_ENCRYPTION_KEY;

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const webhooksRoute = await import("../../../../src/app/api/webhooks/route.ts");

type WebhookShape = {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  description: string;
  kind: string;
  enabled: boolean;
};
type ValidationErrorBody = {
  error: { message: string; details: Array<{ field: string; message: string }> };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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

const URL_BASE = "http://localhost/api/webhooks";
const SIGNING_SECRET = "whsec_contract_0123456789abcdef";

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "webhooks-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("webhooks-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("webhooks-readonly", "contract-test", ["read"])).key;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("GET /api/webhooks answers 401 without a credential", async () => {
  const response = await webhooksRoute.GET(req(URL_BASE));
  assert.equal(response.status, 401);
});

it("POST /api/webhooks answers 403 for a key without the manage scope", async () => {
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", readOnlyKey, { url: "https://hooks.example.com/a" })
  );
  assert.equal(response.status, 403);
});

it("GET /api/webhooks returns an empty { webhooks, total } on a fresh install", async () => {
  const response = await webhooksRoute.GET(req(URL_BASE, "GET", manageKey));
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<unknown>(response), { webhooks: [], total: 0 });
});

it("POST /api/webhooks answers 201 with the created webhook and its defaults", async () => {
  // Spec note: docs/openapi.yaml documents only a `200` for this operation; the
  // handler answers `201`. Pinned here and reported as a promotion caveat.
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", manageKey, {
      url: "https://hooks.example.com/omniroute",
      secret: SIGNING_SECRET,
      events: ["request.failed"],
      description: "contract",
    })
  );
  assert.equal(response.status, 201);
  const { webhook } = await readJson<{ webhook: WebhookShape }>(response);
  assert.equal(typeof webhook.id, "string");
  assert.equal(webhook.url, "https://hooks.example.com/omniroute");
  assert.deepEqual(webhook.events, ["request.failed"]);
  assert.equal(webhook.kind, "custom", "kind defaults to custom");
  assert.equal(webhook.enabled, true, "enabled defaults to true");
});

it("POST /api/webhooks defaults events to the wildcard", async () => {
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", manageKey, { url: "https://hooks.example.com/all" })
  );
  assert.equal(response.status, 201);
  const { webhook } = await readJson<{ webhook: WebhookShape }>(response);
  assert.deepEqual(webhook.events, ["*"]);
});

it("GET /api/webhooks lists created webhooks with the secret masked", async () => {
  const response = await webhooksRoute.GET(req(URL_BASE, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{ webhooks: WebhookShape[]; total: number }>(response);
  assert.equal(body.total, 2);
  assert.equal(body.webhooks.length, 2);

  const signed = body.webhooks.find((w) => w.url === "https://hooks.example.com/omniroute");
  assert.ok(signed);
  assert.equal(signed.secret, `${SIGNING_SECRET.slice(0, 10)}...`);
  assert.ok(!JSON.stringify(body).includes(SIGNING_SECRET), "the full secret is never listed");

  // A webhook created without a secret gets a generated `whsec_` signing secret,
  // which is masked in the listing exactly like a caller-supplied one.
  const generated = body.webhooks.find((w) => w.url === "https://hooks.example.com/all");
  assert.ok(generated);
  assert.match(generated.secret ?? "", /^whsec_.{4}\.\.\.$/);
});

it("GET /api/webhooks honours limit/offset while total stays the full count", async () => {
  const response = await webhooksRoute.GET(req(`${URL_BASE}?limit=1&offset=1`, "GET", manageKey));
  assert.equal(response.status, 200);
  const body = await readJson<{ webhooks: WebhookShape[]; total: number }>(response);
  assert.equal(body.webhooks.length, 1);
  assert.equal(body.total, 2);
});

it("POST /api/webhooks rejects an unknown event name with a field-level 400", async () => {
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", manageKey, {
      url: "https://hooks.example.com/x",
      events: ["request.exploded"],
    })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.equal(body.error.message, "Invalid request");
  assert.ok(body.error.details.some((detail) => detail.field.startsWith("events")));
});

it("POST /api/webhooks refuses a private-network URL (SSRF guard) with 400", async () => {
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", manageKey, { url: "http://169.254.169.254/latest/meta-data" })
  );
  assert.equal(response.status, 400);
  const body = await readJson<ValidationErrorBody>(response);
  assert.deepEqual(
    body.error.details.map((detail) => detail.field),
    ["url"]
  );

  const listed = await readJson<{ total: number }>(
    await webhooksRoute.GET(req(URL_BASE, "GET", manageKey))
  );
  assert.equal(listed.total, 2, "a refused webhook is never persisted");
});

it("POST /api/webhooks refuses a telegram webhook without storage encryption", async () => {
  const response = await webhooksRoute.POST(
    req(URL_BASE, "POST", manageKey, {
      url: "telegram://bot",
      kind: "telegram",
      metadata: { chatId: "1" },
    })
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<{ error: string }>(response)).error,
    "Telegram webhooks require STORAGE_ENCRYPTION_KEY to be configured"
  );
});
