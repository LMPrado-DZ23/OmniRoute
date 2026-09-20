/**
 * C-05 (final audit) — `GET /v1/models` advertised every model of the local-CLI
 * no-auth providers (`devin-cli-agentic`/dva, `auggie`/aug, `zcode`/zc,
 * `codex-app-server`/cxa — 248 rows on a fresh instance) even when the CLI /
 * app-server they drive is not installed or configured on this machine, so the
 * rows could only fail at request time.
 *
 * Rule under test: a local-CLI no-auth provider is listed only while its local
 * runtime is actually reachable — binary located (auggie, devin, zcode) or an
 * app-server URL + token resolvable (codex-app-server). Free/web no-auth
 * providers (opencode, duckduckgo-web, ...) keep the documented zero-config
 * behaviour (#2798): listed unless `blockedProviders` disables them. Configured
 * providers keep their rows. The OpenAI response shape is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-c05-local-cli-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "c05-local-cli-test-secret";

// Hermetic runtime: every executor discovery path is pinned to a path that does
// not exist, and no app-server env is present, so the probes cannot pick up a CLI
// that happens to be installed on the developer machine.
const MISSING_BIN = path.join(TEST_DATA_DIR, "missing-bin", "does-not-exist.exe");
process.env.AUGGIE_BIN = MISSING_BIN;
process.env.CLI_AUGGIE_BIN = MISSING_BIN;
process.env.CLI_DEVIN_AGENTIC_BIN = MISSING_BIN;
process.env.CLI_DEVIN_BIN = MISSING_BIN;
process.env.DEVIN_AGENTIC_HOME = "/home/bridge";
process.env.ZCODE_BIN = MISSING_BIN;
process.env.ZCODE_SERVER_NODE = MISSING_BIN;
process.env.ZCODE_SERVER_ENTRY = MISSING_BIN;
delete process.env.OMNIROUTE_CODEX_APPSERVER_WS;
delete process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN;
delete process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

// Hermetic outbound layer — installed AFTER every import, because
// open-sse/utils/proxyFetch.ts replaces globalThis.fetch at import time and would
// discard a stub installed before it. Production code under test makes best-effort
// calls (catalog polls, egress probes) that must never leave the machine.
const { installOfflineOutbound } = await import("./_helpers/offlineOutbound.ts");
await installOfflineOutbound();

type CatalogRow = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};
type CatalogBody = { object: string; data: CatalogRow[] };

const LOCAL_CLI_OWNERS = ["devin-cli-agentic", "auggie", "zcode", "codex-app-server"] as const;
const LOCAL_CLI_PREFIXES = ["dva/", "aug/", "zc/", "cxa/"] as const;

async function loadAvailabilityModule() {
  return import("../../src/app/api/v1/models/catalogLocalCliAvailability.ts");
}

/**
 * Re-run the real probes against the CURRENT env and wait for every verdict, so
 * a catalog build in the test never falls into the bounded-wait fail-open path
 * (LOCAL_CLI_PROBE_WAIT_MS) on a slow CI shard. Production gets the same
 * verdicts; this only removes timing from the assertions.
 */
async function warmProbes() {
  const availability = await loadAvailabilityModule();
  await availability.__resetLocalCliAvailabilityCacheForTest();
  await availability.getLocalCliProviderAvailability(
    { connections: [] },
    { waitForProbeMs: Number.POSITIVE_INFINITY }
  );
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  v1ModelsCatalog.__expireCatalogCacheForTest();
  try {
    const availability = await loadAvailabilityModule();
    availability.__setLocalCliAvailabilityForTest(null);
    await warmProbes();
  } catch {
    // RED phase: the module does not exist yet.
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function fetchCatalog(): Promise<CatalogBody> {
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as CatalogBody;
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data), "response has data array");
  return body;
}

function ownersOf(body: CatalogBody): Set<string> {
  return new Set(body.data.map((row) => row.owned_by));
}

function idsOf(body: CatalogBody): string[] {
  return body.data.map((row) => row.id);
}

