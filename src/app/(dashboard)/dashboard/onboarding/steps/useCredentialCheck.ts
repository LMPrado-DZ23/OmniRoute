"use client";

import { useState } from "react";
import { presentConnectionTestFailure } from "@/shared/utils/apiErrorPresentation";
import {
  actionableGuide,
  guideForConnectionTest,
  guideForHttpStatus,
  type ActionableErrorGuide,
} from "@/shared/utils/actionableError";
import { pickConnection, toConnectionOptions, type ConnectionOption } from "./firstUseApi";

/** U8: upper bound for the onboarding connection test (list + probe). */
const PROVIDER_TEST_TIMEOUT_MS = 15_000;

export type Translate = (key: string, values?: Record<string, string | number>) => string;
export type TranslateWithHas = Translate & { has?: (key: string) => boolean };

export interface StepFailure {
  message: string;
  guide: ActionableErrorGuide;
}

type CheckStatus = "idle" | "testing" | "success" | "error";

interface ConnectionTestBody {
  valid?: boolean;
  error?: string | null;
  warning?: string | null;
  diagnosis?: {
    type?: string | null;
    code?: string | null;
    message?: string | null;
    params?: { host?: string | null; timeoutMs?: number | null } | null;
  } | null;
}

type ProbeOutcome =
  | { kind: "listFailed"; status: number }
  | { kind: "noConnection" }
  | {
      kind: "tested";
      connection: ConnectionOption;
      connections: ConnectionOption[];
      ok: boolean;
      status: number;
      body: ConnectionTestBody | null;
    };

/** List the connections, pick the one to test, run `POST /api/providers/{id}/test`. */
async function probeConnection(
  signal: AbortSignal,
  preferredId: string | null
): Promise<ProbeOutcome> {
  const res = await fetch("/api/providers", { signal });
  if (!res.ok) return { kind: "listFailed", status: res.status };
  const connections = toConnectionOptions(await res.json().catch(() => null));
  const connection = pickConnection(connections, preferredId);
  if (!connection) return { kind: "noConnection" };
  const testRes = await fetch(`/api/providers/${encodeURIComponent(connection.id)}/test`, {
    method: "POST",
    signal,
  });
  const body = (await testRes.json().catch(() => null)) as ConnectionTestBody | null;
  return { kind: "tested", connection, connections, ok: testRes.ok, status: testRes.status, body };
}

function describeTestedFailure(
  outcome: Extract<ProbeOutcome, { kind: "tested" }>,
  t: Translate,
  tc: TranslateWithHas
): StepFailure {
  if (!outcome.ok) {
    const error = outcome.body?.error;
    return {
      message: typeof error === "string" && error.trim() ? error : t("testFailed"),
      guide: guideForHttpStatus(outcome.status),
    };
  }
  // The route answers 200 for a probe that RAN; reachability is `valid` in the body (C-03).
  const presented = presentConnectionTestFailure(outcome.body, {
    translate: (key, values) =>
      typeof tc.has !== "function" || tc.has(key) ? tc(key, values) : null,
    fallback: t("testFailed"),
  });
  return { message: presented.message, guide: guideForConnectionTest(outcome.body) };
}

function describeOutcome(
  outcome: ProbeOutcome,
  t: Translate,
  tc: TranslateWithHas
): StepFailure | null {
  if (outcome.kind === "listFailed") {
    return { message: t("couldNotTest"), guide: guideForHttpStatus(outcome.status) };
  }
  if (outcome.kind === "noConnection") {
    return { message: t("noProviderFound"), guide: actionableGuide("noConnection") };
  }
  if (outcome.ok && outcome.body?.valid !== false) return null;
  return describeTestedFailure(outcome, t, tc);
}

/**
 * Step 5 of the first-use flow: validate the credential of the connection the user just
 * added (not simply the first connection of the instance), with a 15 s bound and retry.
 */
export function useCredentialCheck(
  preferredConnectionId: string | null,
  t: Translate,
  tc: TranslateWithHas,
  onValidated: (connection: ConnectionOption) => void
) {
  const [status, setStatus] = useState<CheckStatus>("idle");
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<StepFailure | null>(null);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionOption | null>(null);

  const fail = (next: StepFailure) => {
    setStatus("error");
    setMessage(next.message);
    setFailure(next);
  };

  const run = async (overrideId?: string) => {
    setStatus("testing");
    setMessage(t("testingConnection"));
    setFailure(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
    try {
      const outcome = await probeConnection(
        controller.signal,
        overrideId ?? selectedId ?? preferredConnectionId
      );
      if (outcome.kind === "tested") {
        setConnections(outcome.connections);
        setConnection(outcome.connection);
      }
      const described = describeOutcome(outcome, t, tc);
      if (described) return fail(described);
      setStatus("success");
      setMessage(t("connectionSuccessful"));
      if (outcome.kind === "tested") onValidated(outcome.connection);
    } catch (err) {
      const aborted =
        controller.signal.aborted || (err as { name?: string })?.name === "AbortError";
      fail(
        aborted
          ? { message: t("testTimedOut"), guide: actionableGuide("timeout") }
          : { message: t("couldNotTest"), guide: actionableGuide("network") }
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const selectConnection = (id: string) => {
    setSelectedId(id);
    void run(id);
  };

  return { status, message, failure, connections, connection, run, selectConnection };
}
