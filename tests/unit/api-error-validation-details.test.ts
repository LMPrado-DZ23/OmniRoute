/**
 * A validation failure must show the rule the server already sent.
 *
 * The first-run wizard's security step answered a four-character-minimum violation with:
 *
 *   Invalid request
 *   Why: The server did not accept the data sent.
 *   How to fix: Review the fields of this step (the message above indicates the
 *   problem) and send again.
 *
 * The guidance is not merely unhelpful — it is false. The message above indicated
 * nothing, while the server's own sentence sat unread in the response:
 *
 *   400 { error: { message: "Invalid request",
 *                  details: [{ field: "password",
 *                              message: "Password must be at least 4 characters" }] } }
 *
 * `validateBody` had put it there (`src/shared/validation/helpers.ts`); `presentApiError`
 * read only `error.message` and dropped `details` on the floor. `describeApiError` did
 * read them, but the wizard does not use it — it needs the `translate` option, which
 * only `presentApiError` takes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { presentApiError, describeApiError } from "../../src/shared/utils/apiErrorPresentation.ts";

const VALIDATION_BODY = {
  error: {
    message: "Invalid request",
    details: [{ field: "password", message: "Password must be at least 4 characters" }],
  },
};

test("the per-field rule survives presentation", () => {
  const presented = presentApiError(VALIDATION_BODY, { fallback: "Something went wrong" });

  assert.equal(presented.message, "Invalid request");
  assert.deepEqual(
    presented.details,
    ["password: Password must be at least 4 characters"],
    "the only sentence that tells the user what to change must not be discarded"
  );
});

test("several field errors all come through, in order", () => {
  const presented = presentApiError(
    {
      error: {
        message: "Invalid request",
        details: [
          { field: "password", message: "Too short" },
          { field: "confirm", message: "Does not match" },
        ],
      },
    },
    { fallback: "fallback" }
  );

  assert.deepEqual(presented.details, ["password: Too short", "confirm: Does not match"]);
});

test("a detail with no field is still readable", () => {
  const presented = presentApiError(
    { error: { message: "Invalid request", details: [{ message: "Body must be JSON" }] } },
    { fallback: "fallback" }
  );

  assert.deepEqual(presented.details, ["Body must be JSON"]);
});

test("bodies without validation details yield an empty list, never undefined", () => {
  for (const body of [
    { error: "plain text" },
    { error: { code: "PASSWORD_REQUIRED", message: "Password required" } },
    { error: { message: "no details key" } },
    { error: { message: "wrong shape", details: "not an array" } },
    null,
    undefined,
    "a string body",
  ]) {
    const presented = presentApiError(body, { fallback: "fallback" });
    assert.deepEqual(
      presented.details,
      [],
      `expected [] for ${JSON.stringify(body)} — a caller that spreads this must not crash`
    );
  }
});

test("describeApiError still reads the same source", () => {
  assert.equal(
    describeApiError(VALIDATION_BODY, "fallback"),
    "Invalid request: password: Password must be at least 4 characters",
    "the two presenters must not drift: they now share one details reader"
  );
});
