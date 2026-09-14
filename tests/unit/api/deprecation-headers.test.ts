/**
 * buildDeprecationHeaders — RFC 9745 `Deprecation`, RFC 8594 `Sunset`, and the
 * rel="deprecation" / rel="sunset" `Link` values for deprecated API operations
 * (policy: docs/architecture/API_GOVERNANCE.md).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildDeprecationHeaders } from "../../../src/lib/api/deprecationHeaders.ts";

const policy = {
  deprecatedAt: new Date("2026-06-21T00:00:00Z"),
  sunsetAt: new Date("2026-12-31T00:00:00Z"),
  infoUrl: "/docs/architecture/api_governance",
};

test("Deprecation is an RFC 9745 structured-field Date (@unix-seconds)", () => {
  const headers = buildDeprecationHeaders(policy);
  assert.equal(headers.Deprecation, "@1782000000");
  assert.equal(Number(headers.Deprecation.slice(1)) * 1000, policy.deprecatedAt.getTime());
});

test("Sunset is an RFC 8594 IMF-fixdate", () => {
  const headers = buildDeprecationHeaders(policy);
  assert.equal(headers.Sunset, "Thu, 31 Dec 2026 00:00:00 GMT");
  assert.match(headers.Sunset, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
});

test("Link carries both deprecation and sunset relations to the policy URI", () => {
  const headers = buildDeprecationHeaders(policy);
  assert.equal(
    headers.Link,
    '</docs/architecture/api_governance>; rel="deprecation", </docs/architecture/api_governance>; rel="sunset"'
  );
});

test("sub-second deprecation instants are floored to whole seconds", () => {
  const headers = buildDeprecationHeaders({
    ...policy,
    deprecatedAt: new Date("2026-06-21T00:00:00.999Z"),
  });
  assert.equal(headers.Deprecation, "@1782000000");
});

test("a sunset before the deprecation date is rejected", () => {
  assert.throws(
    () =>
      buildDeprecationHeaders({
        ...policy,
        sunsetAt: new Date("2026-01-01T00:00:00Z"),
      }),
    RangeError
  );
});

test("invalid dates are rejected", () => {
  assert.throws(
    () => buildDeprecationHeaders({ ...policy, deprecatedAt: new Date("not a date") }),
    RangeError
  );
});

test("a Link target that could break out of the header field is rejected", () => {
  for (const infoUrl of ["", "/docs/a b", "/docs/a>", "/docs/a\r\nSet-Cookie: x=1", "<x"]) {
    assert.throws(() => buildDeprecationHeaders({ ...policy, infoUrl }), RangeError, infoUrl);
  }
});
