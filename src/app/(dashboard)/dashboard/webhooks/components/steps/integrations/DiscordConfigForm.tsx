"use client";

import { useEffect, useId, useState } from "react";
import { urlHintKey, type UrlState } from "./urlHint";

export interface DiscordConfig {
  webhookUrl: string;
}

interface DiscordConfigFormProps {
  value: DiscordConfig;
  onChange: (v: DiscordConfig) => void;
  t: (key: string) => string;
}

export function DiscordConfigForm({ value, onChange, t }: DiscordConfigFormProps) {
  const fieldId = useId();
  const [urlState, setUrlState] = useState<UrlState>("idle");

  useEffect(() => {
    const url = value.webhookUrl.trim();
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
  }, [value.webhookUrl]);

  const hintKey = urlHintKey(urlState, value.webhookUrl.trim().length > 0);
  const urlHint = hintKey ? t(hintKey) : "";

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor={`${fieldId}-webhook-url`}
          className="text-xs font-medium uppercase tracking-wider text-text-muted"
        >
          {t("discord.webhookUrl")}
        </label>
        <input
          id={`${fieldId}-webhook-url`}
          value={value.webhookUrl}
          onChange={(e) => onChange({ webhookUrl: e.target.value })}
          placeholder={t("discord.webhookUrlPlaceholder")}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        {urlHint && (
          <p
            className={`mt-1 text-xs ${urlState === "ok" ? "text-emerald-500" : urlState === "checking" ? "text-text-muted" : "text-red-500"}`}
          >
            {urlHint}
          </p>
        )}
        <p className="mt-1 text-xs text-text-muted">{t("discord.webhookUrlHint")}</p>
      </div>
      <details className="rounded-lg border border-border bg-sidebar p-3">
        <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-main">
          {t("discord.tutorial")}
        </summary>
        <ol className="mt-3 space-y-1.5 text-xs text-text-muted">
          {[1, 2, 3].map((n) => (
            <li key={n} className="flex gap-2">
              <span className="font-bold text-primary">{n}.</span>
              {t(`discord.tutorialStep${n}`)}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