function assertNoLocalCliRows(body: CatalogBody, except: ReadonlySet<string> = new Set()) {
  const owners = ownersOf(body);
  const ids = idsOf(body);
  for (const owner of LOCAL_CLI_OWNERS) {
    if (except.has(owner)) continue;
    assert.equal(owners.has(owner), false, `owned_by=${owner} must not be advertised`);
  }
  const blockedPrefixes = LOCAL_CLI_PREFIXES.filter(
    (_prefix, index) => !except.has(LOCAL_CLI_OWNERS[index])
  );
  const leaked = ids.filter((id) => blockedPrefixes.some((prefix) => id.startsWith(prefix)));
  assert.deepEqual(leaked.slice(0, 5), [], `local CLI rows leaked: ${leaked.length}`);
}

test("C-05: fresh instance with no local CLI installed advertises no local-CLI provider rows (real probes)", async () => {
  const body = await fetchCatalog();
  assertNoLocalCliRows(body);
  // Anti-vacuity: the catalog is still non-empty (free no-auth providers stay
  // listed by design, #2798) and keeps the OpenAI list shape.
  assert.ok(body.data.length > 0, "catalog must not be empty");
  for (const row of body.data.slice(0, 20)) {
    assert.equal(row.object, "model");
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.owned_by, "string");
    assert.equal(typeof row.created, "number");
  }
});

test("C-05: free/web no-auth providers keep their zero-config listing while local CLIs are hidden", async () => {
  const body = await fetchCatalog();
  const ids = idsOf(body);
  assert.ok(
    ids.some((id) => id.startsWith("oc/")),
    "opencode (free, zero-config) rows must remain listed (#2798)"
  );
  assertNoLocalCliRows(body);
});

test("C-05: a configured provider's models are listed while local CLIs stay hidden", async () => {
  await providersDb.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "claude-c05",
    apiKey: "sk-test-c05",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  const body = await fetchCatalog();
  const ids = idsOf(body);
  assert.ok(
    ids.some((id) => id.startsWith("cc/")),
    "configured claude connection must expose cc/* rows"
  );
  assertNoLocalCliRows(body);
});

test("C-05: a detected CLI brings its provider back (auggie via override hook)", async () => {
  const availability = await loadAvailabilityModule();
  availability.__setLocalCliAvailabilityForTest({ auggie: true });
  const body = await fetchCatalog();
  const owners = ownersOf(body);
  const ids = idsOf(body);
  assert.ok(owners.has("auggie"), "auggie rows must be advertised once the CLI is detected");
  assert.ok(
    ids.some((id) => id.startsWith("aug/")),
    "aug/* ids must be present once the CLI is detected"
  );
  assertNoLocalCliRows(body, new Set(["auggie"]));
});

test("C-05: auggie is detected through the executor's own discovery (AUGGIE_BIN pointing at a real executable)", async () => {
  const previous = process.env.AUGGIE_BIN;
  process.env.AUGGIE_BIN = process.execPath;
  try {
    await warmProbes();
    const body = await fetchCatalog();
    assert.ok(ownersOf(body).has("auggie"), "auggie must be listed when its binary resolves");
    assertNoLocalCliRows(body, new Set(["auggie"]));
  } finally {
    process.env.AUGGIE_BIN = previous;
  }
});

test("C-05: codex-app-server is listed only when an app-server URL + token resolve (connection row)", async () => {
  let body = await fetchCatalog();
  assert.equal(ownersOf(body).has("codex-app-server"), false);

  await providersDb.createProviderConnection({
    provider: "codex-app-server",
    authType: "no-auth",
    name: "codex-app-server-c05",
    isActive: true,
    testStatus: "unknown",
    providerSpecificData: {
      codexAppServerUrl: "ws://127.0.0.1:1456",
      codexAppServerToken: "0123456789abcdef",
    },
  });
  v1ModelsCatalog.__expireCatalogCacheForTest();
  body = await fetchCatalog();
  assert.ok(
    ownersOf(body).has("codex-app-server"),
    "codex-app-server rows must appear once the transport is configured"
  );
  assert.ok(
    idsOf(body).some((id) => id.startsWith("cxa/")),
    "cxa/* ids must be present once the transport is configured"
  );
  assertNoLocalCliRows(body, new Set(["codex-app-server"]));
});

test("C-05: codex-app-server is listed when the app-server is configured through env (docker sidecar)", async () => {
  process.env.OMNIROUTE_CODEX_APPSERVER_WS = "ws://127.0.0.1:1456";
  process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN = "0123456789abcdef";
  try {
    const body = await fetchCatalog();
    assert.ok(ownersOf(body).has("codex-app-server"));
  } finally {
    delete process.env.OMNIROUTE_CODEX_APPSERVER_WS;
    delete process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN;
  }
});

