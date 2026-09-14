/**
 * After a successful Cursor login, POST /api/oauth/cursor/login/poll syncs to the cloud when cloud
 * sync is enabled. It called syncToCloud() without the machine id, so the sync request went to
 * `${CLOUD_URL}/sync/undefined` instead of this machine's endpoint. The sync must target the
 * machine id the route already computed for the new connection.
 *
 * No real network: a fetch stub serves the Cursor auth poll and records the cloud sync URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cursor-poll-cloud-sync-"));
const CLOUD_URL = "http://cloud.example.test";
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CLOUD_URL = CLOUD_URL;
process.env.API_KEY_SECRET = "test-api-key-secret-cursor-poll";

const core = await import("../../src/lib/db/core.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { createCursorLoginSession, clearCursorLoginSessions } =
  await import("../../src/lib/oauth/services/cursorLogin.ts");
const { getConsistentMachineId } = await import("../../src/shared/utils/machineId.ts");
const { POST } = await import("../../src/app/api/oauth/cursor/login/poll/route.ts");

const originalFetch = globalThis.fetch;
const syncUrls: string[] = [];

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function fakeJwt(sub: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify({ sub, exp }))}.signature`;
}

test.before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api2.cursor.sh/auth/poll")) {
      return new Response(
        JSON.stringify({
          accessToken: fakeJwt("cursor-user-1"),
          refreshToken: fakeJwt("cursor-user-1"),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.startsWith(`${CLOUD_URL}/sync/`)) {
      syncUrls.push(url);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in cursor poll test: ${url}`);
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  clearCursorLoginSessions();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a successful login syncs to the cloud endpoint of this machine", async () => {
  await updateSettings({ cloudEnabled: true });
  const { sessionId } = createCursorLoginSession({
    verifier: "test-verifier",
    challenge: "test-challenge",
    uuid: "test-uuid",
    loginUrl: "https://cursor.com/loginDeepControl?test=1",
  });

  const res = await POST(
    new Request("http://localhost/api/oauth/cursor/login/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
  );
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { status?: string };
  assert.equal(body.status, "ok");

  const machineId = await getConsistentMachineId();
  assert.equal(
    syncUrls.length,
    1,
    `expected one cloud sync request, got ${JSON.stringify(syncUrls)}`
  );
  assert.equal(syncUrls[0], `${CLOUD_URL}/sync/${machineId}`);
});
