/**
 * POST /api/copilot/chat answered an invalid body with buildErrorBody(400, validation.error). That
 * passes the whole `{ message, details }` validation object where a message string is expected, so
 * the client never learned which field was wrong. The 400 must carry a readable message that names
 * the offending field, as other single-message routes do (#10849).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-copilot-chat-validation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { POST } = await import("../../src/app/api/copilot/chat/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function postJson(body: unknown) {
  return POST(
    new Request("http://localhost/api/copilot/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

test("an invalid body gets a 400 whose message names the offending field", async () => {
  const res = await postJson({});
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { message?: unknown } };
  const message = body.error?.message;

  assert.equal(typeof message, "string");
  assert.notEqual(message, "[object Object]");
  assert.match(String(message), /^messages\b/, `expected a field-specific message, got ${message}`);
});
