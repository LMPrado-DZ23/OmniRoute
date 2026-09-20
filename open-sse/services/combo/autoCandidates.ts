/**
 * Builds the `auto` strategy's candidate rows: one `AutoProviderCandidate` per resolved combo
 * target, carrying the price, latency, quota, circuit and session signals the scoring engine
 * reads. It owns every input the engine scores and nothing about how the engine scores them.
 *
 * The work is split by the signal it resolves, so each part can be read and changed on its own:
 * `loadProviderConnections` (the connection pool per provider), `expandCandidateTargets` (one
 * target per routable connection/fingerprint), `resolveCandidateCost` (price per 1M tokens),
 * `resolveLatencyProfile` (p95, jitter, error rate and speed telemetry) and
 * `resolveQuotaSignals` (reset-window affinity, remaining quota, the opt-in hard cutoff and the
 * soft status penalty). `buildAutoCandidates` only sequences them and assembles the row.
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

/** Provider id for a target, preferring the explicit one over the parsed model string. */
function targetProviderId(target: { modelStr: string; provider?: string | null }): string {
  const parsed = parseModel(target.modelStr);
  return target.provider || parsed.provider || parsed.providerAlias || "unknown";
}

/** 24h latency history. An unavailable stats table leaves runtime + bootstrap signals in charge. */
async function loadHistoricalLatencyStats(): Promise<Record<string, HistoricalLatencyStatsEntry>> {
  try {
    const { getModelLatencyStats } = await import("../../../src/lib/usageDb");
    return await getModelLatencyStats({ windowHours: 24, minSamples: 3, maxRows: 10000 });
  } catch {
    return {};
  }
}

interface ProviderConnections {
  /** Active connection count per provider, the connection-density scoring input. */
  poolCounts: Map<string, number>;
  byProvider: Map<string, Array<Record<string, unknown>>>;
  byId: Map<string, Record<string, unknown>>;
}

/** The active connections of every provider in the pool. A provider that throws reads as empty. */
async function loadProviderConnections(
  targets: ResolvedComboTarget[]
): Promise<ProviderConnections> {
  const connections: ProviderConnections = {
    poolCounts: new Map(),
    byProvider: new Map(),
    byId: new Map(),
  };
  // The pool lookup deliberately ignores the provider alias (unlike `targetProviderId`): an
  // alias-only target has always been looked up under "unknown", and changing that here would
  // change which connections every candidate of that provider sees.
  const uniqueProviders = Array.from(
    new Set(
      targets.map((target) => target.provider || parseModel(target.modelStr).provider || "unknown")
    )
  );
  await Promise.all(
    uniqueProviders.map(async (provider) => {
      try {
        const rows = (await getCachedProviderConnections({
          provider,
          isActive: true,
        })) as Array<Record<string, unknown>>;
        const active = Array.isArray(rows) ? rows : [];
        connections.poolCounts.set(provider, active.length);
        connections.byProvider.set(provider, active);
        for (const connection of active) {
          if (connection && typeof connection === "object" && typeof connection.id === "string") {
            connections.byId.set(connection.id, connection);
          }
        }
      } catch {
        connections.poolCounts.set(provider, 0);
        connections.byProvider.set(provider, []);
      }
    })
  );
  return connections;
}

/**
 * One target per routable slot: first per prompt-cache-affinity connection, then (#5521) per
 * fingerprint for the fingerprint providers (mimocode, mcode, opencode), so each fingerprint gets
 * its own combo slot instead of being bundled into one connection.
 */
function expandCandidateTargets(
  targets: ResolvedComboTarget[],
  connections: ProviderConnections
): ResolvedComboTarget[] {
  const byConnection = expandPromptCacheAffinityTargetsFromConnections(
    targets,
    connections.byProvider
  );
  return expandTargetsByFingerprints(byConnection, connections.byId, targetProviderId);
}

type PricingLookup = (
  provider: string,
  model: string
) => Promise<{ input?: unknown; output?: unknown } | null | undefined>;

/**
 * Blended price per 1M tokens at the request's assumed input/output split. An unknown or invalid
 * price keeps the neutral default of 1, so a model with no pricing row is neither favoured nor
 * punished by the cost factor.
 */
