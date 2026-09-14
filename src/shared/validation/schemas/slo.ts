import { z } from "zod";

/**
 * Service level objectives (GET /api/metrics + SLO alert webhooks), stored under
 * the `slo` settings key and wired into updateSettingsSchema
 * (src/shared/validation/settingsSchemas.ts).
 *
 * Kept in a zod-only leaf module: schemas/settings.ts and settingsSchemas.ts
 * import each other, so defining it there hits a temporal-dead-zone cycle.
 *
 * Every field is optional on the wire; resolveSloSettings() in
 * src/lib/monitoring/sloSettings.ts fills the documented defaults.
 */
export const sloSettingsSchema = z
  .object({
    alertsEnabled: z.boolean().optional(),
    /** Minimum success ratio (0.5..1) over the window. */
    availabilityTarget: z.number().min(0.5).max(1).optional(),
    latencyP95Ms: z.number().int().min(1).max(3_600_000).optional(),
    latencyP99Ms: z.number().int().min(1).max(3_600_000).optional(),
    ttftP95Ms: z.number().int().min(1).max(3_600_000).optional(),
    /** Maximum hard-error ratio (0..1) over the window. */
    errorRateMax: z.number().min(0).max(1).optional(),
    /** Minimum success ratio (0..1) of combo requests that needed a fallback. */
    failoverSuccessRateMin: z.number().min(0).max(1).optional(),
    /** Maximum circuit-breaker OPEN→CLOSED recovery time per provider. */
    providerRecoveryMaxMs: z.number().int().min(1000).max(86_400_000).optional(),
    windowMinutes: z.number().int().min(1).max(60).optional(),
    minSamples: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
