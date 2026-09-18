/**
 * Recent routing decisions, looked up by decision id or request id, so a live request can be
 * explained after it ran. Bounded in memory by TTL, entry count and an estimated byte budget.
 *
 * A decision is stored in a compact form: the selected candidate and the best
 * `MAX_CANDIDATES_WITH_FACTORS` keep their full factor breakdown, at most
 * `MAX_STORED_CANDIDATES` candidates are kept at all, and `omittedCandidates` says how many were
 * dropped. Auto combos over the whole catalog consider hundreds of candidates per request, and
 * keeping every factor of every candidate for 2000 requests costs over a gigabyte of heap.
 *
 * SAFETY CONTRACT: a stored decision is the `RoutingDecision` contract only — provider/model ids,
 * scores, exclusion reasons, policy version. Never prompts, bodies, headers or credentials.
 */
import type { RoutingCandidate, RoutingDecision } from "@/shared/contracts/routing";

const DECISION_TTL_MS = 30 * 60 * 1000;
const MAX_DECISIONS = 2000;
/** Candidates kept per stored decision (the selected one is always kept). */
export const MAX_STORED_CANDIDATES = 40;
/** Candidates, in decision order, that keep their factor breakdown besides the selected one. */
export const MAX_CANDIDATES_WITH_FACTORS = 10;
/** Estimated size budget of the whole store. */
export const MAX_STORE_BYTES = 32 * 1024 * 1024;

/** Rough per-object overheads used by the size estimate (V8 objects, not JSON). */
const DECISION_BASE_BYTES = 512;
const CANDIDATE_BASE_BYTES = 320;
const FACTOR_BYTES = 120;

interface StoredDecision {
  decision: RoutingDecision;
  storedAt: number;
  bytes: number;
}

const decisions = new Map<string, StoredDecision>();
const decisionIdByRequestId = new Map<string, string>();
let storedBytes = 0;

function isSameCandidate(a: RoutingCandidate, b: RoutingCandidate | undefined): boolean {
  return b !== undefined && a.providerId === b.providerId && a.modelId === b.modelId;
}

function compactCandidates(decision: RoutingDecision): RoutingCandidate[] {
  const { selected, candidates } = decision;
  const kept = candidates.slice(0, MAX_STORED_CANDIDATES);
  if (selected && !kept.some((candidate) => isSameCandidate(candidate, selected))) {
    kept[kept.length - 1] = selected;
  }
  return kept.map((candidate, index) =>
    index < MAX_CANDIDATES_WITH_FACTORS || isSameCandidate(candidate, selected)
      ? candidate
      : { ...candidate, factors: [] }
  );
}

/**
 * The form a decision is retained in: bounded candidates, factors only where they explain the
 * choice, and the number of candidates left out. Decisions already within bounds keep their shape.
 */
function compactRoutingDecision(decision: RoutingDecision): RoutingDecision {
  const candidates = compactCandidates(decision);
  const omitted =
    (decision.omittedCandidates ?? 0) + decision.candidates.length - candidates.length;
  const unchanged =
    omitted === (decision.omittedCandidates ?? 0) &&
    candidates.every((candidate, index) => candidate === decision.candidates[index]);
  if (unchanged) return decision;
  return { ...decision, candidates, ...(omitted > 0 ? { omittedCandidates: omitted } : {}) };
}

function candidateBytes(candidate: RoutingCandidate): number {
  return (
    CANDIDATE_BASE_BYTES +
    2 * (candidate.providerId.length + candidate.modelId.length) +
    candidate.factors.length * FACTOR_BYTES +
    candidate.exclusionReasons.length * 32
  );
}

/** Estimated retained size of a stored decision, in bytes. */
function estimateDecisionBytes(decision: RoutingDecision): number {
  let bytes = DECISION_BASE_BYTES + 2 * (decision.decisionId.length + decision.requestId.length);
  for (const candidate of decision.candidates) bytes += candidateBytes(candidate);
  return bytes;
}

function forget(decisionId: string): void {
  const stored = decisions.get(decisionId);
  if (!stored) return;
  decisions.delete(decisionId);
  storedBytes -= stored.bytes;
  if (decisionIdByRequestId.get(stored.decision.requestId) === decisionId) {
    decisionIdByRequestId.delete(stored.decision.requestId);
  }
}

function pruneExpired(now: number): void {
  for (const [decisionId, stored] of decisions) {
    if (now - stored.storedAt <= DECISION_TTL_MS) break;
    forget(decisionId);
  }
}

function evictOldestUntil(fits: () => boolean): void {
  while (decisions.size > 0 && !fits()) {
    const oldest = decisions.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
}

export function recordRoutingDecision(decision: RoutingDecision, now: number = Date.now()): void {
  pruneExpired(now);
  const compact = compactRoutingDecision(decision);
  const bytes = estimateDecisionBytes(compact);
  forget(compact.decisionId);
  evictOldestUntil(() => decisions.size < MAX_DECISIONS && storedBytes + bytes <= MAX_STORE_BYTES);
  decisions.set(compact.decisionId, { decision: compact, storedAt: now, bytes });
  storedBytes += bytes;
  if (compact.requestId) decisionIdByRequestId.set(compact.requestId, compact.decisionId);
}

/** The latest decision with this decision id, or for this request id. */
export function getRoutingDecision(id: string, now: number = Date.now()): RoutingDecision | null {
  const decisionId = decisions.has(id) ? id : decisionIdByRequestId.get(id);
  const stored = decisionId ? decisions.get(decisionId) : undefined;
  if (!stored || !decisionId) return null;
  if (now - stored.storedAt > DECISION_TTL_MS) {
    forget(decisionId);
    return null;
  }
  return stored.decision;
}

/** Entry count and estimated retained bytes of the store. */
export function getRoutingDecisionStoreStats(): { entries: number; bytes: number } {
  return { entries: decisions.size, bytes: storedBytes };
}

/** Test hook: clear the store. */
export function resetRoutingDecisionStore(): void {
  decisions.clear();
  decisionIdByRequestId.clear();
  storedBytes = 0;
}
