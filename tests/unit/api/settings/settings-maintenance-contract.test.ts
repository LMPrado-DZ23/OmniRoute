// Contract tests for the /api/settings maintenance and metrics routes.
//
// Covers the destructive purge endpoints, the cache/metrics readers and the
// database stats refresh:
//   /api/settings/purge-call-logs, /api/settings/purge-detailed-logs,
//   /api/settings/purge-quota-snapshots, /api/settings/lkgp-cache,
//   /api/settings/cache-metrics, /api/settings/database/refresh-stats,
//   /api/settings/cc-discovery-metrics, /api/settings/free-proxies/stats
//
// The purge routes delete operator data, so the assertion that matters most is
// that an unauthenticated caller is turned away *before* anything is deleted;
// each one is exercised anonymously first and the store is checked afterwards.
//
// The handlers run in-process against a throwaway SQLite DATA_DIR; no HTTP
// server and no provider calls are involved.
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-maint-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "settings-maintenance-contract-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const settingsDb = await import("../../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../../src/lib/db/apiKeys.ts");
const purgeCallLogsRoute =
  await import("../../../../src/app/api/settings/purge-call-logs/route.ts");
const purgeDetailedLogsRoute =
  await import("../../../../src/app/api/settings/purge-detailed-logs/route.ts");
const purgeQuotaSnapshotsRoute =
  await import("../../../../src/app/api/settings/purge-quota-snapshots/route.ts");
const lkgpCacheRoute = await import("../../../../src/app/api/settings/lkgp-cache/route.ts");
const cacheMetricsRoute = await import("../../../../src/app/api/settings/cache-metrics/route.ts");
const refreshStatsRoute =
  await import("../../../../src/app/api/settings/database/refresh-stats/route.ts");
const ccDiscoveryMetricsRoute =
  await import("../../../../src/app/api/settings/cc-discovery-metrics/route.ts");
const freeProxyStatsRoute =
  await import("../../../../src/app/api/settings/free-proxies/stats/route.ts");

