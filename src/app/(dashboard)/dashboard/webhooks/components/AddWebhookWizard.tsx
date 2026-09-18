"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/shared/components";
import { Step1ChooseIntegration } from "./steps/Step1ChooseIntegration";
import {
  Step2ConfigureIntegration,
  type SlackConfig,
  type TelegramConfig,
  type DiscordConfig,
  type CustomConfig,
} from "./steps/Step2ConfigureIntegration";
import { Step3EventsAndTest } from "./steps/Step3EventsAndTest";
import { HowItWorksSidebar } from "./HowItWorksSidebar";
import { describeWebhookApiError } from "./shared/webhookApiError";
import type { WebhookItem } from "./WebhookCard";
import type { WebhookKind } from "./shared/IntegrationCard";

interface AddWebhookWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  editingWebhook?: WebhookItem | null;
}

const STEPS = [1, 2, 3] as const;

interface WizardState {
  kind: WebhookKind;
  slack: SlackConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  custom: CustomConfig;
  events: string[];
  enabled: boolean;
  description: string;
}

const INITIAL: WizardState = {
  kind: "slack",
  slack: { webhookUrl: "" },
  telegram: { botToken: "", chatId: "" },
  discord: { webhookUrl: "" },
  custom: { endpointUrl: "", secretKey: "" },
  events: ["*"],
  enabled: true,
  description: "",
};

function stateFromWebhook(webhook: WebhookItem | null | undefined): WizardState {
  if (!webhook) return INITIAL;

  return {
    kind: webhook.kind,
    slack: { webhookUrl: webhook.kind === "slack" ? webhook.url : "" },
    telegram: { botToken: "", chatId: webhook.kind === "telegram" ? webhook.url : "" },
    discord: { webhookUrl: webhook.kind === "discord" ? webhook.url : "" },
    custom: { endpointUrl: webhook.kind === "custom" ? webhook.url : "", secretKey: "" },
    events: webhook.events.length > 0 ? webhook.events : ["*"],
    enabled: webhook.enabled,
    description: webhook.description,
  };
}

function step2Valid(state: WizardState, isEditing: boolean): boolean {
  const { kind } = state;
  if (kind === "slack") return state.slack.webhookUrl.trim().length > 0;
  if (kind === "telegram") {
    return (
      state.telegram.chatId.trim().length > 0 &&
      (isEditing || state.telegram.botToken.trim().length > 0)
    );
  }
  if (kind === "discord") return state.discord.webhookUrl.trim().length > 0;
  if (kind === "custom") return state.custom.endpointUrl.trim().length > 0;
  return false;
}

/**
 * fetch + JSON with readable failures: a non-2xx response throws an Error whose message is
 * the server's headline plus any per-field validation detail (never `[object Object]`).
 */
