/**
 * Response headers announcing that an API operation is deprecated.
 *
 * - `Deprecation` (RFC 9745): the moment the operation became deprecated, as a
 *   structured-field Date — `@` followed by Unix seconds.
 * - `Sunset` (RFC 8594): the HTTP-date (IMF-fixdate) after which the operation may
 *   stop responding.
 * - `Link`: `rel="deprecation"` (RFC 9745) and `rel="sunset"` (RFC 8594) pointing at
 *   the human-readable policy.
 *
 * Every deprecated operation in docs/openapi.yaml (`deprecated: true` + `x-sunset`)
 * must emit these headers; the policy lives in docs/architecture/API_GOVERNANCE.md.
 */

export interface DeprecationPolicy {
  /** When the operation was deprecated. */
  deprecatedAt: Date;
  /** When the operation may be removed; must not precede `deprecatedAt`. */
  sunsetAt: Date;
  /** URI (absolute or origin-relative) of the documentation explaining the deprecation. */
  infoUrl: string;
}

// A Link target is emitted inside `<...>`; angle brackets, spaces and control
// characters (CR/LF included) would let the value break out of the header field.
function isSafeLinkTarget(uri: string): boolean {
  if (uri.length === 0) return false;
  for (const char of uri) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || char === "<" || char === ">") return false;
  }
  return true;
}

export function buildDeprecationHeaders(policy: DeprecationPolicy): Record<string, string> {
  const deprecatedMs = policy.deprecatedAt.getTime();
  const sunsetMs = policy.sunsetAt.getTime();
  if (!Number.isFinite(deprecatedMs) || !Number.isFinite(sunsetMs)) {
    throw new RangeError("Deprecation policy dates must be valid dates");
  }
  if (sunsetMs < deprecatedMs) {
    throw new RangeError("Sunset date must not precede the deprecation date");
  }
  if (!isSafeLinkTarget(policy.infoUrl)) {
    throw new RangeError("Deprecation infoUrl must be a non-empty URI without spaces or brackets");
  }
  return {
    Deprecation: `@${Math.floor(deprecatedMs / 1000)}`,
    Sunset: new Date(sunsetMs).toUTCString(),
    Link: `<${policy.infoUrl}>; rel="deprecation", <${policy.infoUrl}>; rel="sunset"`,
  };
}
