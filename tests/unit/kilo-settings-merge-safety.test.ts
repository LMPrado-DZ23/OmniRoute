/**
 * Finding F-14 (kilo): /api/cli-tools/kilo-settings read Kilo's ~/.local/share/kilo/auth.json and the
 * VS Code user settings.json with a strict JSON.parse inside a try/catch that swallowed every error,
 * then wrote the result back. A file that could not be parsed — including JSON with a trailing comma,
 * which the GET handler accepts — became `{}`: POST replaced auth.json with only OmniRoute's provider
 * and replaced the whole VS Code settings.json with only two kilocode keys. auth.json must be merged
 * or refused (409) untouched; the VS Code update is best-effort, so an unmergeable settings.json is
 * left as it is while the CLI config is still applied. DELETE threw a 500 on any non-strict JSON.
 *
 * The route resolves its paths from os.homedir() at import time, so the temporary home is set on
 * both HOME (POSIX) and USERPROFILE (Windows) before importing it; the real home is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kilo-merge-data-"));
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kilo-merge-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
assert.equal(os.homedir(), TEST_HOME, "the route must see the temporary home");

const core = await import("../../src/lib/db/core.ts");
const { POST, DELETE } = await import("../../src/app/api/cli-tools/kilo-settings/route.ts");

const AUTH = path.join(TEST_HOME, ".local", "share", "kilo", "auth.json");
const VSCODE_SETTINGS = path.join(TEST_HOME, ".config", "Code", "User", "settings.json");

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function postApply() {
  return POST(
    new Request("http://localhost/api/cli-tools/kilo-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://localhost:20128",
        model: "gpt-5",
        apiKey: "sk-omniroute-test",
      }),
    })
  );
}

function deleteConfig() {
  return DELETE(new Request("http://localhost/api/cli-tools/kilo-settings", { method: "DELETE" }));
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(path.join(TEST_HOME, ".local"), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, ".config"), { recursive: true, force: true });
});

test.after(() => {
  core.resetDbInstance();
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST keeps the other providers of a JSON auth.json with a trailing comma", async () => {
  write(AUTH, '{\n  "anthropic": { "type": "api-key", "apiKey": "keep-this-key" },\n}\n');

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const auth = JSON.parse(fs.readFileSync(AUTH, "utf-8"));
  assert.equal(auth.anthropic?.apiKey, "keep-this-key", "other providers must survive the merge");
  assert.equal(auth["openai-compatible"]?.baseUrl, "http://localhost:20128/v1");
});

test("POST answers 409 and writes nothing when auth.json cannot be parsed", async () => {
  const bad = "{ this is not json";
  write(AUTH, bad);
  write(VSCODE_SETTINGS, JSON.stringify({ "editor.fontSize": 14 }));
  const vscodeBefore = fs.readFileSync(VSCODE_SETTINGS, "utf-8");

  const res = await postApply();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
  assert.match(JSON.stringify(await res.json()), /auth\.json/);
  assert.equal(fs.readFileSync(AUTH, "utf-8"), bad, "auth.json untouched");
  assert.equal(fs.readFileSync(VSCODE_SETTINGS, "utf-8"), vscodeBefore, "settings.json untouched");
});

test("POST keeps every other VS Code setting of a settings.json with a trailing comma", async () => {
  write(VSCODE_SETTINGS, '{\n  "editor.fontSize": 14,\n  "workbench.colorTheme": "Dark+",\n}\n');

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const settings = JSON.parse(fs.readFileSync(VSCODE_SETTINGS, "utf-8"));
  assert.equal(settings["editor.fontSize"], 14, "other VS Code settings must survive the merge");
  assert.equal(settings["workbench.colorTheme"], "Dark+");
  assert.equal(settings["kilocode.defaultModel"], "gpt-5");
});

test("POST still applies auth.json but leaves an unparseable VS Code settings.json untouched", async () => {
  const bad = '{ // my settings\n  "editor.fontSize": 14 oops }';
  write(VSCODE_SETTINGS, bad);

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.equal(
    fs.readFileSync(VSCODE_SETTINGS, "utf-8"),
    bad,
    "settings.json must not be rewritten"
  );
  const auth = JSON.parse(fs.readFileSync(AUTH, "utf-8"));
  assert.equal(auth["openai-compatible"]?.model, "gpt-5");
});

test("DELETE answers 409 and leaves auth.json untouched when it cannot be parsed", async () => {
  const bad = "{ not json either";
  write(AUTH, bad);

  const res = await deleteConfig();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
  assert.equal(fs.readFileSync(AUTH, "utf-8"), bad, "auth.json must not be rewritten");
});
