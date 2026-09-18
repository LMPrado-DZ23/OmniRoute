"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";
import type { RoutingCandidate, RoutingDecision } from "@/shared/contracts/routing";

type Translator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

type LookupStatus = "idle" | "loading" | "notFound" | "error";

function label(t: Translator, key: string, fallback: string): string {
  return typeof t.has === "function" && t.has(key) ? t(key) : fallback;
}

function formatCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(6)}`;
}

function CandidateRow({ candidate, selected }: { candidate: RoutingCandidate; selected: boolean }) {
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="px-2 py-2 font-medium text-text-main">
        {candidate.providerId}/{candidate.modelId}
        {selected ? (
          <Badge variant="primary" className="ml-2">
            selected
          </Badge>
        ) : null}
      </td>
      <td className="px-2 py-2 tabular-nums">{candidate.score.toFixed(3)}</td>
      <td className="px-2 py-2">
        <Badge variant={candidate.eligible ? "success" : "error"}>
          {candidate.eligible ? "eligible" : "excluded"}
        </Badge>
        {candidate.exclusionReasons.length > 0 ? (
          <div className="mt-1 text-xs text-text-muted">
            {candidate.exclusionReasons.join(", ")}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-2">{candidate.quota}</td>
      <td className="px-2 py-2">{candidate.circuit}</td>
      <td className="px-2 py-2 tabular-nums">{formatCost(candidate.estimatedCostUsd)}</td>
      <td className="px-2 py-2 tabular-nums">
        {candidate.estimatedLatencyMs === null ? "—" : `${candidate.estimatedLatencyMs} ms`}
      </td>
    </tr>
  );
}

function DecisionDetails({ decision, t }: { decision: RoutingDecision; t: Translator }) {
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
        {decision.selectionMode ? <Badge variant="default">{decision.selectionMode}</Badge> : null}
        <Badge variant={decision.liveRequestExecuted ? "primary" : "default"}>
          {decision.liveRequestExecuted ? "live" : "preview"}
        </Badge>
      </div>
      <p className="text-sm text-text-muted">
        {selectedKey
          ? `${label(t, "routeDecisionSelected", "Selected")}: ${selectedKey}`
          : label(t, "routeDecisionNoneSelected", "No candidate was selected.")}
        {" · "}
        {decision.generatedAt}
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
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Look up a recent live routing decision by request id or decision id. */
export default function RoutingDecisionLookup() {
  const t = useTranslations("analytics") as Translator;
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [status, setStatus] = useState<LookupStatus>("idle");

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = query.trim();
    if (!id) return;
    setStatus("loading");
    try {
      const response = await fetch(`/api/omniroute/route/decisions/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (response.status === 404) {
        setDecision(null);
        setStatus("notFound");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { decision: RoutingDecision };
      setDecision(body.decision);
      setStatus("idle");
    } catch {
      setDecision(null);
      setStatus("error");
    }
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
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            search
          </span>
          {label(t, "routeDecisionLookupAction", "Look up")}
        </button>
      </form>
      <div aria-live="polite" className="mt-2 text-sm text-text-muted">
        {status === "loading" ? label(t, "routeDecisionLookupLoading", "Looking up…") : null}
        {status === "notFound"
          ? label(
              t,
              "routeDecisionLookupNotFound",
              "No decision with that id in the last 30 minutes. Decisions are recorded for auto-combo routing."
            )
          : null}
        {status === "error"
          ? label(t, "routeDecisionLookupFailed", "The decision could not be loaded. Try again.")
          : null}
      </div>
      {decision ? <DecisionDetails decision={decision} t={t} /> : null}
    </Card>
  );
}
