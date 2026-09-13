/**
 * Finding F-14 (cline): /api/cli-tools/cline-settings read ~/.cline/data/globalState.json and
 * secrets.json with a strict JSON.parse inside a try/catch that swallowed every error, then wrote the
 * result back. A file that could not be parsed — including a JSONC file with a trailing comma, which
 * the GET handler accepts — became `{}`, so POST replaced the whole globalState with only OmniRoute's
 * keys and replaced every stored secret with only openAiApiKey, and DELETE rewrote secrets.json as
 * `{}`. Existing content must be merged, and a file that cannot be merged must be refused (409) with
 * neither file touched.
 *
 * The route resolves its paths from os.homedir() at import time, so the temporary home is set on
 * both HOME (POSIX) and USERPROFILE (Windows) before importing it; the real home is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cline-merge-data-"));
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cline-merge-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
assert.equal(os.homedir(), TEST_HOME, "the route must see the temporary home");

const core = await import("../../src/lib/db/core.ts");
const { POST, DELETE } = await import("../../src/app/api/cli-tools/cline-settings/route.ts");

const DATA_DIR = path.join(TEST_HOME, ".cline", "data");
const GLOBAL_STATE = path.join(DATA_DIR, "globalState.json");
const SECRETS = path.join(DATA_DIR, "secrets.json");

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function postApply() {
  return POST(
    new Request("http://localhost/api/cli-tools/cline-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://localhost:20128/v1",
        model: "gpt-5",
        apiKey: "sk-omniroute-test",
      }),
    })
  );
}

function deleteConfig() {
  return DELETE(new Request("http://localhost/api/cli-tools/cline-settings", { method: "DELETE" }));
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(path.join(TEST_HOME, ".cline"), { recursive: true, force: true });
});

test.after(() => {
  core.resetDbInstance();
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("POST keeps every other key of a JSONC globalState.json (trailing comma)", async () => {
  write(
    GLOBAL_STATE,
    '{\n  "telemetrySetting": "disabled",\n  "customInstructions": "be terse",\n}\n'
  );

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const state = JSON.parse(fs.readFileSync(GLOBAL_STATE, "utf-8"));
  assert.equal(state.telemetrySetting, "disabled", "existing keys must survive the merge");
  assert.equal(state.customInstructions, "be terse");
  assert.equal(state.actModeApiProvider, "openai");
  assert.equal(state.openAiBaseUrl, "http://localhost:20128");
});

test("POST keeps the other stored secrets and only sets openAiApiKey", async () => {
  write(SECRETS, JSON.stringify({ anthropicApiKey: "keep-this-key" }));

  const res = await postApply();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const secrets = JSON.parse(fs.readFileSync(SECRETS, "utf-8"));
  assert.equal(secrets.anthropicApiKey, "keep-this-key");
  assert.equal(secrets.openAiApiKey, "sk-omniroute-test");
});

for (const [label, file] of [
  ["globalState.json", GLOBAL_STATE],
  ["secrets.json", SECRETS],
] as const) {
  test(`POST answers 409 and writes nothing when ${label} cannot be parsed`, async () => {
    write(GLOBAL_STATE, JSON.stringify({ telemetrySetting: "disabled" }));
    write(SECRETS, JSON.stringify({ anthropicApiKey: "keep-this-key" }));
    const bad = "{ this is not json";
    write(file, bad);
    const before = {
      state: fs.readFileSync(GLOBAL_STATE, "utf-8"),
      secrets: fs.readFileSync(SECRETS, "utf-8"),
    };

    const res = await postApply();
    assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
    const body = await res.json();
    assert.match(JSON.stringify(body), new RegExp(label.replace(".", "\\.")));
    assert.equal(
      fs.readFileSync(GLOBAL_STATE, "utf-8"),
      before.state,
      "globalState.json untouched"
    );
    assert.equal(fs.readFileSync(SECRETS, "utf-8"), before.secrets, "secrets.json untouched");
  });
}

test("DELETE answers 409 and leaves secrets.json untouched when it cannot be parsed", async () => {
  write(
    GLOBAL_STATE,
    JSON.stringify({ actModeApiProvider: "openai", openAiBaseUrl: "http://localhost:20128" })
  );
  const bad = "{ not json either";
  write(SECRETS, bad);
  const stateBefore = fs.readFileSync(GLOBAL_STATE, "utf-8");

  const res = await deleteConfig();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}`);
  assert.equal(fs.readFileSync(SECRETS, "utf-8"), bad, "secrets.json must not be rewritten");
  assert.equal(fs.readFileSync(GLOBAL_STATE, "utf-8"), stateBefore, "globalState.json untouched");
});
