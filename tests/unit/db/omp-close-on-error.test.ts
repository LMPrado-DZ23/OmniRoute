/**
 * src/lib/db/omp.ts opens the omp CLI's own ~/.omp/agent/agent.db on every call and closed it only
 * after its statements succeeded. When a statement threw — for example on a foreign or corrupt
 * database without the auth_credentials table — the handle stayed open: every such request leaked a
 * handle, and on Windows the file stayed locked (a test's cleanup of the folder failed with EPERM).
 * Each function must close the database whether its statements succeed or throw, and keep its
 * existing result: getOmpCredentials reports "not configured", save and delete still throw.
 *
 * Closes are counted through better-sqlite3's own prototype, which omp.ts loads from the same module
 * cache. The temporary home is set on both HOME (POSIX) and USERPROFILE (Windows) before importing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omp-close-home-"));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
assert.equal(os.homedir(), TEST_HOME, "omp.ts must see the temporary home");

const { getOmpCredentials, saveOmpCredentials, deleteOmpCredentials } =
  await import("../../../src/lib/db/omp.ts");

const OMP_DIR = path.join(TEST_HOME, ".omp");
const DB_PATH = path.join(OMP_DIR, "agent", "agent.db");

let closes = 0;
const originalClose = Database.prototype.close;
Database.prototype.close = function countedClose(this: InstanceType<typeof Database>) {
  closes += 1;
  return originalClose.call(this);
};

/** A valid SQLite file that is not an omp database: no auth_credentials table. */
function seedForeignDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("CREATE TABLE unrelated (id INTEGER)");
  db.close();
}

function seedOmpDbWithRow() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(
    "CREATE TABLE auth_credentials (provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER)"
  );
  db.prepare(
    "INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('omniroute', 'api_key', ?)"
  ).run(JSON.stringify({ apiKey: "sk-test", baseUrl: "http://localhost:20128/v1" }));
  db.close();
}

test.beforeEach(() => {
  fs.rmSync(OMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.after(() => {
  Database.prototype.close = originalClose;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("control: getOmpCredentials closes the database after a successful read", () => {
  seedOmpDbWithRow();
  closes = 0;

  const creds = getOmpCredentials("omniroute");
  assert.equal(creds.hasOmniRoute, true);
  assert.equal(closes, 1, "the counter must see the close on the success path");
});

test("getOmpCredentials closes the database when auth_credentials is missing", () => {
  seedForeignDb();
  closes = 0;

  const creds = getOmpCredentials("omniroute");
  assert.deepEqual(creds, { hasOmniRoute: false, baseUrl: null, apiKey: null });
  assert.equal(closes, 1, "the database must be closed even though the query threw");
});

test("saveOmpCredentials closes the database and still throws when auth_credentials is missing", () => {
  seedForeignDb();
  closes = 0;

  assert.throws(() => saveOmpCredentials("omniroute", "sk-test", "http://localhost:20128/v1"));
  assert.equal(closes, 1, "the database must be closed even though the statement threw");
});

test("deleteOmpCredentials closes the database and still throws when auth_credentials is missing", () => {
  seedForeignDb();
  closes = 0;

  assert.throws(() => deleteOmpCredentials("omniroute"));
  assert.equal(closes, 1, "the database must be closed even though the statement threw");
});
