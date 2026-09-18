"use client";

import { useState } from "react";
import {
  actionableGuide,
  guideForHttpStatus,
  guideForModelTest,
} from "@/shared/utils/actionableError";
import {
  loadConnectionModels,
  runModelTest,
  toClientModelId,
  type ConnectionOption,
} from "./firstUseApi";
import type { StepFailure, Translate } from "./useCredentialCheck";

type ListState = "idle" | "loading" | "ready" | "error";
type TrialState = "idle" | "running" | "ok" | "error";

/**
 * Steps 6 and 7 of the first-use flow: list the models the provider exposes for the
 * validated credential, let the user pick one (or type an id when the provider lists none)
 * and send one short request through the real chat pipeline (`POST /api/models/test`), so
 * the first request also shows up in the request logs.
 */
export function useModelTrial(t: Translate) {
  const [connection, setConnection] = useState<ConnectionOption | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [listState, setListState] = useState<ListState>("idle");
  const [listFailure, setListFailure] = useState<StepFailure | null>(null);
  const [model, setModel] = useState("");
  const [trialState, setTrialState] = useState<TrialState>("idle");
  const [trialFailure, setTrialFailure] = useState<StepFailure | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const loadModels = async (target: ConnectionOption) => {
    setConnection(target);
    setListState("loading");
    setListFailure(null);
    setTrialState("idle");
    const result = await loadConnectionModels(target.id);
    if (result.kind === "error") {
      setModels([]);
      setListState("error");
      setListFailure({
        message: result.message || t("failedLoadModels"),
        guide:
          result.httpStatus === null
            ? actionableGuide("network")
            : guideForHttpStatus(result.httpStatus),
      });
      return;
    }
    setModels(result.models);
    setModel(result.models[0] ?? "");
    setListState("ready");
    if (result.models.length === 0) {
      setListFailure({ message: t("noModelsListed"), guide: actionableGuide("noModels") });
    }
  };

  const runTrial = async () => {
    const modelId = model.trim();
    if (!connection || !modelId) return;
    setTrialState("running");
    setTrialFailure(null);
    const outcome = await runModelTest(connection, modelId);
    if (!outcome) {
      setTrialState("error");
      setTrialFailure({ message: t("couldNotTest"), guide: actionableGuide("network") });
      return;
    }
    setLatencyMs(outcome.latencyMs);
    if (outcome.ok) {
      setTrialState("ok");
      return;
    }
    setTrialState("error");
    setTrialFailure({
      message: outcome.error || t("testRequestFailed"),
      guide: guideForModelTest(outcome.httpStatus, outcome),
    });
  };

  const clientModelId =
    connection && model.trim() ? toClientModelId(connection.provider, model) : null;

  return {
    connection,
    models,
    listState,
    listFailure,
    model,
    setModel,
    trialState,
    trialFailure,
    latencyMs,
    clientModelId,
    loadModels,
    runTrial,
  };
}
