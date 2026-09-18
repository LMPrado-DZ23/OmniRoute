"use client";

import { useEffect, useId, useState } from "react";
import { urlHintKey, type UrlState } from "./urlHint";
import { HmacRecipeBlock } from "../../shared/HmacRecipeBlock";

export interface CustomConfig {
  endpointUrl: string;
  secretKey: string;
}

interface CustomConfigFormProps {
  value: CustomConfig;
  onChange: (v: CustomConfig) => void;
  t: (key: string) => string;
  isEditing?: boolean;
}

export function CustomConfigForm({ value, onChange, t, isEditing }: CustomConfigFormProps) {
  const fieldId = useId();
  const [urlState, setUrlState] = useState<UrlState>("idle");

  useEffect(() => {
    const url = value.endpointUrl.trim();
    const controller = new AbortController();
    const delay = url ? 600 : 0;
    const timer = setTimeout(async () => {
      if (!url) {
        setUrlState("idle");
        return;
      }
      setUrlState("checking");
      try {
        const res = await fetch("/api/webhooks/validate-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        setUrlState(data.valid ? "ok" : data.reason === "blocked_private" ? "blocked" : "invalid");
      } catch {
        if (!controller.signal.aborted) setUrlState("invalid");
      }
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value.endpointUrl]);

  const hintKey = urlHintKey(urlState, value.endpointUrl.trim().length > 0);
  const urlHint = hintKey ? t(hintKey) : "";

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor={`${fieldId}-endpoint-url`}
          className="text-xs font-medium uppercase tracking-wider text-text-muted"
        >
          {t("custom.endpointUrl")}
        </label>
        <input
          id={`${fieldId}-endpoint-url`}
          value={value.endpointUrl}
          onChange={(e) => onChange({ ...value, endpointUrl: e.target.value })}
          placeholder={t("custom.endpointUrlPlaceholder")}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        {urlHint && (
          <p
            className={`mt-1 text-xs ${
              urlState === "ok"
                ? "text-emerald-700 dark:text-emerald-400"
                : urlState === "checking"
                  ? "text-text-muted"
                  : "text-red-700 dark:text-red-400"
            }`}
          >
            {urlHint}
          </p>
        )}
      </div>
      <div>
        <label
          htmlFor={`${fieldId}-secret-key`}
          className="text-xs font-medium uppercase tracking-wider text-text-muted"
        >
          {t("custom.secretKey")}
        </label>
        <input
          id={`${fieldId}-secret-key`}
          type="password"
          value={value.secretKey}
          onChange={(e) => onChange({ ...value, secretKey: e.target.value })}
          placeholder={isEditing ? t("secretEditPlaceholder") : t("custom.secretKeyPlaceholder")}
          autoComplete="new-password"
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="mt-1 text-xs text-text-muted">{t("custom.secretKeyHint")}</p>
      </div>
      <HmacRecipeBlock
        title={t("howItWorks.hmacRecipeTitle")}
        snippets={[
          { label: "Node.js", code: t("howItWorks.hmacRecipe") },
          { label: "Python", code: t("howItWorks.hmacRecipePython") },
          { label: "Bash", code: t("howItWorks.hmacRecipeBash") },
        ]}
      />
    </div>
  );
}
