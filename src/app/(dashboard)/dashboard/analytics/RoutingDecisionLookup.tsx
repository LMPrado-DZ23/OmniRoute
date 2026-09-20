"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";
import type {
  RoutingCandidate,
  RoutingCircuitState,
  RoutingDecision,
  RoutingExclusionReason,
  RoutingQuotaState,
  RoutingSelectionMode,
} from "@/shared/contracts/routing";

type Translator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

type LookupStatus = "idle" | "loading" | "found" | "notFound" | "unauthorized" | "error";

function label(t: Translator, key: string, fallback: string): string {
  return typeof t.has === "function" && t.has(key) ? t(key) : fallback;
}

/** Translation keys for the routing contract enums; a missing translation shows the raw value. */
const QUOTA_KEYS: Record<RoutingQuotaState, string> = {
  available: "routeDecisionQuotaAvailable",
  low: "routeDecisionQuotaLow",
  exhausted: "routeDecisionQuotaExhausted",
  unknown: "routeDecisionQuotaUnknown",
};

const CIRCUIT_KEYS: Record<RoutingCircuitState, string> = {
  closed: "routeDecisionCircuitClosed",
  open: "routeDecisionCircuitOpen",
  half_open: "routeDecisionCircuitHalfOpen",
};

const SELECTION_MODE_KEYS: Record<RoutingSelectionMode, string> = {
  deterministic: "routeDecisionModeDeterministic",
  rotation: "routeDecisionModeRotation",
  exploration: "routeDecisionModeExploration",
};

const REASON_KEYS: Record<RoutingExclusionReason, string> = {
  not_in_candidate_pool: "routeDecisionReasonNotInCandidatePool",
  model_not_found: "routeDecisionReasonModelNotFound",
  capability_missing: "routeDecisionReasonCapabilityMissing",
  quota_exhausted: "routeDecisionReasonQuotaExhausted",
  circuit_open: "routeDecisionReasonCircuitOpen",
  self_healing_excluded: "routeDecisionReasonSelfHealingExcluded",
  cost_over_budget: "routeDecisionReasonCostOverBudget",
  latency_over_budget: "routeDecisionReasonLatencyOverBudget",
};

function enumLabel<T extends string>(t: Translator, keys: Record<T, string>, value: T): string {
  const key = keys[value];
  return key ? label(t, key, value) : value;
}

function formatCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(6)}`;
}

function formatGeneratedAt(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(
      date
    );
  } catch {
    return iso;
  }
}

function CandidateRow({
  candidate,
  selected,
  t,
}: {
  candidate: RoutingCandidate;
  selected: boolean;
  t: Translator;
}) {
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="px-2 py-2 font-medium text-text-main">
        {candidate.providerId}/{candidate.modelId}
        {selected ? (
          <Badge variant="primary" className="ml-2">
            {label(t, "routeDecisionBadgeSelected", "selected")}
          </Badge>
        ) : null}
      </td>
      <td className="px-2 py-2 tabular-nums">{candidate.score.toFixed(3)}</td>
      <td className="px-2 py-2">
        <Badge variant={candidate.eligible ? "success" : "error"}>
          {candidate.eligible
            ? label(t, "routeDecisionEligible", "eligible")
            : label(t, "routeDecisionExcluded", "excluded")}
        </Badge>
        {candidate.exclusionReasons.length > 0 ? (
          <div className="mt-1 text-xs text-text-muted">
            {candidate.exclusionReasons
              .map((reason) => enumLabel(t, REASON_KEYS, reason))
              .join(", ")}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-2">{enumLabel(t, QUOTA_KEYS, candidate.quota)}</td>
      <td className="px-2 py-2">{enumLabel(t, CIRCUIT_KEYS, candidate.circuit)}</td>
      <td className="px-2 py-2 tabular-nums">{formatCost(candidate.estimatedCostUsd)}</td>
      <td className="px-2 py-2 tabular-nums">
        {candidate.estimatedLatencyMs === null ? "—" : `${candidate.estimatedLatencyMs} ms`}
      </td>
    </tr>
  );
}

function DecisionDetails({
  decision,
  t,
  locale,
}: {
  decision: RoutingDecision;
  t: Translator;
  locale: string;
}) {
  const selectedKey = decision.selected
    ? `${decision.selected.providerId}/${decision.selected.modelId}`
    : null;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="default">{decision.decisionId}</Badge>
        <Badge variant="default">
          {label(t, "routeDecisionPolicyVersion", "Policy")} {decision.policyVersion}
        </Badge>
        {decision.strategy ? <Badge variant="default">{decision.strategy}</Badge> : null}
        {decision.selectionMode ? (
          <Badge variant="default">
            {enumLabel(t, SELECTION_MODE_KEYS, decision.selectionMode)}
          </Badge>
        ) : null}
        <Badge variant={decision.liveRequestExecuted ? "primary" : "default"}>
          {decision.liveRequestExecuted
            ? label(t, "routeDecisionLive", "live")
            : label(t, "routeDecisionPreview", "preview")}
        </Badge>
      </div>
      <p className="text-sm text-text-muted">
        {selectedKey
          ? `${label(t, "routeDecisionSelected", "Selected")}: ${selectedKey}`
          : label(t, "routeDecisionNoneSelected", "No candidate was selected.")}
        {" · "}
        <time dateTime={decision.generatedAt}>
          {formatGeneratedAt(decision.generatedAt, locale)}
        </time>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-2 py-2">{label(t, "routeDecisionCandidate", "Candidate")}</th>
              <th className="px-2 py-2">{label(t, "routeScore", "Route score")}</th>
              <th className="px-2 py-2">{label(t, "routeDecisionEligibility", "Eligibility")}</th>
              <th className="px-2 py-2">{label(t, "routeDecisionQuota", "Quota")}</th>
              <th className="px-2 py-2">{label(t, "routeDecisionCircuit", "Circuit")}</th>
              <th className="px-2 py-2">{label(t, "routeDecisionCost", "Est. cost")}</th>
              <th className="px-2 py-2">{label(t, "routeDecisionLatency", "Est. latency")}</th>
            </tr>
          </thead>
          <tbody>
            {decision.candidates.map((candidate) => (
              <CandidateRow
                key={`${candidate.providerId}/${candidate.modelId}`}
                candidate={candidate}
                selected={`${candidate.providerId}/${candidate.modelId}` === selectedKey}
                t={t}
              />
            ))}
          </tbody>
        </table>
      </div>
      {decision.omittedCandidates ? (
        <p className="text-xs text-text-muted">{omittedLabel(t, decision.omittedCandidates)}</p>
      ) : null}
    </div>
  );
}

function omittedLabel(t: Translator, count: number): string {
  const key = "routeDecisionOmittedCandidates";
  if (typeof t.has === "function" && t.has(key)) return t(key, { count });
  return `${count} lower-ranked candidates are not listed.`;
}

function foundMessage(t: Translator, decision: RoutingDecision | null): string {
  const selected = decision?.selected;
  if (!selected) {
    return label(
      t,
      "routeDecisionLookupFoundNoSelection",
      "Decision found. No candidate was selected."
    );
  }
  const key = `${selected.providerId}/${selected.modelId}`;
  if (typeof t.has === "function" && t.has("routeDecisionLookupFound")) {
    return t("routeDecisionLookupFound", { selected: key });
  }
  return `Decision found: ${key} was chosen.`;
}

/** The text the live region announces for a lookup status. */
function statusMessage(
  t: Translator,
  status: LookupStatus,
  decision: RoutingDecision | null
): string | null {
  switch (status) {
    case "loading":
      return label(t, "routeDecisionLookupLoading", "Looking up…");
    case "found":
      return foundMessage(t, decision);
    case "notFound":
      return label(
        t,
        "routeDecisionLookupNotFound",
        "No decision with that id in the last 30 minutes. Decisions are recorded for auto-combo routing."
      );
    case "unauthorized":
      return label(
        t,
        "routeDecisionLookupUnauthorized",
        "Your session has expired or does not allow this lookup. Sign in again with a management account."
      );
    case "error":
      return label(t, "routeDecisionLookupFailed", "The decision could not be loaded. Try again.");
    default:
      return null;
  }
}

function statusForResponse(response: Response): LookupStatus | null {
  if (response.status === 404) return "notFound";
  if (response.status === 401 || response.status === 403) return "unauthorized";
  return response.ok ? null : "error";
}

/** Fetch state of the lookup; focus moves to the results region once a decision loads. */
function useDecisionLookup() {
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [status, setStatus] = useState<LookupStatus>("idle");
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "found") resultsRef.current?.focus();
  }, [status, decision]);

  async function run(id: string) {
    setStatus("loading");
    try {
      const response = await fetch(`/api/omniroute/route/decisions/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const failure = statusForResponse(response);
      if (failure) {
        setDecision(null);
        setStatus(failure);
        return;
      }
      const body = (await response.json()) as { decision: RoutingDecision };
      setDecision(body.decision);
      setStatus("found");
    } catch {
      setDecision(null);
      setStatus("error");
    }
  }

  return { decision, status, resultsRef, run };
}

/** Look up a recent live routing decision by request id or decision id. */
export default function RoutingDecisionLookup() {
  const t = useTranslations("analytics") as Translator;
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const { decision, status, resultsRef, run } = useDecisionLookup();

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = query.trim();
    if (id) void run(id);
  }

  return (
    <Card
      title={label(t, "routeDecisionLookupTitle", "Routing decision lookup")}
      subtitle={label(
        t,
        "routeDecisionLookupSubtitle",
        "Find a live decision from the last 30 minutes by request id (x-request-id) or decision id"
      )}
      icon="manage_search"
    >
      <form onSubmit={lookup} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="routing-decision-lookup" className="sr-only">
          {label(t, "routeDecisionLookupLabel", "Request id or decision id")}
        </label>
        <input
          id="routing-decision-lookup"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={label(t, "routeDecisionLookupLabel", "Request id or decision id")}
          className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main"
        />
        <button
          type="submit"
          disabled={status === "loading" || query.trim().length === 0}
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            search
          </span>
          {label(t, "routeDecisionLookupAction", "Look up")}
        </button>
      </form>
      <div aria-live="polite" className="mt-2 text-sm text-text-muted">
        {statusMessage(t, status, decision)}
      </div>
      {decision ? (
        <div
          ref={resultsRef}
          tabIndex={-1}
          aria-label={label(t, "routeDecisionResultsLabel", "Routing decision details")}
          className="focus-ring rounded-lg"
        >
          <DecisionDetails decision={decision} t={t} locale={locale} />
        </div>
      ) : null}
    </Card>
  );
}