async function sendWebhookRequest(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body: Record<string, unknown> | undefined,
  fallback: string
): Promise<{ webhook?: { id?: string } }> {
  const res = await fetch(url, {
    method,
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(describeWebhookApiError(data, fallback, res.status));
  return data && typeof data === "object" ? (data as { webhook?: { id?: string } }) : {};
}

export function AddWebhookWizard({
  isOpen,
  onClose,
  onCreated,
  t,
  editingWebhook,
}: AddWebhookWizardProps) {
  const isEditing = Boolean(editingWebhook);
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  // Id of a webhook this wizard session created as a disabled draft; discarded on Cancel.
  const [draftId, setDraftId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      await Promise.resolve();
      setStep(1);
      setState(stateFromWebhook(editingWebhook));
      setError(null);
      setCreatedId(editingWebhook?.id ?? null);
      setDraftId(null);
    })();
  }, [editingWebhook, isOpen]);

  const resetAndClose = () => {
    setStep(1);
    setState(INITIAL);
    setError(null);
    setCreatedId(null);
    setDraftId(null);
    onClose();
  };

  // Cancel / dismiss: a draft created by this session (disabled, never finished) is deleted so
  // abandoning the wizard leaves nothing behind (audit C H1). Best effort: if the delete fails
  // the draft stays disabled, so it never delivers events.
  const handleClose = () => {
    if (saving) return;
    if (draftId) {
      void fetch(`/api/webhooks/${draftId}`, { method: "DELETE" }).catch(() => undefined);
    }
    resetAndClose();
  };

  // Builds the config payload (URL + kind + metadata) — sent when entering step 3.
  const buildConfigPayload = () => {
    const { kind } = state;
    if (kind === "slack") return { kind, url: state.slack.webhookUrl };
    if (kind === "discord") return { kind, url: state.discord.webhookUrl };
    if (kind === "telegram") {
      const payload: Record<string, unknown> = { kind, url: state.telegram.chatId };
      if (state.telegram.botToken.trim()) {
        payload.metadata = { botToken: state.telegram.botToken };
      }
      return payload;
    }
    const payload: Record<string, unknown> = { kind, url: state.custom.endpointUrl };
    if (state.custom.secretKey.trim()) payload.secret = state.custom.secretKey.trim();
    return payload;
  };

  // Called when Next is clicked on step 2: create (or update) the webhook so the test button
  // is available at step 3 before the user clicks Finish. A new webhook is created DISABLED;
  // it is only enabled (if the user keeps "Enabled" on) by Finish.
  const handleNextFromStep2 = async () => {
    setSaving(true);
    setError(null);
    try {
      if (createdId) {
        await sendWebhookRequest(
          `/api/webhooks/${createdId}`,
          "PUT",
          buildConfigPayload(),
          t("saveFailed")
        );
      } else {
        const data = await sendWebhookRequest(
          "/api/webhooks",
          "POST",
          { ...buildConfigPayload(), events: state.events, enabled: false },
          t("saveFailed")
        );
        const id = data.webhook?.id ?? null;
        setCreatedId(id);
        setDraftId(id);
      }
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  // Finish: update events/enabled/description on the already-created webhook.
  const finish = async () => {
    if (!createdId) return;
    setSaving(true);
    setError(null);
    try {
      await sendWebhookRequest(
        `/api/webhooks/${createdId}`,
        "PUT",
        {
          ...buildConfigPayload(),
          events: state.events,
          enabled: state.enabled,
          description: state.description,
        },
        t("saveFailed")
      );
      onCreated();
      resetAndClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const canGoNext = step === 1 ? true : step === 2 ? step2Valid(state, isEditing) : true;

  const stepTitle =
    step === 1
      ? t("wizard.step1Title")
      : step === 2
        ? t("wizard.step2Title")
        : t("wizard.step3Title");

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={`${t(isEditing ? "editWebhook" : "addWebhook")} — ${stepTitle}`}
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="flex gap-1">
            {STEPS.map((s) => (
              <span
                key={s}
                className={`inline-block size-2 rounded-full transition-colors ${
                  s === step ? "bg-primary" : s < step ? "bg-primary/40" : "bg-border"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="rounded-lg px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-sidebar hover:text-text-main disabled:opacity-40"
            >
              {t("wizard.cancel")}
            </button>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-main transition-colors hover:bg-sidebar disabled:opacity-40"
              >
                {t("wizard.back")}
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                onClick={() => (step === 2 ? void handleNextFromStep2() : setStep((s) => s + 1))}
                disabled={!canGoNext || saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                {saving && step === 2 && (
                  <span className="material-symbols-outlined animate-spin text-[16px]">sync</span>
                )}
                {t("wizard.next")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finish()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                {saving && (
                  <span className="material-symbols-outlined animate-spin text-[16px]">sync</span>
                )}
                {t("wizard.finish")}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300"
            >
              {error}
            </div>
          )}
          {step === 1 && (
            <Step1ChooseIntegration
              selected={state.kind}
              onSelect={(kind) => setState((s) => ({ ...s, kind }))}
              t={t}
            />
          )}
          {step === 2 && (
            <Step2ConfigureIntegration
              kind={state.kind}
              slack={state.slack}
              telegram={state.telegram}
              discord={state.discord}
              custom={state.custom}
              onChangeSlack={(v) => setState((s) => ({ ...s, slack: v }))}
              onChangeTelegram={(v) => setState((s) => ({ ...s, telegram: v }))}
              onChangeDiscord={(v) => setState((s) => ({ ...s, discord: v }))}
              onChangeCustom={(v) => setState((s) => ({ ...s, custom: v }))}
              t={t}
              isEditing={isEditing}
            />
          )}
          {step === 3 && (
            <Step3EventsAndTest
              webhookId={createdId ?? undefined}
              events={state.events}
              enabled={state.enabled}
              description={state.description}
              onChangeEvents={(events) => setState((s) => ({ ...s, events }))}
              onChangeEnabled={(enabled) => setState((s) => ({ ...s, enabled }))}
              onChangeDescription={(description) => setState((s) => ({ ...s, description }))}
              t={t}
            />
          )}
        </div>
        <div className="w-64 shrink-0 hidden lg:block">
          <HowItWorksSidebar t={t} showCustomNote={state.kind === "custom"} />
        </div>
      </div>
    </Modal>
  );
}
