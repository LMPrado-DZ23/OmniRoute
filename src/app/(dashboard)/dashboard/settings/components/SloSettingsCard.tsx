"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, Toggle } from "@/shared/components";
import { resolveSloSettings, type SloSettings } from "@/lib/monitoring/sloSettings";
import { describeApiError } from "@/shared/utils/apiErrorPresentation";
import {
  SLO_FIELDS,
  parseSloForm,
  toSloForm,
  type SloFormValues,
  type SloNumericKey,
} from "./sloForm";

type Status = { kind: "idle" | "saved" | "error"; message: string };

const FIELD_LABEL_KEYS: Record<SloNumericKey, string> = {
  availabilityTarget: "sloAvailabilityTarget",
  errorRateMax: "sloErrorRateMax",
  failoverSuccessRateMin: "sloFailoverSuccessRateMin",
  latencyP95Ms: "sloLatencyP95Ms",
  latencyP99Ms: "sloLatencyP99Ms",
  ttftP95Ms: "sloTtftP95Ms",
  providerRecoveryMaxMs: "sloProviderRecoveryMaxMs",
  windowMinutes: "sloWindowMinutes",
  minSamples: "sloMinSamples",
};

async function loadSlo(): Promise<{ alertsEnabled: boolean; form: SloFormValues }> {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  const raw = data && typeof data === "object" && "slo" in data ? data.slo : undefined;
  const settings = resolveSloSettings(raw);
  return { alertsEnabled: settings.alertsEnabled, form: toSloForm(settings) };
}

/** Saves the complete `slo` object; returns a readable error, or null on success. */
async function patchSlo(value: SloSettings, fallback: string): Promise<string | null> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slo: value }),
    });
    if (res.ok) return null;
    const body: unknown = await res.json().catch(() => ({}));
    return describeApiError(body, fallback, res.status);
  } catch (err) {
    return err instanceof Error ? err.message : fallback;
  }
}

/**
 * Settings → Resilience: service level objectives (audit C M1). Edits the `slo` settings key
 * through the existing `PATCH /api/settings`; alerts stay off until the user turns them on.
 */
export default function SloSettingsCard() {
  const t = useTranslations("settings");
  const [form, setForm] = useState<SloFormValues | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [invalid, setInvalid] = useState<SloNumericKey[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });

  useEffect(() => {
    let alive = true;
    loadSlo()
      .then((loaded) => {
        if (!alive) return;
        setAlertsEnabled(loaded.alertsEnabled);
        setForm(loaded.form);
      })
      .catch(() => {
        if (alive) setLoadFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!form) return;
    const parsed = parseSloForm(form, alertsEnabled);
    if (parsed.status === "invalid") {
      setInvalid(parsed.invalid);
      setStatus({ kind: "error", message: t("sloInvalid") });
      return;
    }
    setInvalid([]);
    setSaving(true);
    const error = await patchSlo(parsed.value, t("sloSaveFailed"));
    setSaving(false);
    setStatus(
      error ? { kind: "error", message: error } : { kind: "saved", message: t("sloSaved") }
    );
  };

  if (loadFailed) {
    return (
      <Card className="p-6">
        <p className="text-sm text-text-muted">{t("sloLoadFailed")}</p>
      </Card>
    );
  }
  if (!form) return null;

  return (
    <Card className="p-6">
      <h3 className="text-base sm:text-lg font-semibold">{t("sloTitle")}</h3>
      <p className="mt-1 text-xs sm:text-sm text-text-muted">{t("sloSubtitle")}</p>
      <div className="mt-4">
        <Toggle
          checked={alertsEnabled}
          disabled={saving}
          onChange={setAlertsEnabled}
          label={t("sloAlertsEnabled")}
          description={t("sloAlertsEnabledDesc")}
        />
      </div>
      <SloFields
        form={form}
        invalid={invalid}
        onChange={(key, value) => setForm({ ...form, [key]: value })}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => void save()} loading={saving}>
          {t("sloSave")}
        </Button>
        <p
          role="status"
          className={`text-xs ${status.kind === "error" ? "text-red-700 dark:text-red-400" : "text-text-muted"}`}
        >
          {status.message}
        </p>
      </div>
    </Card>
  );
}

function SloFields({
  form,
  invalid,
  onChange,
}: {
  form: SloFormValues;
  invalid: SloNumericKey[];
  onChange: (key: SloNumericKey, value: string) => void;
}) {
  const t = useTranslations("settings");
  const baseId = useId();
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SLO_FIELDS.map((field) => {
        const id = `${baseId}-${field.key}`;
        const isInvalid = invalid.includes(field.key);
        return (
          <div key={field.key} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-xs text-text-muted">
              {t(FIELD_LABEL_KEYS[field.key])}
            </label>
            <input
              id={id}
              type="number"
              inputMode="decimal"
              min={field.min}
              max={field.max}
              step={field.integer ? 1 : "any"}
              value={form[field.key]}
              aria-invalid={isInvalid}
              aria-describedby={isInvalid ? `${id}-error` : undefined}
              onChange={(event) => onChange(field.key, event.target.value)}
              className="w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm"
            />
            {isInvalid ? (
              <p id={`${id}-error`} className="text-xs text-red-700 dark:text-red-400">
                {t("sloFieldRange", { min: field.min, max: field.max })}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
