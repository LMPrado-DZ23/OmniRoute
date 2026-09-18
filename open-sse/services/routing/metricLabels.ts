/**
 * Metric label policy — keeps Prometheus/JSON metric labels bounded and free of
 * sensitive data.
 *
 * Rules enforced here (see docs/ops/MONITORING_GUIDE.md "Label policy"):
 *  - Only allowlisted label NAMES exist: provider, model, strategy, outcome,
 *    status_class, direction, engine, state, status, objective.
 *  - Label VALUES are normalized to a conservative charset and truncated.
 *  - Values that look like credentials (API-key prefixes, long opaque tokens,
 *    e-mail addresses) are replaced with "redacted" — a label must never carry
 *    an API key, connection id, account id, prompt or response.
 *  - Every dynamic label dimension goes through a `BoundedLabelSet`: the first N
 *    distinct values are kept, everything after that collapses into "other", so
 *    10k distinct model ids can never create 10k series.
 */

/** Maximum length of a single label value after normalization. */
const MAX_LABEL_VALUE_LENGTH = 80;

/** Collapsed bucket for values beyond a dimension's cap. */
export const OTHER_LABEL_VALUE = "other";
const REDACTED_LABEL_VALUE = "redacted";
const UNKNOWN_LABEL_VALUE = "unknown";

const SECRET_PREFIX_RE =
  /^(sk|pk|rk|ak|sess|key|token|bearer|xox[abprs]|ghp|gho|ghs|ghu|github_pat|glpat|aiza|ya29)[-_.]/i;
/** An uninterrupted opaque run of 32+ alphanumerics (hex/base64 tokens, UUID-less ids). */
const OPAQUE_TOKEN_RE = /[A-Za-z0-9+/=]{32,}/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** True when a raw value looks like a secret or a personal/opaque identifier. */
function looksSensitive(value: string): boolean {
  return (
    SECRET_PREFIX_RE.test(value) ||
    OPAQUE_TOKEN_RE.test(value) ||
    EMAIL_RE.test(value) ||
    UUID_RE.test(value)
  );
}

/**
 * Normalize an arbitrary value into a safe label value: trimmed, restricted to
 * `[A-Za-z0-9._:/-]`, truncated, and redacted when it looks sensitive.
 */
export function sanitizeLabelValue(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return UNKNOWN_LABEL_VALUE;
  const value = String(raw).trim();
  if (value.length === 0) return UNKNOWN_LABEL_VALUE;
  if (looksSensitive(value)) return REDACTED_LABEL_VALUE;
  const normalized = value.replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, MAX_LABEL_VALUE_LENGTH);
  return normalized.length > 0 ? normalized : UNKNOWN_LABEL_VALUE;
}

/** Map an HTTP status to a bounded class label: 1xx..5xx, or "none". */
export function statusClassOf(status: number | null | undefined): string {
  if (typeof status !== "number" || !Number.isFinite(status)) return "none";
  const cls = Math.floor(status / 100);
  return cls >= 1 && cls <= 5 ? `${cls}xx` : "none";
}

/**
 * A label dimension with a hard cardinality cap. `resolve()` returns the
 * sanitized value when it is already tracked or there is room, otherwise
 * "other". Membership is first-come; the set never grows past `capacity`.
 */
export class BoundedLabelSet {
  private readonly values = new Set<string>();

  constructor(readonly capacity: number) {}

  resolve(raw: unknown): string {
    const value = sanitizeLabelValue(raw);
    if (this.values.has(value)) return value;
    if (this.values.size < this.capacity) {
      this.values.add(value);
      return value;
    }
    return OTHER_LABEL_VALUE;
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }
}
