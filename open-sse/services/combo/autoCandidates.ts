/**
 * Builds the `auto` strategy's candidate rows: one `AutoProviderCandidate` per resolved combo
 * target, carrying the price, latency, quota, circuit and session signals the scoring engine
 * reads. It owns every input the engine scores and nothing about how the engine scores them.
 *
 * Targets are first expanded (prompt-cache affinity per connection, then per fingerprint) so each
 * routable connection gets its own candidate, then each candidate is priced, given a latency
 * profile (24h history when there are enough samples, otherwise the live combo metric, otherwise a
 * per-model bootstrap default) and checked against the opt-in quota cutoff. Candidates whose model
 * the user hid, or which the vendor retired, are dropped.
 *
 * Extracted from `open-sse/services/combo.ts` (#3501), which keeps re-exporting
 * `buildAutoCandidates` for its existing importers.
 */
import { getHiddenModelsByProvider } from "@/models";
import { getCachedProviderConnections } from "../../../src/lib/db/readCache";
import {
  resolveResilienceSettings,
  type ResilienceSettings,
} from "../../../src/lib/resilience/settings";
import { resolveProviderId } from "../../../src/shared/constants/providers.ts";
import { getCircuitBreaker } from "../../../src/shared/utils/circuitBreaker";
import { getQuotaFetchScope } from "../antigravityQuotaFamily.ts";
import { type ProviderCandidate } from "../autoCombo/scoring.ts";
import { getComboMetrics } from "../comboMetrics.ts";
import { parseModel } from "../model.ts";
import { rejectRetiredAutoComboCandidates } from "../modelLifecycle.ts";
import { getOAuthSessionAvailability } from "../oauthSessionOccupancy.ts";
import { evaluateQuotaCutoff, getQuotaFetcher, type QuotaInfo } from "../quotaPreflight.ts";
import { qualityScoreFor } from "../routing/index.ts";
import { getSessionConnection } from "../sessionManager.ts";
import { deriveSpeedTelemetry } from "./autoStrategy.ts";
import {
  quotaRemainingPercentFromQuota,
  getConnectionStatusQuotaCutoffReason,
} from "./comboPredicates.ts";
import { expandTargetsByFingerprints } from "./fingerprintExpansion.ts";
import { expandPromptCacheAffinityTargetsFromConnections } from "./promptCacheAffinity.ts";
import { buildAutoQuotaThresholds } from "./quotaExhaustionCutoff.ts";
import {
  resolveResetWindowConfig,
  calculateResetWindowAffinity,
  type ResetWindowConfig,
} from "./quotaScoring.ts";
import { fetchResetAwareQuotaWithCache } from "./quotaStrategies.ts";
import type {
  AutoProviderCandidate,
  HistoricalLatencyStatsEntry,
  ResolvedComboTarget,
} from "./types.ts";

const DEFAULT_MODEL_P95_MS: Record<string, number> = {
  "grok-4-fast-non-reasoning": 1143,
  "grok-4-1-fast-non-reasoning": 1244,
  "gemini-2.5-flash": 1238,
  "kimi-k2.5": 1646,
  "gpt-4o-mini": 2764,
  "claude-sonnet-4.6": 4000,
  "claude-opus-4.6": 6000,
  "deepseek-chat": 2000,
};
const MIN_HISTORY_SAMPLES = 10;
const OUTPUT_TOKEN_RATIO = 0.4;

function calculateTargetContextAffinity(
  target: ResolvedComboTarget,
  sessionId: string | null | undefined
): number {
  const sessionConnectionId = getSessionConnection(sessionId || null);
  if (!sessionConnectionId) return 0.5;
  if (target.connectionId === sessionConnectionId) return 1;
  if (!target.connectionId) return 0.5;
  return 0.1;
}

function getBootstrapLatencyMs(modelId: string): number {
  const normalized = String(modelId || "").toLowerCase();
  return DEFAULT_MODEL_P95_MS[normalized] ?? 1500;
}

