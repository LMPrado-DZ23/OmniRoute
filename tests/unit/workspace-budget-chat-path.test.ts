/**
 * Which runtime paths actually enforce the project / workspace budget.
 *
 * The hierarchy is enforced inside `enforceApiKeyPolicy` (`validateBudget` in
 * `src/shared/utils/apiKeyPolicy.ts`), so it covers exactly the requests that run that gate:
 * the 22 `/v1` routes that call it directly AND the chat family, because `handleChat`
 * (`src/sse/handlers/chat.ts`) calls `enforceApiKeyPolicy` before any dispatch — the
 * downstream `open-sse/handlers/chatCore.ts` only records spend (`recordCost`), it never
 * checks it.
 *
 * This file pins that fact from the outside: a real `POST /v1/chat/completions` body through
 * `handleChat` with an exhausted workspace is refused with 429 before any upstream call, and
 * the same request with a key outside any workspace is not refused by the budget gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-workspace-chat-path-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "workspace-chat-path-api-key-secret";
process.env.APP_LOG_TO_FILE = "false";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const workspacesDb = await import("../../src/lib/db/workspaces.ts");
const costRules = await import("../../src/domain/costRules.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../open-sse/translator/index.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");

// After every import: open-sse's proxyFetch replaces globalThis.fetch at import time.
const { blockOutboundFetch } = await import("./_helpers/blockOutboundFetch.ts");
const network = blockOutboundFetch();

const MODEL = "openai/gpt-4o-mini";
const keys = { exhausted: "", free: "" };

function chatRequest(secret: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
}

test.before(async () => {
  assert.ok(network.isLive(), "the throwing fetch stub must be the live globalThis.fetch");
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  rateLimiter.setRateLimiterTestMode(true);
  initTranslators();

  const exhausted = await apiKeysDb.createApiKey("chat-path-exhausted", "machine-chat-01", []);
  const free = await apiKeysDb.createApiKey("chat-path-free", "machine-chat-01", []);
  keys.exhausted = exhausted.key;
  keys.free = free.key;

  const workspace = workspacesDb.createWorkspace(
    { name: "chat-path", budget: { limitUsd: 5, interval: "monthly", warningThreshold: 0.8 } },
    "owner",
    null
  );
  const project = workspacesDb.createProject(workspace.id, { name: "p" });
  workspacesDb.setProjectApiKeys(project.id, [exhausted.id]);
  costRules.recordCost(exhausted.id, 5); // spend AT the workspace limit -> deny
});

test.after(() => {
  rateLimiter.setRateLimiterTestMode(false);
  costRules.resetCostData();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST /v1/chat/completions is refused when the caller's WORKSPACE is exhausted", async () => {
  const response = await handleChat(chatRequest(keys.exhausted), null, null);
  assert.equal(response.status, 429);
  const body = await response.text();
  assert.match(body, /Workspace internal budget exhausted/);
  assert.deepEqual(network.attempts, [], "refused before any upstream call");
});

test("the same request with a key outside every workspace is not refused by the budget gate", async () => {
  const response = await handleChat(chatRequest(keys.free), null, null);
  const body = await response.text();
  assert.doesNotMatch(body, /budget exhausted/i);
  assert.ok(
    response.status !== 429 || !/Workspace internal budget/.test(body),
    `unexpected budget rejection: ${response.status} ${body.slice(0, 200)}`
  );
});

test("no outbound network request was attempted", () => {
  assert.deepEqual(network.attempts, []);
});