async function resolveCandidateCost(
  getPricingForModel: PricingLookup,
  provider: string,
  model: string
): Promise<number> {
  try {
    const pricing = await getPricingForModel(provider, model);
    const inputPrice = Number(pricing?.input);
    if (!Number.isFinite(inputPrice) || inputPrice < 0) return 1;
    const outputPrice = Number(pricing?.output);
    if (!Number.isFinite(outputPrice) || outputPrice < 0) return inputPrice;
    return inputPrice * (1 - OUTPUT_TOKEN_RATIO) + outputPrice * OUTPUT_TOKEN_RATIO;
  } catch {
    return 1;
  }
}

interface LatencyProfile {
  p95LatencyMs: number;
  latencyStdDev: number;
  errorRate: number;
  /** TTFT / end-to-end / tokens-per-second telemetry, present only with enough history (#6875). */
  speedTelemetry: ReturnType<typeof deriveSpeedTelemetry> | undefined;
}

/** p95 from 24h history when there are enough samples, else the live combo metric, else the
 * per-model bootstrap default. */
function resolveP95LatencyMs(
  hasHistory: boolean,
  historicalP95: number,
  avgLatency: number,
  model: string
): number {
  if (hasHistory) {
    return Number.isFinite(historicalP95) && historicalP95 > 0
      ? historicalP95
      : getBootstrapLatencyMs(model);
  }
  return Number.isFinite(avgLatency) && avgLatency > 0 ? avgLatency : getBootstrapLatencyMs(model);
}

/** Observed failure share. Historical success is a 0..1 rate, the live metric a 0..100 percent. */
function resolveErrorRate(
  hasHistory: boolean,
  historicalSuccessRate: number,
  successRatePercent: number
): number {
  if (hasHistory) {
    const usable =
      Number.isFinite(historicalSuccessRate) &&
      historicalSuccessRate >= 0 &&
      historicalSuccessRate <= 1;
    return usable ? 1 - historicalSuccessRate : 0.05;
  }
  const usable =
    Number.isFinite(successRatePercent) && successRatePercent >= 0 && successRatePercent <= 100;
  return usable ? 1 - successRatePercent / 100 : 0.05;
}

/** Latency, jitter, error rate and speed telemetry for one candidate. */
function resolveLatencyProfile(
  model: string,
  historicalMetric: HistoricalLatencyStatsEntry | null,
  liveMetric: { avgLatencyMs?: unknown; successRate?: unknown } | null
): LatencyProfile {
  const historicalTotal = Number(historicalMetric?.totalRequests);
  const hasHistory = Number.isFinite(historicalTotal) && historicalTotal >= MIN_HISTORY_SAMPLES;
  const p95LatencyMs = resolveP95LatencyMs(
    hasHistory,
    Number(historicalMetric?.p95LatencyMs),
    Number(liveMetric?.avgLatencyMs),
    model
  );
  const historicalStdDev = Number(historicalMetric?.latencyStdDev);
  const latencyStdDev =
    hasHistory && Number.isFinite(historicalStdDev) && historicalStdDev > 0
      ? Math.max(10, historicalStdDev)
      : Math.max(10, p95LatencyMs * 0.1);
  return {
    p95LatencyMs,
    latencyStdDev,
    errorRate: resolveErrorRate(
      hasHistory,
      Number(historicalMetric?.successRate),
      Number(liveMetric?.successRate)
    ),
    // #6875: surface TTFT/E2E-latency/tokens-per-second so the existing speed-ranking factor
    // (#6011) picks up real telemetry instead of falling back to the pool median. Additive only.
    speedTelemetry: hasHistory ? deriveSpeedTelemetry(historicalMetric) : undefined,
  };
}

interface QuotaSignals {
  resetWindowAffinity: number;
  quotaRemaining: number;
  quotaCutoffBlocked: boolean;
  quotaCutoffReason: string | undefined;
  /** #4540: deprioritise at scoring time instead of hard-blocking when the cutoff is OFF. */
  statusPenalty: boolean;
  statusPenaltyReason: string | undefined;
}

/**
 * The connection's terminal/transient status (credits_exhausted / rate_limited / banned / expired
 * / future-dated unavailable) is classified unconditionally, but only the opt-in hard cutoff
 * (#4483) turns it into a block: otherwise a transiently unavailable pool would answer with a
 * misleading "below quota cutoff" 429 instead of falling through to cooldown / model-lockout
 * handling. Without the block the candidate still must not score like a healthy one, so it carries
 * a soft penalty (#4540).
 */
