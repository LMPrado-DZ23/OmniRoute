import { resolveSloSettings, type SloSettings } from "@/lib/monitoring/sloSettings";
import { sloSettingsSchema } from "@/shared/validation/schemas/slo";

/**
 * Form model for the Settings → Resilience "Service level objectives" card (audit C M1).
 *
 * Ratios (availability, error rate, failover success) are edited as percentages and stored
 * as fractions; everything else is stored as typed. The bounds below are the display-unit
 * mirror of `sloSettingsSchema`, which stays the authority: `parseSloForm` validates the
 * converted object with it before anything is sent to `PATCH /api/settings`.
 */
export type SloNumericKey = Exclude<keyof SloSettings, "alertsEnabled">;

interface SloFieldSpec {
  key: SloNumericKey;
  /** `percent` fields are shown ×100 and stored ÷100. */
  percent: boolean;
  /** Integer fields reject decimals. */
  integer: boolean;
  min: number;
  max: number;
}

export const SLO_FIELDS: readonly SloFieldSpec[] = [
  { key: "availabilityTarget", percent: true, integer: false, min: 50, max: 100 },
  { key: "errorRateMax", percent: true, integer: false, min: 0, max: 100 },
  { key: "failoverSuccessRateMin", percent: true, integer: false, min: 0, max: 100 },
  { key: "latencyP95Ms", percent: false, integer: true, min: 1, max: 3_600_000 },
  { key: "latencyP99Ms", percent: false, integer: true, min: 1, max: 3_600_000 },
  { key: "ttftP95Ms", percent: false, integer: true, min: 1, max: 3_600_000 },
  { key: "providerRecoveryMaxMs", percent: false, integer: true, min: 1000, max: 86_400_000 },
  { key: "windowMinutes", percent: false, integer: true, min: 1, max: 60 },
  { key: "minSamples", percent: false, integer: true, min: 1, max: 1_000_000 },
];

export type SloFormValues = Record<SloNumericKey, string>;

/** Percent display without floating-point noise (0.995 → "99.5"). */
function toPercentText(fraction: number): string {
  return String(Number((fraction * 100).toFixed(4)));
}

export function toSloForm(settings: SloSettings): SloFormValues {
  const format = (key: SloNumericKey) => {
    const spec = SLO_FIELDS.find((field) => field.key === key);
    return spec?.percent ? toPercentText(settings[key]) : String(settings[key]);
  };
  return {
    availabilityTarget: format("availabilityTarget"),
    errorRateMax: format("errorRateMax"),
    failoverSuccessRateMin: format("failoverSuccessRateMin"),
    latencyP95Ms: format("latencyP95Ms"),
    latencyP99Ms: format("latencyP99Ms"),
    ttftP95Ms: format("ttftP95Ms"),
    providerRecoveryMaxMs: format("providerRecoveryMaxMs"),
    windowMinutes: format("windowMinutes"),
    minSamples: format("minSamples"),
  };
}

function parseField(field: SloFieldSpec, raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < field.min || value > field.max) return null;
  if (field.integer && !Number.isInteger(value)) return null;
  return field.percent ? Number((value / 100).toFixed(6)) : value;
}

// String discriminant: the dashboard typecheck runs without strictNullChecks, where a boolean
// discriminant does not narrow.
type SloFormResult =
  { status: "valid"; value: SloSettings } | { status: "invalid"; invalid: SloNumericKey[] };

/** Converts the form back to stored units and validates it against the API schema. */
export function parseSloForm(form: SloFormValues, alertsEnabled: boolean): SloFormResult {
  const invalid: SloNumericKey[] = [];
  const numbers: Partial<Record<SloNumericKey, number>> = {};
  for (const field of SLO_FIELDS) {
    const parsed = parseField(field, form[field.key]);
    if (parsed === null) invalid.push(field.key);
    else numbers[field.key] = parsed;
  }
  if (invalid.length > 0) return { status: "invalid", invalid };

  const checked = sloSettingsSchema.safeParse({ alertsEnabled, ...numbers });
  if (!checked.success) {
    const keys = checked.error.issues.map((issue) => String(issue.path[0]));
    return {
      status: "invalid",
      invalid: SLO_FIELDS.map((f) => f.key).filter((k) => keys.includes(k)),
    };
  }
  // Every field is present here, so resolving only normalises the type (no default is used).
  return { status: "valid", value: resolveSloSettings(checked.data) };
}
