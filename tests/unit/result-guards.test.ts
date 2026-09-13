import test from "node:test";
import assert from "node:assert/strict";

import { isOkFailure } from "../../src/shared/utils/resultGuards.ts";

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