export async function buildAutoCandidates(
  targets: ResolvedComboTarget[],
  comboName: string,
  sessionId: string | null | undefined = null,
  resetWindowConfig: ResetWindowConfig = resolveResetWindowConfig(null),
  resilienceSettings: ResilienceSettings | null = null
): Promise<AutoProviderCandidate[]> {
  const hiddenModelsMap = getHiddenModelsByProvider();
  const metrics = getComboMetrics(comboName);
  // Opt-in hard quota cutoff (default OFF). When disabled, candidates are never
  // dropped for low quota here — the soft quota penalty + connection cooldown still
  // apply, so auto-routing behavior is unchanged.
  const quotaCutoffEnabled =
    (resilienceSettings ?? resolveResilienceSettings(null))?.quotaPreflight?.enabled === true;
  const { getPricingForModel } = await import("@/lib/db/settings");
  const quotaPromises = new Map<string, Promise<unknown>>();
  let historicalLatencyStats: Record<string, HistoricalLatencyStatsEntry> = {};
  try {
    const { getModelLatencyStats } = await import("../../../src/lib/usageDb");
    historicalLatencyStats = await getModelLatencyStats({
      windowHours: 24,
      minSamples: 3,
      maxRows: 10000,
    });
  } catch {
    // keep empty stats — auto-combo will use runtime + bootstrap signals
  }

  const uniqueProviders = Array.from(
    new Set(
      targets.map((target) => target.provider || parseModel(target.modelStr).provider || "unknown")
    )
  );
  const connectionPoolCounts = new Map<string, number>();
  const connectionsByProvider = new Map<string, Array<Record<string, unknown>>>();
  const connectionById = new Map<string, Record<string, unknown>>();
  await Promise.all(
    uniqueProviders.map(async (provider) => {
      try {
        const connections = (await getCachedProviderConnections({
          provider,
          isActive: true,
        })) as Array<Record<string, unknown>>;
        const active = Array.isArray(connections) ? connections : [];
        connectionPoolCounts.set(provider, active.length);
        connectionsByProvider.set(provider, active);
        for (const connection of active) {
          if (connection && typeof connection === "object" && typeof connection.id === "string") {
            connectionById.set(connection.id, connection as Record<string, unknown>);
          }
        }
      } catch {
        connectionPoolCounts.set(provider, 0);
        connectionsByProvider.set(provider, []);
      }
    })
  );

  const expandedTargets = expandPromptCacheAffinityTargetsFromConnections(
    targets,
    connectionsByProvider
  );

  // #5521: Expand fingerprint-based providers (mimocode, mcode, opencode) so each
  // fingerprint gets its own combo slot instead of being bundled into one connection.
  const fingerprintExpandedTargets = expandTargetsByFingerprints(
    expandedTargets,
    connectionById,
    (t) => {
      const parsed = parseModel(t.modelStr);
      return t.provider || parsed.provider || parsed.providerAlias || "unknown";
    }
  );

  const candidates = await Promise.all(
    fingerprintExpandedTargets.map(async (target) => {
      const modelStr = target.modelStr;
      const parsed = parseModel(modelStr);
      const provider = target.provider || parsed.provider || parsed.providerAlias || "unknown";
      const model = parsed.model || modelStr;
      const historicalKey = `${provider}/${model}`;
      const historicalModelMetric = historicalLatencyStats[historicalKey] || null;
      const historicalTotal = Number(historicalModelMetric?.totalRequests);
      const hasHistoricalSignal =
        Number.isFinite(historicalTotal) && historicalTotal >= MIN_HISTORY_SAMPLES;

      let costPer1MTokens = 1;
      try {
        const pricing = await getPricingForModel(provider, model);
        const inputPrice = Number(pricing?.input);
        const outputPrice = Number(pricing?.output);
        if (Number.isFinite(inputPrice) && inputPrice >= 0) {
          if (Number.isFinite(outputPrice) && outputPrice >= 0) {
            costPer1MTokens =
              inputPrice * (1 - OUTPUT_TOKEN_RATIO) + outputPrice * OUTPUT_TOKEN_RATIO;
          } else {
            costPer1MTokens = inputPrice;
          }
        }
      } catch {
        // keep default cost
      }

      const modelMetric = metrics?.byModel?.[modelStr] || null;
      const avgLatency = Number(modelMetric?.avgLatencyMs);
      const successRate = Number(modelMetric?.successRate);
      const historicalP95Latency = Number(historicalModelMetric?.p95LatencyMs);
      const historicalStdDev = Number(historicalModelMetric?.latencyStdDev);
      const historicalSuccessRate = Number(historicalModelMetric?.successRate); // 0..1

      const p95LatencyMs = hasHistoricalSignal
        ? Number.isFinite(historicalP95Latency) && historicalP95Latency > 0
          ? historicalP95Latency
          : getBootstrapLatencyMs(model)
        : Number.isFinite(avgLatency) && avgLatency > 0
          ? avgLatency
          : getBootstrapLatencyMs(model);

      const errorRate = hasHistoricalSignal
        ? Number.isFinite(historicalSuccessRate) &&
          historicalSuccessRate >= 0 &&
          historicalSuccessRate <= 1
          ? 1 - historicalSuccessRate
          : 0.05
        : Number.isFinite(successRate) && successRate >= 0 && successRate <= 100
          ? 1 - successRate / 100
          : 0.05;
      const latencyStdDev =
        hasHistoricalSignal && Number.isFinite(historicalStdDev) && historicalStdDev > 0
          ? Math.max(10, historicalStdDev)
          : Math.max(10, p95LatencyMs * 0.1);
      // #6875: surface TTFT/E2E-latency/tokens-per-second onto the candidate so the
      // existing speed-ranking factor (#6011, speedRanking.ts/routerStrategy.ts) picks
      // up real telemetry instead of falling back to the pool median. Additive only —
      // no scoring weights change here.
      const speedTelemetry = hasHistoricalSignal
        ? deriveSpeedTelemetry(historicalModelMetric)
        : undefined;

      const breakerStateRaw = getCircuitBreaker(provider)?.getStatus?.()?.state;
      const circuitBreakerState: ProviderCandidate["circuitBreakerState"] =
        breakerStateRaw === "OPEN" || breakerStateRaw === "HALF_OPEN" ? breakerStateRaw : "CLOSED";
      const contextAffinity = calculateTargetContextAffinity(target, sessionId);
      let resetWindowAffinity = 0.5;
      let quotaRemaining = 100;
      let quotaCutoffBlocked = false;
      let quotaCutoffReason: string | undefined;
      // #10877: `provider` here may be a legacy/user-facing alias spelling
      // (target.provider/parseModel output); canonicalize before the fetcher
      // registry lookup so aliased combo members still hit quota-aware scoring.
      const fetcher = getQuotaFetcher(resolveProviderId(provider));
      const connection = target.connectionId ? connectionById.get(target.connectionId) : undefined;
      const authType = typeof connection?.authType === "string" ? connection.authType : null;
      const sessionAvailability =
        authType === "oauth" ? getOAuthSessionAvailability(target.connectionId, sessionId) : 1;
      // Gate the terminal-status cutoff behind the same opt-in as the quota-percent
      // cutoff (#4483): when quota cutoff is disabled, a connection in a terminal
      // testStatus must still fall through to normal connection-cooldown / model-lockout
      // handling instead of being hard-blocked here (which would surface a misleading
      // "below quota cutoff" 429 when every candidate is transiently unavailable).
      // The connection's terminal/transient status (credits_exhausted / rate_limited /
      // banned / expired / future-dated unavailable) is classified unconditionally.
      const connectionStatusReason = getConnectionStatusQuotaCutoffReason(connection);
      const statusCutoffReason = quotaCutoffEnabled ? connectionStatusReason : undefined;
      // #4540: when the HARD cutoff is OFF (default), a status-flagged connection is NOT
      // hard-blocked (that would surface a misleading "below quota cutoff" 429), but it
      // also must not score identically to a healthy provider. A no-fetcher exhausted
      // connection keeps quotaRemaining=100, so we tag a SOFT penalty applied at scoring
      // time (scoreAutoTargets → STATUS_SOFT_DEPRIORITIZE_FACTOR) instead.
      let statusPenalty = false;
      let statusPenaltyReason: string | undefined;
      if (statusCutoffReason) {
        quotaCutoffBlocked = true;
        quotaCutoffReason = statusCutoffReason;
        quotaRemaining = 0;
      } else if (connectionStatusReason) {
        statusPenalty = true;
        statusPenaltyReason = connectionStatusReason;
      }
      if (fetcher && target.connectionId) {
        const quotaScope = getQuotaFetchScope(provider, target.modelStr);
        const quotaKey = `${provider}:${target.connectionId}:${quotaScope}`;
        if (!quotaPromises.has(quotaKey)) {
          quotaPromises.set(
            quotaKey,
            fetchResetAwareQuotaWithCache({
              provider,
              connectionId: target.connectionId,
              connection: connection
                ? { ...connection, requestedModel: target.modelStr }
                : connection,
              fetcher,
              config: resetWindowConfig,
              log: {},
              comboName,
            })
          );
        }
        const quota = await quotaPromises.get(quotaKey)!;
        resetWindowAffinity = calculateResetWindowAffinity(quota, resetWindowConfig);
        if (!quotaCutoffBlocked) {
          quotaRemaining = quotaRemainingPercentFromQuota(quota, {
            provider,
            requestedModel: modelStr,
          });
        }
        if (!quotaCutoffBlocked && quotaCutoffEnabled) {
          const cutoffDecision = evaluateQuotaCutoff(
            quota as QuotaInfo | null,
            buildAutoQuotaThresholds(provider, connection, resilienceSettings),
            { provider, requestedModel: modelStr }
          );
          if (!cutoffDecision.proceed) {
            quotaCutoffBlocked = true;
            quotaCutoffReason = cutoffDecision.reason || "quota_exhausted";
          }
        }
      }

      return {
        stepId: target.stepId,
        executionKey: target.executionKey,
        modelStr,
        provider,
        model,
        quotaRemaining,
        quotaTotal: 100,
        circuitBreakerState,
        costPer1MTokens,
        p95LatencyMs,
        latencyStdDev,
        errorRate,
        ...speedTelemetry,
        accountTier: "standard" as const,
        quotaResetIntervalSecs: 86400,
        contextAffinity,
        sessionAvailability,
        resetWindowAffinity,
        quotaCutoffBlocked,
        quotaCutoffReason,
        statusPenalty,
        statusPenaltyReason,
        connectionPoolSize: connectionPoolCounts.get(provider) ?? 1,
        connectionId: target.connectionId ?? undefined,
        authType,
        // Feedback-driven quality signal (routing quality tracker). Neutral 1.0
        // before enough samples accumulate — a cold model is never penalized.
        quality: qualityScoreFor(provider, model),
      };
    })
  );

  // Filter out candidates whose model is hidden by the user in the dashboard,
  // then drop vendor-retired ids so auto-combo cannot pick them (#11625).
  return rejectRetiredAutoComboCandidates(
    candidates.filter((c) => {
      const hiddenModels = hiddenModelsMap.get(c.provider);
      return !hiddenModels?.has(c.model);
    })
  );
}
