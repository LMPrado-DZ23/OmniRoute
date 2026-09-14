/**
 * Recent routing decisions, looked up by decision id or request id, so a live request can be
 * explained after it ran. Bounded in memory (TTL + size cap) like the combo decision trace.
 *
 * SAFETY CONTRACT: a stored decision is the `RoutingDecision` contract only — provider/model ids,
 * scores, exclusion reasons, policy version. Never prompts, bodies, headers or credentials.
 */
import type { RoutingDecision } from "@/shared/contracts/routing";

const DECISION_TTL_MS = 30 * 60 * 1000;
const MAX_DECISIONS = 2000;

interface StoredDecision {
  decision: RoutingDecision;
  storedAt: number;
}

const decisions = new Map<string, StoredDecision>();
const decisionIdByRequestId = new Map<string, string>();

function forget(decisionId: string): void {
  const stored = decisions.get(decisionId);
  if (!stored) return;
  decisions.delete(decisionId);
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

export function recordRoutingDecision(decision: RoutingDecision, now: number = Date.now()): void {
  pruneExpired(now);
  while (decisions.size >= MAX_DECISIONS) {
    const oldest = decisions.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
  decisions.set(decision.decisionId, { decision, storedAt: now });
  if (decision.requestId) decisionIdByRequestId.set(decision.requestId, decision.decisionId);
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

/** Test hook: clear the store. */
export function resetRoutingDecisionStore(): void {
  decisions.clear();
  decisionIdByRequestId.clear();
}
