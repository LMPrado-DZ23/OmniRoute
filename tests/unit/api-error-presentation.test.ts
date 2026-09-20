/**
 * U4 (audit/04-PRODUCT-GAPS.md): API errors reach the dashboard in three shapes —
 * `{ error: "text" }`, `{ error: { code, message, … } }` and `{ error: { message, details } }`
 * (validation). Components used to render `data.error` directly, which either showed a raw
 * technical sentence or, for the object shapes, crashed React ("Objects are not valid as a
 * React child"). `presentApiError` always yields a string for the user, prefers a translated
 * message keyed by `error.code`, and keeps the technical text as a separate `detail`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ERROR_CODE_MESSAGE_KEYS,
  getApiErrorCode,
  presentApiError,
} from "../../src/shared/utils/apiErrorPresentation.ts";

const translate = (key: string) => (key.startsWith("apiErrors.") ? `T(${key})` : null);

test("getApiErrorCode reads error.code only from the object shape", () => {
  assert.equal(
    getApiErrorCode({ error: { code: "PASSWORD_MISMATCH", message: "x" } }),
    "PASSWORD_MISMATCH"
  );
  assert.equal(getApiErrorCode({ error: "Unauthorized" }), null);
  assert.equal(getApiErrorCode({ error: { message: "Invalid request" } }), null);
  assert.equal(getApiErrorCode(null), null);
  assert.equal(getApiErrorCode("plain text"), null);
});

test("a known code becomes the translated message; the technical sentence is kept as detail", () => {
  const out = presentApiError(
    {
      error: {
        code: "PASSWORD_REQUIRED",
        message: "currentPassword required for security-impacting setting changes",
        keys: ["requireLogin"],
      },
    },
    { translate, fallback: "Fallback" }
  );
  assert.equal(out.code, "PASSWORD_REQUIRED");
  assert.equal(out.message, "T(apiErrors.passwordRequired)");
  assert.equal(out.detail, "currentPassword required for security-impacting setting changes");
});

test("every mapped code has a translation key in the common.apiErrors namespace", () => {
  for (const [code, key] of Object.entries(API_ERROR_CODE_MESSAGE_KEYS)) {
    assert.match(key, /^apiErrors\.[a-zA-Z]+$/, code);
  }
  assert.ok(Object.keys(API_ERROR_CODE_MESSAGE_KEYS).length >= 6);
});

test("an unknown code or a string error falls through to the server text (no detail duplication)", () => {
  const str = presentApiError({ error: "Unauthorized" }, { translate, fallback: "Fallback" });
  // `details` carries the per-field validation messages; neither body here has any,
  // and an empty array rather than undefined is what a caller can spread safely.
  assert.deepEqual(str, { message: "Unauthorized", code: null, detail: null, details: [] });

  const unknown = presentApiError(
    { error: { code: "SOMETHING_NEW", message: "Something new happened" } },
    { translate, fallback: "Fallback" }
  );
  assert.deepEqual(unknown, {
    message: "Something new happened",
    code: "SOMETHING_NEW",
    detail: null,
    details: [],
  });
});

test("a message-less object never leaks JSON into the user-facing text", () => {
  const out = presentApiError(
    { error: { details: [{ field: "password", message: "too short" }] } },
    { translate, fallback: "Could not save" }
  );
  assert.equal(out.message, "Could not save");
  assert.equal(out.code, null);
  assert.ok(out.detail && out.detail.includes("too short"), "technical detail preserved");
  assert.ok(!out.message.startsWith("{"));
});

test("without a translator the code still yields a readable message, and a missing translation falls back", () => {
  const noTranslate = presentApiError(
    { error: { code: "PASSWORD_MISMATCH", message: "Invalid current password" } },
    { fallback: "Fallback" }
  );
  assert.equal(noTranslate.message, "Invalid current password");

  const missing = presentApiError(
    { error: { code: "PASSWORD_MISMATCH", message: "Invalid current password" } },
    { translate: () => null, fallback: "Fallback" }
  );
  assert.equal(missing.message, "Invalid current password");
  assert.equal(missing.detail, null);
});

test("empty / null bodies produce the fallback (optionally status-qualified)", () => {
  assert.equal(presentApiError(null, { fallback: "Fallback" }).message, "Fallback");
  assert.equal(
    presentApiError({}, { fallback: "Fallback", status: 500 }).message,
    "Fallback (HTTP 500)"
  );
});