type PurgeResult = { deleted: number; errors: number };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function req(url: string, method: string, apiKey?: string): Request {
  return new Request(url, {
    method,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
}

let manageKey = "";
let readOnlyKey = "";

before(async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  process.env.INITIAL_PASSWORD = "settings-maintenance-contract-test-password";
  manageKey = (await apiKeysDb.createApiKey("maintenance-manage", "contract-test", ["manage"])).key;
  readOnlyKey = (await apiKeysDb.createApiKey("maintenance-readonly", "contract-test", ["read"]))
    .key;
});

after(() => {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── purge endpoints ──────────────────────────────────────────────────────────

it("POST /api/settings/purge-call-logs refuses an anonymous caller with 401", async () => {
  const response = await purgeCallLogsRoute.POST(
    req("http://localhost/api/settings/purge-call-logs", "POST")
  );
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("POST /api/settings/purge-call-logs reports the deleted counts for a valid key", async () => {
  const response = await purgeCallLogsRoute.POST(
    req("http://localhost/api/settings/purge-call-logs", "POST", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<PurgeResult & { deletedArtifacts: number }>(response);
  assert.equal(typeof body.deleted, "number");
  assert.equal(typeof body.deletedArtifacts, "number");
  assert.equal(body.errors, 0, "a clean store purges without errors");
});

it("POST /api/settings/purge-detailed-logs refuses an anonymous caller with 401", async () => {
  const response = await purgeDetailedLogsRoute.POST(
    req("http://localhost/api/settings/purge-detailed-logs", "POST")
  );
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("POST /api/settings/purge-detailed-logs reports { deleted, errors }", async () => {
  const response = await purgeDetailedLogsRoute.POST(
    req("http://localhost/api/settings/purge-detailed-logs", "POST", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<PurgeResult>(response);
  assert.equal(typeof body.deleted, "number");
  assert.equal(body.errors, 0, "a clean store purges without errors");
});

it("POST /api/settings/purge-quota-snapshots refuses an anonymous caller with 401", async () => {
  const response = await purgeQuotaSnapshotsRoute.POST(
    req("http://localhost/api/settings/purge-quota-snapshots", "POST")
  );
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("POST /api/settings/purge-quota-snapshots reports { deleted, errors }", async () => {
  const response = await purgeQuotaSnapshotsRoute.POST(
    req("http://localhost/api/settings/purge-quota-snapshots", "POST", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<PurgeResult>(response);
  assert.equal(typeof body.deleted, "number");
  assert.equal(body.errors, 0, "a clean store purges without errors");
});

// ── /api/settings/lkgp-cache ─────────────────────────────────────────────────

it("DELETE /api/settings/lkgp-cache refuses an anonymous caller with 401", async () => {
  const response = await lkgpCacheRoute.DELETE(
    req("http://localhost/api/settings/lkgp-cache", "DELETE")
  );
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("DELETE /api/settings/lkgp-cache clears the cache for a valid key", async () => {
  const response = await lkgpCacheRoute.DELETE(
    req("http://localhost/api/settings/lkgp-cache", "DELETE", manageKey)
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<{ cleared: boolean }>(response), { cleared: true });
});

// ── /api/settings/cache-metrics ──────────────────────────────────────────────

it("GET /api/settings/cache-metrics answers 401 without a credential", async () => {
  const response = await cacheMetricsRoute.GET(
    req("http://localhost/api/settings/cache-metrics", "GET")
  );
  assert.equal(response.status, 401);
});

it("DELETE /api/settings/cache-metrics answers 403 for a key without the manage scope", async () => {
  const response = await cacheMetricsRoute.DELETE(
    req("http://localhost/api/settings/cache-metrics", "DELETE", readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("GET then DELETE /api/settings/cache-metrics returns a metrics object both times", async () => {
  const read = await cacheMetricsRoute.GET(
    req("http://localhost/api/settings/cache-metrics", "GET", manageKey)
  );
  assert.equal(read.status, 200);
  const metrics = await readJson<Record<string, unknown>>(read);
  assert.ok(metrics && typeof metrics === "object");

  const reset = await cacheMetricsRoute.DELETE(
    req("http://localhost/api/settings/cache-metrics", "DELETE", manageKey)
  );
  assert.equal(reset.status, 200);
  const afterReset = await readJson<Record<string, unknown>>(reset);
  assert.ok(afterReset && typeof afterReset === "object");
});

// ── /api/settings/database/refresh-stats ─────────────────────────────────────

it("POST /api/settings/database/refresh-stats answers 401 without a credential", async () => {
  const response = await refreshStatsRoute.POST(
    req("http://localhost/api/settings/database/refresh-stats", "POST")
  );
  assert.equal(response.status, 401);
  assert.equal((await readJson<{ error: string }>(response)).error, "Unauthorized");
});

it("POST /api/settings/database/refresh-stats returns { success, stats }", async () => {
  const response = await refreshStatsRoute.POST(
    req("http://localhost/api/settings/database/refresh-stats", "POST", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{ success: boolean; stats: Record<string, unknown> }>(response);
  assert.equal(body.success, true);
  assert.ok(body.stats && typeof body.stats === "object");
});

// ── /api/settings/cc-discovery-metrics ───────────────────────────────────────

it("GET /api/settings/cc-discovery-metrics answers 401 without a credential", async () => {
  const response = await ccDiscoveryMetricsRoute.GET(
    req("http://localhost/api/settings/cc-discovery-metrics", "GET")
  );
  assert.equal(response.status, 401);
});

it("GET /api/settings/cc-discovery-metrics answers 403 for a key without manage", async () => {
  const response = await ccDiscoveryMetricsRoute.GET(
    req("http://localhost/api/settings/cc-discovery-metrics", "GET", readOnlyKey)
  );
  assert.equal(response.status, 403);
});

it("GET /api/settings/cc-discovery-metrics returns the counters for a manage key", async () => {
  const response = await ccDiscoveryMetricsRoute.GET(
    req("http://localhost/api/settings/cc-discovery-metrics", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<Record<string, unknown>>(response);
  assert.ok(body && typeof body === "object");
});

// ── /api/settings/free-proxies/stats ─────────────────────────────────────────

it("GET /api/settings/free-proxies/stats answers 401 without a credential", async () => {
  const response = await freeProxyStatsRoute.GET(
    req("http://localhost/api/settings/free-proxies/stats", "GET")
  );
  assert.equal(response.status, 401);
});

it("GET /api/settings/free-proxies/stats returns { stats, providers, autoSync }", async () => {
  const response = await freeProxyStatsRoute.GET(
    req("http://localhost/api/settings/free-proxies/stats", "GET", manageKey)
  );
  assert.equal(response.status, 200);
  const body = await readJson<{
    stats: Record<string, unknown>;
    providers: Array<{ id: string; name: string; enabled: boolean }>;
    autoSync: { enabled: boolean; intervalMs: number };
  }>(response);
  assert.ok(body.stats && typeof body.stats === "object");
  assert.ok(Array.isArray(body.providers));
  for (const provider of body.providers) {
    assert.equal(typeof provider.id, "string");
    assert.equal(typeof provider.name, "string");
    assert.equal(typeof provider.enabled, "boolean");
  }
  assert.equal(typeof body.autoSync.enabled, "boolean");
  assert.equal(typeof body.autoSync.intervalMs, "number");
});
