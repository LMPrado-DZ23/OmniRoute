/**
 * tests/unit/serial/9147-catalog-eventloop-yield.test.ts
 *
 * Lives in the serial bucket (`--test-concurrency=1`, the #6803 convention) because it
 * measures how long the catalog builder holds the event loop. Three sibling test files
 * sharing one runner at `--test-concurrency=4` starve this file's own timer loop, so a
 * perfectly cooperative builder still records long gaps and the number stops meaning
 * what the assertion says it means. Serially, the gap is the builder's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9147-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-9147-test-secret";
// This test deliberately builds a catalog far larger than any real one (720 models) and
// measures how the builder yields while doing it. The cold-path coalescing bound in
// catalogCache.ts defaults to 8 s, and on a GitHub-hosted shard at --test-concurrency=4
// the build crossed it (8349 ms on run 34690758019, shard 1/4): the wait rejected with
// `catalog_build_timeout`, a cold cache has no last-good body to fall back to, and the
// endpoint answered 500 — failing this test on a bound it does not measure. That bound
// and its last-good fallback have their own coverage in 12627-catalog-inflight-timeout.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");

// Hermetic outbound layer — installed AFTER every import (proxyFetch replaces
// globalThis.fetch at import time). See tests/unit/_helpers/offlineOutbound.ts.
await (await import("../_helpers/offlineOutbound.ts")).installOfflineOutbound();

const CONNECTION_COUNT = 60;
const MODELS_PER_CONNECTION = 12; // ~720 synced models total

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedCatalogScaleDataset() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insertConn = db.prepare(
    `INSERT INTO provider_connections (id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at)
     VALUES (?, 'openai-compatible', 'apikey', ?, ?, 1, ?, ?, ?)`
  );
  const insertModels = db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)`
  );
  const seedTx = db.transaction(() => {
    for (let i = 0; i < CONNECTION_COUNT; i++) {
      const id = `probe-conn-${i}`;
      insertConn.run(id, `probe-connection-${i}`, i, `sk-probe-${i}`, now, now);
      const models = Array.from({ length: MODELS_PER_CONNECTION }, (_, m) => ({
        id: `probe-model-${i}-${m}`,
        name: `Probe Model ${i}-${m}`,
        contextLength: 128000,
      }));
      insertModels.run(`openai-compatible:${id}`, JSON.stringify(models));
    }
  });
  seedTx();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#9147 — catalog build at catalog-scale must not pin the event loop for a long stretch", async (t) => {
  await seedCatalogScaleDataset();
  const req = new Request("http://localhost/v1/models");
  let settled = false;
  const buildPromise = v1ModelsCatalog.getUnifiedModelsResponse(req).then((res) => {
    settled = true;
    return res;
  });
  let lastTick = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks++;
    if (ticks > 20000) break;
  }
  const res = await buildPromise;
  // A non-200 here is a build failure, not a timing failure, and the sanitized body
  // carries the reason. Without it a hosted shard reports only `500 !== 200` and the
  // cause has to be guessed (2026-09-12, shard 1/4).
  const failureBody = res.status === 200 ? "" : await res.clone().text();
  assert.equal(res.status, 200, `catalog build failed: ${res.status} ${failureBody}`);
  t.diagnostic(
    `maximum event-loop gap: ${maxGapMs.toFixed(1)}ms across ${ticks} interleaved ticks`
  );
  // History of this bound, all of it driven by shard contention rather than the builder:
  // 150ms was tight on GitHub-hosted shards at `--test-concurrency=4` (a healthy builder
  // recorded 200–260ms; observed 252.5ms on run 32494847431), so it went to 400ms, then
  // to 800ms on 2026-08-30 when the catalog reached 352 providers and the hosted shards
  // measured 410–633ms (runs 33325191658, 33327592128, 33328119934).
  // 2026-09-12: the file moved to the serial bucket, so sibling processes no longer
  // starve the timer loop and the gap is the builder's alone. The bound stays at 800ms
  // until serial hosted numbers are on record; tighten it against those, not a guess.
  assert.ok(
    maxGapMs < 800,
    `event loop was blocked for ${maxGapMs.toFixed(1)}ms in a single stretch while building the ` +
      `catalog for ${CONNECTION_COUNT} connections / ${CONNECTION_COUNT * MODELS_PER_CONNECTION} models ` +
      `(${ticks} interleaved ticks observed) — the builder is not yielding to the event loop`
  );
  const body = (await res.json()) as { data?: Array<{ root?: string }> };
  assert.ok(
    body.data?.some((model) => model.root === "probe-model-59-11"),
    "the responsiveness probe must still traverse and return the last seeded catalog model"
  );
});
