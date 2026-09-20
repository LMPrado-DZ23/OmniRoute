"use client";

import { useTranslations } from "next-intl";
import { ActionableErrorCallout } from "../components/ActionableErrorCallout";
import type { useCredentialCheck } from "./useCredentialCheck";
import type { useModelTrial } from "./useModelTrial";

type CredentialCheck = ReturnType<typeof useCredentialCheck>;
type ModelTrial = ReturnType<typeof useModelTrial>;

const INPUT_CLASS =
  "w-full min-w-0 px-3 py-2 bg-bg-subtle border border-border rounded-lg text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-text-muted">
      <span className="material-symbols-outlined animate-spin text-[20px]" aria-hidden="true">
        progress_activity
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}

function CredentialPanel({
  credential,
  onBackToProvider,
}: {
  credential: CredentialCheck;
  onBackToProvider: () => void;
}) {
  const t = useTranslations("onboarding");
  const { status, message, failure, connections, connection } = credential;
  return (
    <div className="space-y-3">
      {connections.length > 1 && status !== "testing" && (
        <label className="block text-left text-xs text-text-muted">
          {t("connectionLabel")}
          <select
            value={connection?.id ?? ""}
            onChange={(event) => credential.selectConnection(event.target.value)}
            className={`${INPUT_CLASS} mt-1`}
          >
            {connections.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.provider})
              </option>
            ))}
          </select>
        </label>
      )}
      {status === "idle" && (
        <button
          onClick={() => void credential.run()}
          className="px-6 py-2.5 bg-primary rounded-lg text-on-primary font-medium text-sm hover:bg-primary/90 transition-colors cursor-pointer"
        >
          {t("runTest")}
        </button>
      )}
      {status === "testing" && <Spinner label={message} />}
      {status === "success" && (
        <div className="flex items-center justify-center gap-2 text-success-strong">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            check_circle
          </span>
          <span className="text-sm">{message}</span>
        </div>
      )}
      {status === "error" && failure && (
        <ActionableErrorCallout
          message={message}
          guide={failure.guide}
          onRetry={() => void credential.run()}
          secondaryAction={
            failure.guide.kind === "credential" || failure.guide.kind === "noConnection"
              ? { label: t("backToProvider"), onClick: onBackToProvider }
              : undefined
          }
        />
      )}
    </div>
  );
}

function ModelPicker({ trial }: { trial: ModelTrial }) {
  const t = useTranslations("onboarding");
  if (trial.models.length > 0) {
    return (
      <select
        aria-label={t("modelLabel")}
        value={trial.model}
        onChange={(event) => trial.setModel(event.target.value)}
        className={INPUT_CLASS}
      >
        {trial.models.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      aria-label={t("modelLabel")}
      placeholder={t("modelIdManualPlaceholder")}
      value={trial.model}
      onChange={(event) => trial.setModel(event.target.value)}
      className={INPUT_CLASS}
    />
  );
}

function TrialResult({ trial }: { trial: ModelTrial }) {
  const t = useTranslations("onboarding");
  if (trial.trialState === "running") return <Spinner label={t("sendingTestRequest")} />;
  if (trial.trialState === "ok") {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-success-strong">
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          check_circle
        </span>
        {t("testRequestOk", { ms: trial.latencyMs ?? 0 })}
      </p>
    );
  }
  if (trial.trialState === "error" && trial.trialFailure) {
    return (
      <ActionableErrorCallout
        message={trial.trialFailure.message}
        guide={trial.trialFailure.guide}
        onRetry={() => void trial.runTrial()}
      />
    );
  }
  return null;
}

function ModelTrialPanel({ trial }: { trial: ModelTrial }) {
  const t = useTranslations("onboarding");
  if (trial.listState === "idle") return null;
  if (trial.listState === "loading") return <Spinner label={t("loadingModels")} />;
  return (
    <section className="space-y-3 border-t border-border pt-4 text-left">
      <div>
        <h3 className="text-sm font-semibold text-text-main">{t("chooseModelTitle")}</h3>
        <p className="mt-1 text-xs text-text-muted">{t("chooseModelDesc")}</p>
      </div>
      {trial.listFailure && trial.connection && (
        <ActionableErrorCallout
          message={trial.listFailure.message}
          guide={trial.listFailure.guide}
          onRetry={() => {
            if (trial.connection) void trial.loadModels(trial.connection);
          }}
        />
      )}
      <ModelPicker trial={trial} />
      <button
        onClick={() => void trial.runTrial()}
        disabled={!trial.model.trim() || trial.trialState === "running"}
        className="px-4 py-2 bg-primary rounded-lg text-on-primary font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {t("sendTestRequest")}
      </button>
      <TrialResult trial={trial} />
    </section>
  );
}

/** Steps 5–7: validate the credential, choose an available model, send a test request. */
export function ValidateAndTryStep({
  credential,
  trial,
  onBackToProvider,
}: {
  credential: CredentialCheck;
  trial: ModelTrial;
  onBackToProvider: () => void;
}) {
  const t = useTranslations("onboarding");
  return (
    <div className="text-center space-y-4">
      <p className="text-sm text-text-muted">{t("testDesc")}</p>
      <CredentialPanel credential={credential} onBackToProvider={onBackToProvider} />
      {credential.status === "success" && <ModelTrialPanel trial={trial} />}
    </div>
  );
}
