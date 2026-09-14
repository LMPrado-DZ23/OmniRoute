/**
 * Integration tests for /api/cli-tools/omp-settings
 *
 * Oh My Pi (omp) reads its own local sqlite DB (~/.omp/agent/agent.db,
 * created by the omp CLI itself) via src/lib/db/omp.ts, plus a
 * ~/.omp/agent/models.yml file for provider/model discovery config. The route
 * shells out to `which omp` to detect the CLI install, so it is classified
 * local-only in routeGuard.ts (Hard Rules #15 + #17) AND guarded by
 * requireCliToolsAuth() like every other cli-tools route
 * (tests/unit/cli-tools-auth-hardening.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-omp-settings-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret-omp";
process.env.JWT_SECRET = "test-jwt-secret-omp";

const core = await import("../../src/lib/db/core.ts");
const { updateSettings } = await import("@/lib/db/settings");
const localDb = { updateSettings };

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/omp-settings/route.ts");

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

function getOmpDir() {
  return path.join(tmpHome, ".omp", "agent");
}

function req(init?: RequestInit) {
  return new Request("http://localhost/api/cli-tools/omp-settings", init);
}

/** Simulate the omp CLI having already created its sqlite DB + schema. */
function seedOmpDb() {
  const dbPath = path.join(getOmpDir(), "agent.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_credentials (
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT,
      disabled_cause TEXT,
      identity_key TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.close();
}

async function resetStorage() {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function enableAuth() {
  process.env.INITIAL_PASSWORD = "test-bootstrap";
  await localDb.updateSettings({ requireLogin: true, password: "" });
}

test.beforeEach(async () => {
  await resetStorage();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-settings-home-"));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  // os.homedir() reads HOME on POSIX but USERPROFILE on Windows; without both the route
  // would read and write the real ~/.omp/agent on a Windows machine.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  assert.equal(os.homedir(), tmpHome, "the route must see the temporary home");
});

test.afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Test 1: GET without auth → 401 ──────────────────────────────────────────

test("omp-settings GET: returns 401 when auth required and no token", async () => {
  await enableAuth();
  const res = await GET(req());
  assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
});

// ── Test 2: GET → 200 with installed:false when omp is not present ──────────

test("omp-settings GET: returns 200 installed:false when omp CLI and DB are both absent", async () => {
  const res = await GET(req());
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.installed, false);
  assert.equal(body.config, null);
});

// ── Test 3: GET → detects "installed" via the DB file even without the binary on PATH ──

test("omp-settings GET: treats an existing agent.db as installed", async () => {
  seedOmpDb();
  const res = await GET(req());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.installed, true);
  assert.equal(body.hasOmniRoute, false);
});

// ── Test 4: POST with invalid body → 400 ─────────────────────────────────────

test("omp-settings POST: 400 when baseUrl is missing", async () => {
  const res = await POST(
    req({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test" }),
    })
  );
  assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
  const body = await res.json();
  assert.ok(body.error !== undefined);
});

// ── Test 5: POST with valid body → writes models.yml + persists credentials ──

test("omp-settings POST: writes models.yml and persists credentials for a seeded DB", async () => {
  seedOmpDb();

  const res = await POST(
    req({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://localhost:20128", apiKey: "sk-test-omp" }),
    })
  );
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.success, true);

  const modelsYmlPath = path.join(getOmpDir(), "models.yml");
  assert.ok(fs.existsSync(modelsYmlPath), "models.yml must be written");
  const content = fs.readFileSync(modelsYmlPath, "utf-8");
  assert.ok(content.includes("http://localhost:20128/v1"), "models.yml must contain the base URL");

  const getRes = await GET(req());
  const getBody = await getRes.json();
  assert.equal(getBody.hasOmniRoute, true);
});

// ── Test 6: DELETE → removes OmniRoute provider entry ────────────────────────

test("omp-settings DELETE: removes the OmniRoute provider from models.yml and credentials", async () => {
  seedOmpDb();
  await POST(
    req({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://localhost:20128", apiKey: "sk-test-omp" }),
    })
  );

  const res = await DELETE(req({ method: "DELETE" }));
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.success, true);

  const getRes = await GET(req());
  const getBody = await getRes.json();
  assert.equal(getBody.hasOmniRoute, false);
});

// ── Test 7: Error sanitization (Hard Rule #12) ───────────────────────────────

test("omp-settings: error responses do not leak stack traces", async () => {
  const badReq = req({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ bad json }",
  });
  const res = await POST(badReq);
  const bodyStr = JSON.stringify(await res.json());
  assert.ok(
    !bodyStr.match(/\s+at\s+\/[^\s]/),
    "Error response must not contain absolute-path stack traces"
  );
});

// ── Test 8+: an existing models.yml that cannot be merged is never overwritten ─

const VALID_BODY = JSON.stringify({ baseUrl: "http://localhost:20128", apiKey: "sk-test-omp" });

function writeModelsYml(content: string) {
  const file = path.join(getOmpDir(), "models.yml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function postValidBody() {
  return POST(
    req({ method: "POST", headers: { "content-type": "application/json" }, body: VALID_BODY })
  );
}

for (const [label, content] of [
  ["is not valid YAML", "providers:\n  other: [unclosed\n"],
  ["is a scalar, not a mapping", "just some text\n"],
  ["is a list, not a mapping", "- one\n- two\n"],
  ["has a providers value that is not a mapping", "providers: nope\n"],
] as const) {
  test(`omp-settings POST: 409 and models.yml left untouched when it ${label}`, async () => {
    seedOmpDb();
    const file = writeModelsYml(content);

    const res = await postValidBody();
    assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error?.message), /models\.yml/);
    assert.equal(fs.readFileSync(file, "utf-8"), content, "models.yml must not be rewritten");

    const getBody = await (await GET(req())).json();
    assert.equal(getBody.hasOmniRoute, false, "credentials must not be saved either");
  });
}

test("omp-settings POST: keeps other providers and top-level settings in models.yml", async () => {
  seedOmpDb();
  const file = writeModelsYml(
    "defaultModel: local/llama\nproviders:\n  local:\n    baseUrl: http://127.0.0.1:11434/v1\n"
  );

  const res = await postValidBody();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const { load: yamlLoad } = await import("js-yaml");
  assert.deepEqual(yamlLoad(fs.readFileSync(file, "utf-8")), {
    defaultModel: "local/llama",
    providers: {
      local: { baseUrl: "http://127.0.0.1:11434/v1" },
      omniroute: {
        baseUrl: "http://localhost:20128/v1",
        apiKey: "sk-test-omp",
        api: "openai-completions",
        authHeader: true,
        disableStrictTools: true,
        discovery: { type: "proxy" },
      },
    },
  });
});

test("omp-settings DELETE: leaves a models.yml it cannot parse untouched", async () => {
  seedOmpDb();
  const content = "providers:\n  omniroute: [unclosed\n";
  const file = writeModelsYml(content);

  const res = await DELETE(req({ method: "DELETE" }));
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.equal(fs.readFileSync(file, "utf-8"), content);
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  delete process.env.JWT_SECRET;
});
