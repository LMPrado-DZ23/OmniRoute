"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDisplayBaseUrl } from "@/shared/hooks";
import { FreeProviderOnboardingCard } from "./steps/FreeProviderOnboardingCard";
import { TierTour } from "./steps/TierTour";
import { ValidateAndTryStep } from "./steps/ValidateAndTryStep";
import { FirstUseDone } from "./steps/FirstUseDone";
import { useCredentialCheck, type StepFailure } from "./steps/useCredentialCheck";
import { useModelTrial } from "./steps/useModelTrial";
import { ActionableErrorCallout } from "./components/ActionableErrorCallout";
import { WizardProgress } from "./components/WizardProgress";
import { presentApiError } from "@/shared/utils/apiErrorPresentation";
import { actionableGuide, guideForHttpStatus } from "@/shared/utils/actionableError";

const STEP_IDS = ["welcome", "tiers", "security", "provider", "test", "done"];
const STEP_ICONS = ["waving_hand", "layers", "lock", "dns", "play_circle", "check_circle"];

const COMMON_PROVIDERS = [
  { id: "openai", name: "OpenAI", color: "#10A37F" },
  { id: "anthropic", name: "Anthropic", color: "#D97757" },
  { id: "google", name: "Google AI", color: "#4285F4" },
  { id: "openrouter", name: "OpenRouter", color: "#6B21A8" },
  { id: "groq", name: "Groq", color: "#F55036" },
  { id: "mistral", name: "Mistral", color: "#FF7000" },
];

const DEFAULT_PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api",
  groq: "https://api.groq.com/openai",
  mistral: "https://api.mistral.ai",
};

const INPUT_CLASS =
  "w-full px-4 py-2.5 bg-white/[0.04] border border-white/10 rounded-lg text-text-main text-sm placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/40";
const PRIMARY_BUTTON_CLASS =
  "px-6 py-2.5 bg-primary rounded-lg text-white font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

/** `/dashboard/onboarding?rerun=1` opens the wizard even after setup was completed. */
function isRerunRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("rerun") === "1";
  } catch {
    return false;
  }
}

async function readJsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  const body = await res.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