test("C-05: a cache-miss probe that exceeds the wait bound fails open for that build and lands in the cache afterwards", async () => {
  const availability = await loadAvailabilityModule();
  await availability.__resetLocalCliAvailabilityCacheForTest();
  // A probe that is still running when the wait bound expires must not block this build.
  // The probe is made deterministically slower than the 0 ms bound (on a fast host a real
  // probe can settle within the same tick, which made this case racy).
  availability.__setLocalCliProbeDelayForTest(150);
  const pending = await availability.getLocalCliProviderAvailability(
    { connections: [] },
    { waitForProbeMs: 0 }
  );
  for (const providerId of ["auggie", "devin-cli-agentic", "zcode"]) {
    assert.deepEqual(pending.get(providerId), { available: true, reason: "probe_pending" });
  }
  // codex-app-server is a pure env/connection check — never pending.
  assert.equal(pending.get("codex-app-server")?.available, false);

  // Once the in-flight probes settle, the definitive verdicts are served from cache.
  availability.__setLocalCliProbeDelayForTest(0);
  await availability.__resetLocalCliAvailabilityCacheForTest();
  await availability.getLocalCliProviderAvailability(
    { connections: [] },
    { waitForProbeMs: Number.POSITIVE_INFINITY }
  );
  const settled = await availability.getLocalCliProviderAvailability(
    { connections: [] },
    { waitForProbeMs: 0 }
  );
  assert.deepEqual(settled.get("auggie"), { available: false, reason: "binary_not_found" });
  assert.deepEqual(settled.get("zcode"), { available: false, reason: "binary_not_found" });
  assert.deepEqual(settled.get("devin-cli-agentic"), {
    available: false,
    reason: "binary_not_found",
  });
});

test("C-05: the auggie probe mirrors the executor's own binary discovery (parity guard)", async () => {
  const availability = await loadAvailabilityModule();
  const executor = await import("../../open-sse/executors/auggie.ts");
  const previous = {
    AUGGIE_BIN: process.env.AUGGIE_BIN,
    CLI_AUGGIE_BIN: process.env.CLI_AUGGIE_BIN,
  };
  try {
    for (const scenario of [
      { AUGGIE_BIN: "  /opt/custom/auggie  ", CLI_AUGGIE_BIN: undefined },
      { AUGGIE_BIN: undefined, CLI_AUGGIE_BIN: "/opt/other/auggie" },
      { AUGGIE_BIN: undefined, CLI_AUGGIE_BIN: undefined },
    ]) {
      for (const [key, value] of Object.entries(scenario)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.equal(
        await availability.resolveAuggieBinForProbe(),
        executor.resolveAuggieBin(),
        `probe and executor must resolve the same auggie binary for ${JSON.stringify(scenario)}`
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("C-05: the devin probe mirrors the executor's DEVIN_AGENTIC_HOME invariant (parity guard)", async () => {
  const availability = await loadAvailabilityModule();
  const executor = await import("../../open-sse/executors/devin-cli-agentic.ts");
  for (const home of [
    undefined,
    "",
    "relative/home",
    "/home/bridge",
    "/srv/.sandbox/devin",
    "/home/other",
  ]) {
    let executorAccepts = true;
    try {
      executor.buildDevinChildEnv(
        null as unknown as Parameters<typeof executor.buildDevinChildEnv>[0],
        {
          ...(home === undefined ? {} : { DEVIN_AGENTIC_HOME: home }),
        }
      );
    } catch {
      executorAccepts = false;
    }
    assert.equal(
      availability.isDevinAgenticHomeUsable(home),
      executorAccepts,
      `probe and executor must agree on DEVIN_AGENTIC_HOME=${JSON.stringify(home)}`
    );
  }
});

test("C-05: blockedProviders still wins over a detected CLI", async () => {
  const settingsDb = await import("../../src/lib/db/settings.ts");
  const availability = await loadAvailabilityModule();
  availability.__setLocalCliAvailabilityForTest({ auggie: true, zcode: true });
  await settingsDb.updateSettings({ blockedProviders: ["auggie"] });
  const body = await fetchCatalog();
  const owners = ownersOf(body);
  assert.equal(owners.has("auggie"), false, "blocked provider must stay hidden");
  assert.ok(owners.has("zcode"), "unblocked detected provider must be listed");
});
