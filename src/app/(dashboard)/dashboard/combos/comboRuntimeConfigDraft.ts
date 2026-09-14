// Client-side draft of combo.config. Field types mirror comboRuntimeConfigSchema
// (src/shared/validation/schemas/combo.ts) for the fields this form reads directly;
// other keys stay open through the index signature.
type ComboFusionTuningDraft = {
  minPanel?: number;
  stragglerGraceMs?: number;
  panelHardTimeoutMs?: number;
  maxPanel?: number;
};

export interface ComboRuntimeConfigDraft {
  [key: string]: unknown;
  maxRetries?: number;
  retryDelayMs?: number;
  maxSetRetries?: number;
  setRetryDelayMs?: number;
  concurrencyPerModel?: number;
  queueTimeoutMs?: number;
  stickyRoundRobinLimit?: number;
  stickyWeightedLimit?: number;
  nestedComboMode?: "flatten" | "execute";
  handoffThreshold?: number;
  maxMessagesForSummary?: number;
  handoffModel?: string;
  judgeModel?: string;
  fusionTuning?: ComboFusionTuningDraft;
  weights?: Record<string, number>;
}
