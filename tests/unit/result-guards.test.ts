import test from "node:test";
import assert from "node:assert/strict";

import {
  isIpcFailure,
  isOkFailure,
  isSuccessFailure,
} from "../../src/shared/utils/resultGuards.ts";

type DataDirResult = string | { success: false; error: string };

test("isIpcFailure recognises the Electron IPC denial and no plain value", () => {
  const denial = { success: false, error: "get-data-dir is not available from a remote context" };
  assert.equal(isIpcFailure(denial), true);
  for (const value of [
    "C:\\Users\\me\\.omniroute",
    "",
    true,
    false,
    0,
    null,
    undefined,
    {
      success: true,
    },
  ]) {
    assert.equal(isIpcFailure(value), false, JSON.stringify(value));
  }
});

test("isIpcFailure narrows to the failure so its error is readable", () => {
  const results: DataDirResult[] = [
    "/home/me/.omniroute",
    { success: false, error: "get-data-dir is not available from a remote context" },
  ];
  assert.deepEqual(
    results.filter(isIpcFailure).map((r) => r.error),
    ["get-data-dir is not available from a remote context"]
  );
});

type Parsed = { ok: true; value: number } | { ok: false; error: string };

test("isOkFailure is true only for the ok:false branch", () => {
  const failure: Parsed = { ok: false, error: "bad input" };
  const success: Parsed = { ok: true, value: 7 };
  assert.equal(isOkFailure(failure), true);
  assert.equal(isOkFailure(success), false);
});

test("isOkFailure narrows to the failure branch so its fields are readable", () => {
  const results: Parsed[] = [
    { ok: true, value: 1 },
    { ok: false, error: "first" },
    { ok: false, error: "second" },
  ];
  const errors = results.filter(isOkFailure).map((r) => r.error);
  assert.deepEqual(errors, ["first", "second"]);
});

type BodyResult = { success: true; data: string } | { success: false; response: string };

test("isSuccessFailure is true only for the success:false branch and narrows to it", () => {
  const results: BodyResult[] = [
    { success: true, data: "ok" },
    { success: false, response: "400 invalid body" },
  ];
  assert.equal(isSuccessFailure(results[0]), false);
  assert.equal(isSuccessFailure(results[1]), true);
  assert.deepEqual(
    results.filter(isSuccessFailure).map((r) => r.response),
    ["400 invalid body"]
  );
});