export default function OnboardingWizard() {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const tc = useTranslations("common");
  const baseUrl = useDisplayBaseUrl();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const apiEndpoint = `${baseUrl}/api/v1`;

  // Security step state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [skipSecurity, setSkipSecurity] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  // A password configured before the wizard (INITIAL_PASSWORD or an earlier run).
  const [existingPassword, setExistingPassword] = useState(false);

  // Provider step state
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerUrl, setProviderUrl] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerName, setProviderName] = useState("");
  // The connection created in this run — the one the test step validates.
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(null);

  const trial = useModelTrial(t);
  const credential = useCredentialCheck(createdConnectionId, t, tc, (connection) => {
    void trial.loadModels(connection);
  });

  // Check if setup is already complete
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const settings = await res.json();
          if (settings.setupComplete && !isRerunRequested()) {
            router.replace("/dashboard");
            return;
          }
        }
      } catch {
        // Continue with setup
      }
      try {
        const res = await fetch("/api/settings/require-login");
        if (res.ok) setExistingPassword((await readJsonOrNull(res))?.hasPassword === true);
      } catch {
        // Unknown — the security step then behaves as on a fresh install.
      }
      setLoading(false);
    };
    checkSetup();
  }, [router]);

  const STEPS = STEP_IDS.map((id, i) => ({
    id,
    title: t(id === "done" ? "ready" : id),
    icon: STEP_ICONS[i],
  }));

  const currentStep = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  // U1: API failures land here and are rendered (role="alert") inside the step that
  // produced them; changing step clears it so a stale message never follows the user.
  const [stepFailure, setStepFailure] = useState<StepFailure | null>(null);
  // U4: the body may be `{ error: "text" }` or `{ error: { code, message } }` — always a string here.
  const describeFailure = async (res: Response, fallback: string): Promise<StepFailure> => {
    const body = await res.json().catch(() => null);
    const message = presentApiError(body, {
      translate: (key) => (typeof tc.has !== "function" || tc.has(key) ? tc(key) : null),
      fallback,
      status: res.status,
    }).message;
    return { message, guide: guideForHttpStatus(res.status) };
  };
  const networkFailure = (): StepFailure => ({
    message: t("connectionError"),
    guide: actionableGuide("network"),
  });

  const goTo = (next: number) => {
    setStepFailure(null);
    setStep(Math.min(Math.max(next, 0), STEPS.length - 1));
  };
  const handleNext = () => goTo(step + 1);
  const handleBack = () => goTo(step - 1);

  const stepError = stepFailure ? (
    <ActionableErrorCallout message={stepFailure.message} guide={stepFailure.guide} />
  ) : null;

  const handleSetPassword = async () => {
    if (skipSecurity) {
      // (#574) Explicitly disable requireLogin when skipping password setup
      try {
        await fetch("/api/settings/require-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requireLogin: false }),
        });
      } catch {}
      handleNext();
      return;
    }
    if (existingPassword && !password) {
      handleNext();
      return;
    }
    if (password !== confirmPassword) return;
    setStepFailure(null);
    try {
      const res = await fetch("/api/settings/require-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin: true, password }),
      });
      if (!res.ok) {
        setStepFailure(await describeFailure(res, t("failedSetPassword")));
        return;
      }
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!loginRes.ok) {
        setStepFailure(await describeFailure(loginRes, t("connectionError")));
        return;
      }
      setExistingPassword(true);
      handleNext();
    } catch {
      setStepFailure(networkFailure());
    }
  };

  const handleAddProvider = async () => {
    if (!selectedProvider || !providerKey) return;
    setStepFailure(null);
    try {
      const provider = COMMON_PROVIDERS.find((p) => p.id === selectedProvider);
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          name: providerName || provider?.name || selectedProvider,
          url: providerUrl || DEFAULT_PROVIDER_URLS[selectedProvider] || "",
          apiKey: providerKey,
          isActive: true,
        }),
      });
      if (!res.ok) {
        setStepFailure(await describeFailure(res, t("failedAddProvider")));
        return;
      }
      const created = (await readJsonOrNull(res))?.connection as { id?: unknown } | undefined;
      if (typeof created?.id === "string") setCreatedConnectionId(created.id);
      handleNext();
    } catch {
      setStepFailure(networkFailure());
    }
  };

  const handleFinish = async () => {
    try {
      // (#574) If no password was set during wizard, disable requireLogin
      // to prevent the user from being locked out on the login page
      const settings = await fetch("/api/settings/require-login")
        .then((r) => r.json())
        .catch(() => ({}));
      if (!settings.hasPassword) {
        await fetch("/api/settings/require-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requireLogin: false }),
        }).catch(() => {});
      }

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupComplete: true }),
      });
    } catch {
      // Non-critical
    }
    router.push("/dashboard");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-text-muted">{tc("loading")}</div>
      </div>
    );
  }

  const passwordsDiffer = password !== confirmPassword;
  const securityBlocked = existingPassword
    ? Boolean(password) && passwordsDiffer
    : !password || passwordsDiffer;
  const securityLabel = skipSecurity
    ? t("skipAndContinue")
    : existingPassword && !password
      ? t("keepPassword")
      : t("setPassword");

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg min-w-0">
        <WizardProgress stepCount={STEPS.length} current={step} />

        {/* Card */}
        <div className="bg-surface rounded-2xl border border-white/[0.06] p-5 sm:p-8 shadow-xl">
          {/* Step Header */}
          <div className="text-center mb-6">
            <span
              className={`material-symbols-outlined text-[48px] mb-3 block ${
                currentStep.id === "done" ? "text-green-400" : "text-primary"
              }`}
              aria-hidden="true"
            >
              {currentStep.icon}
            </span>
            <h2 className="text-2xl font-bold text-text-main">{currentStep.title}</h2>
            {currentStep.id === "tiers" && (
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-muted text-balance">
                {t("tier.subtitle")}
              </p>
            )}
          </div>

          {/* Step Content */}
          <div className="min-h-[200px]">
            {/* Welcome */}
            {currentStep.id === "welcome" && (
              <div className="text-center space-y-4">
                <p className="text-text-muted">{t("welcomeDesc")}</p>
                <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3 items-stretch">
                  {[
                    { icon: "swap_horiz", label: t("multiProvider") },
                    { icon: "monitoring", label: t("usageTracking") },
                    { icon: "shield", label: t("apiKeyMgmt") },
                  ].map((f) => (
                    <div
                      key={f.icon}
                      className="h-full bg-white/[0.03] rounded-xl p-3 text-center border border-white/[0.06]"
                    >
                      <div className="flex h-full flex-col items-center justify-center">
                        <span
                          className="material-symbols-outlined text-primary text-[24px] mb-1 block"
                          aria-hidden="true"
                        >
                          {f.icon}
                        </span>
                        <span className="text-xs text-text-muted">{f.label}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tiers */}
            {currentStep.id === "tiers" && <TierTour />}

            {/* Security */}
            {currentStep.id === "security" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted text-center">{t("securityDesc")}</p>
                {existingPassword ? (
                  <p className="text-xs text-text-muted text-center rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                    {t("passwordAlreadySet")}
                  </p>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-text-muted">
                    <input
                      type="checkbox"
                      checked={skipSecurity}
                      onChange={(e) => setSkipSecurity(e.target.checked)}
                      className="accent-primary"
                    />
                    {t("skipPassword")}
                  </label>
                )}
                {skipSecurity && (
                  <p className="text-xs text-amber-400 text-center animate-in fade-in duration-200">
                    {t("securityDescSkipWarning")}
                  </p>
                )}
                {!skipSecurity && (
                  <div className="space-y-3">
                    <input
                      type="password"
                      placeholder={t("enterPassword")}
                      aria-label={t("enterPassword")}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className={INPUT_CLASS}
                    />
                    <input
                      type="password"
                      placeholder={t("confirmPasswordPlaceholder")}
                      aria-label={t("confirmPasswordPlaceholder")}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className={INPUT_CLASS}
                    />
                    {capsLockOn && (
                      <p className="text-xs text-amber-500 dark:text-amber-400 flex items-center gap-1 animate-in fade-in duration-200">
                        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                          keyboard_capslock
                        </span>
                        {tc("capsLockOn")}
                      </p>
                    )}
                    {password && confirmPassword && passwordsDiffer && (
                      <p className="text-xs text-red-400">{t("passwordsMismatch")}</p>
                    )}
                  </div>
                )}
                {stepError}
              </div>
            )}

            {/* Provider */}
            {currentStep.id === "provider" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted text-center">{t("providerDesc")}</p>
                {skipSecurity && (
                  <div className="text-center p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg animate-in fade-in duration-200">
                    <p className="text-sm text-amber-400">{t("providerRequiresPassword")}</p>
                  </div>
                )}
                {!skipSecurity && (
                  <FreeProviderOnboardingCard
                    onConnectionsCreated={(ids) => {
                      if (ids[0]) setCreatedConnectionId(ids[0]);
                    }}
                  />
                )}
                {!skipSecurity && (
                  <div className="flex items-center gap-3 text-[11px] text-text-muted">
                    <span className="h-px flex-1 bg-white/10" />
                    <span>{t("freeProviders.orUseApiKey")}</span>
                    <span className="h-px flex-1 bg-white/10" />
                  </div>
                )}
                {!skipSecurity && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {COMMON_PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedProvider(p.id);
                          setProviderName(p.name);
                        }}
                        className={`p-3 rounded-xl border text-center text-xs font-medium transition-all cursor-pointer ${
                          selectedProvider === p.id
                            ? "border-primary/60 bg-primary/10 text-primary"
                            : "border-white/10 bg-white/[0.03] text-text-muted hover:border-white/20"
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
                {!skipSecurity && selectedProvider && (
                  <div className="space-y-3 mt-4">
                    <input
                      type="password"
                      placeholder={t("apiKeyRequired")}
                      aria-label={t("apiKeyRequired")}
                      value={providerKey}
                      onChange={(e) => setProviderKey(e.target.value)}
                      className={INPUT_CLASS}
                    />
                    <input
                      type="text"
                      placeholder={t("customUrlOptional")}
                      aria-label={t("customUrlOptional")}
                      value={providerUrl}
                      onChange={(e) => setProviderUrl(e.target.value)}
                      className={INPUT_CLASS}
                    />
                  </div>
                )}
                {stepError}
              </div>
            )}

            {/* Test: validate the credential, choose a model, send a test request */}
            {currentStep.id === "test" && (
              <ValidateAndTryStep
                credential={credential}
                trial={trial}
                onBackToProvider={() => goTo(STEP_IDS.indexOf("provider"))}
              />
            )}

            {/* Done: client configuration + first request */}
            {currentStep.id === "done" && (
              <FirstUseDone apiEndpoint={apiEndpoint} modelId={trial.clientModelId} />
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-8 pt-6 border-t border-white/[0.06]">
            <div>
              {step > 0 && !isLastStep && (
                <button
                  onClick={handleBack}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors cursor-pointer"
                >
                  {tc("back")}
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!isLastStep && step > 0 && (
                <button
                  onClick={handleNext}
                  className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors cursor-pointer"
                >
                  {t("skip")}
                </button>
              )}
              {currentStep.id === "welcome" && (
                <button onClick={handleNext} className={PRIMARY_BUTTON_CLASS}>
                  {t("getStarted")}
                </button>
              )}
              {currentStep.id === "tiers" && (
                <button onClick={handleNext} className={PRIMARY_BUTTON_CLASS}>
                  {t("continue")}
                </button>
              )}
              {currentStep.id === "security" && (
                <button
                  onClick={handleSetPassword}
                  disabled={!skipSecurity && securityBlocked}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {securityLabel}
                </button>
              )}
              {currentStep.id === "provider" && !skipSecurity ? (
                <button
                  onClick={handleAddProvider}
                  disabled={!selectedProvider || !providerKey}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {t("addProvider")}
                </button>
              ) : null}
              {currentStep.id === "test" && (
                <button onClick={handleNext} className={PRIMARY_BUTTON_CLASS}>
                  {credential.status === "success" ? t("continue") : t("skip")}
                </button>
              )}
              {isLastStep && (
                <button
                  onClick={handleFinish}
                  className="px-6 py-2.5 bg-green-500 rounded-lg text-white font-medium text-sm hover:bg-green-500/90 transition-colors cursor-pointer"
                >
                  {t("goToDashboard")}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Skip Wizard */}
        {!isLastStep && (
          <div className="text-center mt-4">
            <button
              onClick={handleFinish}
              className="text-xs text-text-muted/60 hover:text-text-muted transition-colors cursor-pointer"
            >
              {t("skipWizard")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
