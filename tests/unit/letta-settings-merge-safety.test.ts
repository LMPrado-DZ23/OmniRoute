/**
 * Finding F-14 (letta): /api/cli-tools/letta-settings read Letta's ~/.letta/settings.json and
 * ~/.letta/lc-local-backend/providers/auth.json with a strict JSON.parse. POST swallowed every error
 * and wrote the result back, so a file that could not be parsed — including JSON with a trailing
 * comma — became a fresh object: POST replaced auth.json with only OmniRoute's provider (no backup
 * of the whole file exists), replaced settings.json with only preferredBackendMode, and skipped the
 * check that refuses to overwrite a real LM Studio provider. DELETE threw a 500 instead. Existing
 * content must be merged, and a file that cannot be merged must be refused (409) with nothing
 * written.
 *
 * The route resolves its paths from os.homedir(), so the temporary home is set on both HOME (POSIX)
 * and USERPROFILE (Windows) before importing it; the real home is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-letta-merge-data-"));
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-letta-merge-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
assert.equal(os.homedir(), TEST_HOME, "the route must see the temporary home");

const core = await import("../../src/lib/db/core.ts");
const { POST, DELETE } = await import("../../src/app/api/cli-tools/letta-settings/route.ts");

const LETTA_DIR = path.join(TEST_HOME, ".letta");
const SETTINGS = path.join(LETTA_DIR, "settings.json");
const AUTH = path.join(LETTA_DIR, "lc-local-backend", "providers", "auth.json");
const LMSTUDIO_BACKUP = `${AUTH}.omniroute-backup`;

const OTHER_PROVIDER =
  '"openai": { "base_url": "https://api.example.test/v1", "auth": { "type": "api", "key": "keep-this-key" } }';

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function read(file: string) {
  return fs.readFileSync(file, "utf-8");
}

function postApply() {
  return POST(
    new Request("http://localhost/api/cli-tools/letta-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://localhost:20128", apiKey: "sk-omniroute-test" }),
    })
  );
}

function deleteConfig() {
  return DELETE(new Request("http://localhost/api/cli-tools/letta-settings", { method: "DELETE" }));
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(LETTA_DIR, { recursive: true, force: true });
});

test.after(() => {
  core.resetDbInstance();
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST keeps the other providers of an auth.json with a trailing comma", async () => {
  write(AUTH, `{\n  "version": 1,\n  "providers": {\n    ${OTHER_PROVIDER},\n  },\n}\n`);

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const auth = JSON.parse(read(AUTH));
  assert.equal(auth.providers.openai?.auth?.key, "keep-this-key", "other providers must survive");
  assert.equal(auth.providers.lmstudio?.base_url, "http://localhost:20128/v1");
});

test("POST still refuses a real LM Studio provider in an auth.json with a trailing comma", async () => {
  const content =
    '{\n  "version": 1,\n  "providers": {\n    "lmstudio": { "base_url": "http://localhost:1234/v1" },\n  },\n}\n';
  write(AUTH, content);

  const res = await postApply();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.conflict, true, "the LM Studio conflict check must still run");
  assert.equal(read(AUTH), content, "auth.json untouched");
  assert.equal(fs.existsSync(SETTINGS), false, "settings.json not created");
  assert.equal(fs.existsSync(LMSTUDIO_BACKUP), false, "no provider backup written");
});

test("POST adds OmniRoute's provider to an auth.json that has no providers entry", async () => {
  write(AUTH, JSON.stringify({ version: 1 }));

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const auth = JSON.parse(read(AUTH));
  assert.equal(auth.version, 1);
  assert.equal(auth.providers.lmstudio?.base_url, "http://localhost:20128/v1");
});

for (const [label, file, bad] of [
  ["auth.json", AUTH, "{ this is not json"],
  ["settings.json", SETTINGS, "{ this is not json"],
  ["auth.json", AUTH, JSON.stringify({ version: 1, providers: ["not", "a", "map"] })],
] as const) {
  test(`POST answers 409 and writes nothing when ${label} cannot be merged: ${bad}`, async () => {
    write(
      AUTH,
      JSON.stringify({
        version: 1,
        providers: { openai: { base_url: "https://api.example.test" } },
      })
    );
    write(SETTINGS, JSON.stringify({ theme: "dark" }));
    write(file, bad);
    const before = { auth: read(AUTH), settings: read(SETTINGS) };

    const res = await postApply();
    assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
    assert.match(JSON.stringify(await res.json()), new RegExp(label.replace(".", "\\.")));
    assert.equal(read(AUTH), before.auth, "auth.json untouched");
    assert.equal(read(SETTINGS), before.settings, "settings.json untouched");
    assert.equal(fs.existsSync(LMSTUDIO_BACKUP), false, "no provider backup written");
  });
}

test("POST keeps every other setting of a settings.json with a trailing comma", async () => {
  write(SETTINGS, '{\n  "theme": "dark",\n  "preferredBackendMode": "api",\n}\n');

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const settings = JSON.parse(read(SETTINGS));
  assert.equal(settings.theme, "dark", "other settings must survive the merge");
  assert.equal(settings.preferredBackendMode, "local");
});

test("DELETE removes only OmniRoute's provider from an auth.json with a trailing comma", async () => {
  write(
    AUTH,
    `{\n  "version": 1,\n  "providers": {\n    ${OTHER_PROVIDER},\n    "lmstudio": { "base_url": "http://localhost:20128/v1" },\n  },\n}\n`
  );

  const res = await deleteConfig();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const auth = JSON.parse(read(AUTH));
  assert.equal(auth.providers.openai?.auth?.key, "keep-this-key");
  assert.equal(auth.providers.lmstudio, undefined);
});

test("DELETE answers 409 and writes nothing when auth.json cannot be parsed", async () => {
  const bad = "{ not json either";
  write(AUTH, bad);
  write(SETTINGS, JSON.stringify({ preferredBackendMode: "local" }));
  const settingsBefore = read(SETTINGS);

  const res = await deleteConfig();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
  assert.equal(read(AUTH), bad, "auth.json must not be rewritten");
  assert.equal(read(SETTINGS), settingsBefore, "settings.json untouched");
});
