"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FIRST_USE_DOCS } from "@/shared/utils/actionableError";
import { loadRecentRequest, type RecentRequest } from "./firstUseApi";

/** Placeholder the operator replaces with a key created in API Manager (never a real key). */
const API_KEY_PLACEHOLDER = "sk-your-omniroute-key";
const MODEL_PLACEHOLDER = "<model-id>";

type CopyState = "idle" | "copied" | "failed";
type RequestState =
  { status: "loading" } | { status: "failed" } | { status: "ready"; request: RecentRequest | null };

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-2">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm text-primary">{value}</dd>
    </div>
  );
}

/** Step 8: the settings any OpenAI-compatible client needs, with a copy button. */
function ClientConfig({ apiEndpoint, modelId }: { apiEndpoint: string; modelId: string | null }) {
  const t = useTranslations("onboarding");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const model = modelId || MODEL_PLACEHOLDER;
  const text = `Base URL: ${apiEndpoint}\nAPI key:  ${API_KEY_PLACEHOLDER}\nModel:    ${model}\n`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-left">
      <div>
        <h3 className="text-sm font-semibold text-text-main">{t("clientConfigTitle")}</h3>
        <p className="mt-1 text-xs text-text-muted">{t("clientConfigDesc")}</p>
      </div>
      <dl className="space-y-2">
        <ConfigRow label={t("yourEndpoint")} value={apiEndpoint} />
        <ConfigRow label={t("apiKeyLabel")} value={API_KEY_PLACEHOLDER} />
        <ConfigRow label={t("modelLabel")} value={model} />
      </dl>
      <p className="text-xs text-text-muted">{t("apiKeyHint")}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white hover:bg-primary/90 cursor-pointer"
        >
          {copyState === "copied" ? t("copied") : t("copyConfig")}
        </button>
        <Link href="/dashboard/api-manager" className="text-xs text-primary hover:underline">
          {t("openApiManager")}
        </Link>
        <Link href="/dashboard/endpoint" className="text-xs text-primary hover:underline">
          {t("openEndpoints")}
        </Link>
      </div>
      {copyState === "failed" && (
        <p role="status" className="text-xs text-amber-400">
          {t("copyFailed")}
        </p>
      )}
    </section>
  );
}

function toRequestState(result: Awaited<ReturnType<typeof loadRecentRequest>>): RequestState {
  return result.kind === "ok" ? { status: "ready", request: result.request } : { status: "failed" };
}

function RequestSummary({ state }: { state: RequestState }) {
  const t = useTranslations("onboarding");
  if (state.status === "loading") return <span>{t("firstRequestLoading")}</span>;
  if (state.status === "failed") return <span>{t("firstRequestFailedLoad")}</span>;
  if (!state.request) return <span>{t("firstRequestNone")}</span>;
  return (
    <span data-testid="first-request">
      {t("firstRequestFound", {
        model: state.request.model,
        status: state.request.status ?? "—",
      })}
    </span>
  );
}

/** Step 9: the newest request recorded in the call logs, with a link to the full logs. */
function FirstRequest() {
  const t = useTranslations("onboarding");
  const [state, setState] = useState<RequestState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setState(toRequestState(await loadRecentRequest()));
  }, []);

  useEffect(() => {
    let active = true;
    void loadRecentRequest().then((result) => {
      if (active) setState(toRequestState(result));
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-left">
      <h3 className="text-sm font-semibold text-text-main">{t("firstRequestTitle")}</h3>
      <p className="text-xs text-text-muted" aria-live="polite">
        <RequestSummary state={state} />
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            void refresh();
          }}
          className="text-xs font-medium text-text-main underline cursor-pointer"
        >
          {t("refreshRequests")}
        </button>
        <Link href="/dashboard/logs" className="text-xs text-primary hover:underline">
          {t("openLogs")}
        </Link>
      </div>
    </section>
  );
}

/** Done step: copy the client configuration, see the first request, read the guide. */
export function FirstUseDone({
  apiEndpoint,
  modelId,
}: {
  apiEndpoint: string;
  modelId: string | null;
}) {
  const t = useTranslations("onboarding");
  return (
    <div className="space-y-4 text-center">
      <p className="text-text-muted">{t("doneDesc")}</p>
      <ClientConfig apiEndpoint={apiEndpoint} modelId={modelId} />
      <FirstRequest />
      <a
        href={FIRST_USE_DOCS.firstSteps}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-primary hover:underline"
      >
        {t("firstStepsGuide")}
      </a>
    </div>
  );
}
