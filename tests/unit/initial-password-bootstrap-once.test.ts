/**
 * Audit C-06: with INITIAL_PASSWORD set, `getSettings()` re-forced `setupComplete=true` on
 * EVERY read, so `PATCH /api/settings {setupComplete:false}` (re-run the onboarding wizard)
 * answered 200 and had no effect. The headless bootstrap must still happen on first read
 * (wizard skipped on first boot, login required), but only once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-initial-pw-once-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const managementPassword = await import("../../src/lib/auth/managementPassword.ts");

function readRawSetting(key: string): string | undefined {
  const row = core
    .getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value;
}

async function resetStorage() {
  core.resetDbInstance();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      break;
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
});

test("first read with INITIAL_PASSWORD still completes setup and requires login", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";

  const settings = await settingsDb.getSettings();

  assert.equal(settings.setupComplete, true);
  assert.equal(settings.requireLogin, true);
  assert.equal(readRawSetting("setupComplete"), "true");
  // The marker is internal: underscore keys never surface in the settings object.
  assert.equal(readRawSetting("_initialPasswordBootstrapped"), "true");
  assert.equal("_initialPasswordBootstrapped" in settings, false);
});

test("an explicit setupComplete=false after the bootstrap is honoured (no 200-without-effect)", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  await settingsDb.getSettings();

  const updated = await settingsDb.updateSettings({ setupComplete: false });
  const reread = await settingsDb.getSettings();

  assert.equal(updated.setupComplete, false);
  assert.equal(reread.setupComplete, false, "the next read must not re-force setupComplete");
  assert.equal(reread.requireLogin, true, "login stays required");
});

test("the startup password migration does not re-force setupComplete after a re-run request", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";
  await managementPassword.ensurePersistentManagementPasswordHash({ source: "test" });
  await settingsDb.updateSettings({ setupComplete: false });

  const second = await managementPassword.ensurePersistentManagementPasswordHash({
    source: "test",
  });
  const settings = await settingsDb.getSettings();

  assert.equal(second.migrated, false, "the stored bcrypt hash is reused");
  assert.equal(settings.setupComplete, false);
  assert.equal(managementPassword.isBcryptHash(settings.password), true);
});

test("an install bootstrapped before the marker existed only gets the marker", async () => {
  await settingsDb.updateSettings({ setupComplete: true, requireLogin: false });
  process.env.INITIAL_PASSWORD = "bootstrap-secret";

  const first = await settingsDb.getSettings();
  assert.equal(first.setupComplete, true);
  assert.equal(first.requireLogin, false, "an operator choice is not overwritten");
  assert.equal(readRawSetting("_initialPasswordBootstrapped"), "true");

  await settingsDb.updateSettings({ setupComplete: false });
  assert.equal((await settingsDb.getSettings()).setupComplete, false);
});

test("without INITIAL_PASSWORD nothing is forced and no marker is written", async () => {
  const settings = await settingsDb.getSettings();

  assert.notEqual(settings.setupComplete, true);
  assert.equal(readRawSetting("_initialPasswordBootstrapped"), undefined);
});
