/**
 * POST /api/omniroute/route/preview validated `{ candidates: [...] }` and then called
 * rankCandidates(parsed.data), passing the whole body object instead of the candidate array. Every
 * valid request therefore threw inside the ranking and failed with a server error. A valid preview
 * must return 200 with the ranked result and the selected provider, without any live request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-route-preview-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { POST } = await import("../../src/app/api/omniroute/route/preview/route.ts");

const originalFetch = globalThis.fetch;
let externalCalls = 0;

test.before(() => {
  globalThis.fetch = (async () => {
    externalCalls += 1;
    throw new Error("route preview must not call any upstream");
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const healthy = {
  capabilityScore: 0.9,
  healthScore: 1,
  circuit: "closed",
  quota: "healthy",
  latencyMs: 200,
  errorRate: 0,
};

test("a valid preview returns 200 and selects the allowed candidate", async () => {
  const res = await POST(
    new Request("http://localhost/api/omniroute/route/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidates: [
          { providerId: "provider-denied", modelId: "model-x", allocation: "deny", ...healthy },
          { providerId: "provider-allowed", modelId: "model-x", allocation: "allow", ...healthy },
        ],
      }),
    })
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    request?: { candidateCount?: number };
    selected?: string | null;
    liveRequestExecuted?: boolean;
  };
  assert.equal(body.request?.candidateCount, 2);
  assert.equal(body.selected, "provider-allowed");
  assert.equal(body.liveRequestExecuted, false);
  assert.equal(externalCalls, 0);
});

test("an invalid preview body is still rejected with 400", async () => {
  const res = await POST(
    new Request("http://localhost/api/omniroute/route/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: [] }),
    })
  );
  assert.equal(res.status, 400);
});

async function previewError(body: string) {
  const res = await POST(
    new Request("http://localhost/api/omniroute/route/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error?: unknown };
  assert.equal(typeof json.error, "string");
  return json.error as string;
}

test("a 400 names the invalid fields in a readable string, not a JSON dump", async () => {
  const missing = await previewError("{}");
  assert.match(missing, /^Invalid route preview request: candidates: /);
  assert.equal(missing.includes("\n"), false);
  assert.equal(missing.includes('"path"'), false);
  assert.throws(() => JSON.parse(missing), SyntaxError, "not a serialized issue list");

  const auto = await previewError(
    JSON.stringify({ engine: "auto", candidates: [{ provider: "alpha", model: "m" }] })
  );
  assert.match(auto, /candidates\.0\.costPer1MTokens: /);
  assert.match(auto, /candidates\.0\.p95LatencyMs: /);
});

test("a body that is not a JSON object gets a clear 400", async () => {
  assert.equal(
    await previewError("not json"),
    "Invalid route preview request: the body must be a JSON object"
  );
  assert.equal(
    await previewError("[1, 2]"),
    "Invalid route preview request: the body must be a JSON object"
  );
});