function statusSignals(
  connection: Record<string, unknown> | undefined,
  quotaCutoffEnabled: boolean
): QuotaSignals {
  const base: QuotaSignals = {
    resetWindowAffinity: 0.5,
    quotaRemaining: 100,
    quotaCutoffBlocked: false,
    quotaCutoffReason: undefined,
    statusPenalty: false,
    statusPenaltyReason: undefined,
  };
  const statusReason = getConnectionStatusQuotaCutoffReason(connection);
  if (quotaCutoffEnabled && statusReason) {
    return {
      ...base,
      quotaRemaining: 0,
      quotaCutoffBlocked: true,
      quotaCutoffReason: statusReason,
    };
  }
  if (statusReason) return { ...base, statusPenalty: true, statusPenaltyReason: statusReason };
  return base;
}

interface QuotaLookupInput {
  provider: string;
  target: ResolvedComboTarget;
  connection: Record<string, unknown> | undefined;
  comboName: string;
  resetWindowConfig: ResetWindowConfig;
  resilienceSettings: ResilienceSettings | null;
  quotaCutoffEnabled: boolean;
  /** Shared across the pool so one account is asked for its quota once per fetch scope. */
  quotaPromises: Map<string, Promise<unknown>>;
}

/**
 * The candidate's quota picture. Without a quota fetcher or a connection there is no quota signal
 * to read and the status-only answer stands.
 */
async function resolveQuotaSignals(input: QuotaLookupInput): Promise<QuotaSignals> {
  const signals = statusSignals(input.connection, input.quotaCutoffEnabled);
  // #10877: `provider` may be a legacy/user-facing alias spelling; canonicalize before the
  // fetcher registry lookup so aliased combo members still hit quota-aware scoring.
  const fetcher = getQuotaFetcher(resolveProviderId(input.provider));
  const connectionId = input.target.connectionId;
  if (!fetcher || !connectionId) return signals;

  const quotaScope = getQuotaFetchScope(input.provider, input.target.modelStr);
  const quotaKey = `${input.provider}:${connectionId}:${quotaScope}`;
  if (!input.quotaPromises.has(quotaKey)) {
    input.quotaPromises.set(
      quotaKey,
      fetchResetAwareQuotaWithCache({
        provider: input.provider,
        connectionId,
        connection: input.connection
          ? { ...input.connection, requestedModel: input.target.modelStr }
          : input.connection,
        fetcher,
        config: input.resetWindowConfig,
        log: {},
        comboName: input.comboName,
      })
    );
  }
  const quota = await input.quotaPromises.get(quotaKey)!;
  signals.resetWindowAffinity = calculateResetWindowAffinity(quota, input.resetWindowConfig);
  if (signals.quotaCutoffBlocked) return signals;

  const quotaContext = { provider: input.provider, requestedModel: input.target.modelStr };
  signals.quotaRemaining = quotaRemainingPercentFromQuota(quota, quotaContext);
  if (!input.quotaCutoffEnabled) return signals;
  const decision = evaluateQuotaCutoff(
    quota as QuotaInfo | null,
    buildAutoQuotaThresholds(input.provider, input.connection, input.resilienceSettings),
    quotaContext
  );
  if (!decision.proceed) {
    signals.quotaCutoffBlocked = true;
    signals.quotaCutoffReason = decision.reason || "quota_exhausted";
  }
  return signals;
}

function circuitStateOf(provider: string): ProviderCandidate["circuitBreakerState"] {
  const state = getCircuitBreaker(provider)?.getStatus?.()?.state;
  return state === "OPEN" || state === "HALF_OPEN" ? state : "CLOSED";
}

interface CandidateContext {
  comboName: string;
  sessionId: string | null | undefined;
  resetWindowConfig: ResetWindowConfig;
  resilienceSettings: ResilienceSettings | null;
  quotaCutoffEnabled: boolean;
  connections: ProviderConnections;
  historicalLatencyStats: Record<string, HistoricalLatencyStatsEntry>;
  liveMetrics: {
    byModel?: Record<string, { avgLatencyMs?: unknown; successRate?: unknown }>;
  } | null;
  getPricingForModel: PricingLookup;
  quotaPromises: Map<string, Promise<unknown>>;
}

/**
 * `authType` is not part of `AutoProviderCandidate` but has always been carried on the built rows
 * (the quota-share and session-availability paths read it), so the builder's own return type says
 * so rather than dropping the field or widening the shared contract.
 */
