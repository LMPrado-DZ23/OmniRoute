import { sloSettingsSchema } from "@/shared/validation/schemas/slo";

/** Fully resolved SLO settings (every threshold present). */
export interface SloSettings {
  alertsEnabled: boolean;
  availabilityTarget: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  ttftP95Ms: number;
  errorRateMax: number;
  failoverSuccessRateMin: number;
  providerRecoveryMaxMs: number;
  windowMinutes: number;
  minSamples: number;
}

/**
 * Defaults are sized for LLM traffic (long generations, streaming) and are the
 * values documented in docs/ops/MONITORING_GUIDE.md "SLO settings".
 */
const DEFAULT_SLO_SETTINGS: Readonly<SloSettings> = {
  alertsEnabled: true,
  availabilityTarget: 0.99,
  latencyP95Ms: 30_000,
  latencyP99Ms: 60_000,
  ttftP95Ms: 5_000,
  errorRateMax: 0.05,
  failoverSuccessRateMin: 0.8,
  providerRecoveryMaxMs: 300_000,
  windowMinutes: 15,
  minSamples: 20,
};

/**
 * Resolve the stored `slo` settings object into a complete SloSettings. Invalid
 * or missing input falls back to the defaults (never throws), so a malformed
 * row cannot disable monitoring.
 */
export function resolveSloSettings(raw: unknown): SloSettings {
  const parsed = sloSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ...DEFAULT_SLO_SETTINGS };
  const value = parsed.data;
  const d = DEFAULT_SLO_SETTINGS;
  return {
    alertsEnabled: value.alertsEnabled ?? d.alertsEnabled,
    availabilityTarget: value.availabilityTarget ?? d.availabilityTarget,
    latencyP95Ms: value.latencyP95Ms ?? d.latencyP95Ms,
    latencyP99Ms: value.latencyP99Ms ?? d.latencyP99Ms,
    ttftP95Ms: value.ttftP95Ms ?? d.ttftP95Ms,
    errorRateMax: value.errorRateMax ?? d.errorRateMax,
    failoverSuccessRateMin: value.failoverSuccessRateMin ?? d.failoverSuccessRateMin,
    providerRecoveryMaxMs: value.providerRecoveryMaxMs ?? d.providerRecoveryMaxMs,
    windowMinutes: value.windowMinutes ?? d.windowMinutes,
    minSamples: value.minSamples ?? d.minSamples,
  };
}
