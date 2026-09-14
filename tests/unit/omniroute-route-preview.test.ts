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