type BuiltAutoCandidate = AutoProviderCandidate & { authType: string | null };

async function buildCandidate(
  target: ResolvedComboTarget,
  context: CandidateContext
): Promise<BuiltAutoCandidate> {
  const modelStr = target.modelStr;
  const parsed = parseModel(modelStr);
  const provider = targetProviderId(target);
  const model = parsed.model || modelStr;
  const connection = target.connectionId
    ? context.connections.byId.get(target.connectionId)
    : undefined;
  const authType = typeof connection?.authType === "string" ? connection.authType : null;

  const costPer1MTokens = await resolveCandidateCost(context.getPricingForModel, provider, model);
  const latency = resolveLatencyProfile(
    model,
    context.historicalLatencyStats[`${provider}/${model}`] || null,
    context.liveMetrics?.byModel?.[modelStr] || null
  );
  const quota = await resolveQuotaSignals({
    provider,
    target,
    connection,
    comboName: context.comboName,
    resetWindowConfig: context.resetWindowConfig,
    resilienceSettings: context.resilienceSettings,
    quotaCutoffEnabled: context.quotaCutoffEnabled,
    quotaPromises: context.quotaPromises,
  });

  return {
    stepId: target.stepId,
    executionKey: target.executionKey,
    modelStr,
    provider,
    model,
    quotaRemaining: quota.quotaRemaining,
    quotaTotal: 100,
    circuitBreakerState: circuitStateOf(provider),
    costPer1MTokens,
    p95LatencyMs: latency.p95LatencyMs,
    latencyStdDev: latency.latencyStdDev,
    errorRate: latency.errorRate,
    ...latency.speedTelemetry,
    accountTier: "standard" as const,
    quotaResetIntervalSecs: 86400,
    contextAffinity: calculateTargetContextAffinity(target, context.sessionId),
    sessionAvailability:
      authType === "oauth"
        ? getOAuthSessionAvailability(target.connectionId, context.sessionId)
        : 1,
    resetWindowAffinity: quota.resetWindowAffinity,
    quotaCutoffBlocked: quota.quotaCutoffBlocked,
    quotaCutoffReason: quota.quotaCutoffReason,
    statusPenalty: quota.statusPenalty,
    statusPenaltyReason: quota.statusPenaltyReason,
    connectionPoolSize: context.connections.poolCounts.get(provider) ?? 1,
    connectionId: target.connectionId ?? undefined,
    authType,
    // Feedback-driven quality signal (routing quality tracker). Neutral 1.0 before enough samples
    // accumulate — a cold model is never penalized.
    quality: qualityScoreFor(provider, model),
  };
}

export async function buildAutoCandidates(
  targets: ResolvedComboTarget[],
  comboName: string,
  sessionId: string | null | undefined = null,
  resetWindowConfig: ResetWindowConfig = resolveResetWindowConfig(null),
  resilienceSettings: ResilienceSettings | null = null
): Promise<AutoProviderCandidate[]> {
  const hiddenModelsMap = getHiddenModelsByProvider();
  const { getPricingForModel } = await import("@/lib/db/settings");
  const historicalLatencyStats = await loadHistoricalLatencyStats();
  const connections = await loadProviderConnections(targets);
  const context: CandidateContext = {
    comboName,
    sessionId,
    resetWindowConfig,
    resilienceSettings,
    // Opt-in hard quota cutoff (default OFF). When disabled, candidates are never dropped for low
    // quota here — the soft quota penalty + connection cooldown still apply, so auto-routing
    // behavior is unchanged.
    quotaCutoffEnabled:
      (resilienceSettings ?? resolveResilienceSettings(null))?.quotaPreflight?.enabled === true,
    connections,
    historicalLatencyStats,
    liveMetrics: getComboMetrics(comboName),
    getPricingForModel,
    quotaPromises: new Map(),
  };

  const candidates = await Promise.all(
    expandCandidateTargets(targets, connections).map((target) => buildCandidate(target, context))
  );

  // Filter out candidates whose model is hidden by the user in the dashboard, then drop
  // vendor-retired ids so auto-combo cannot pick them (#11625).
  return rejectRetiredAutoComboCandidates(
    candidates.filter((candidate) => !hiddenModelsMap.get(candidate.provider)?.has(candidate.model))
  );
}
