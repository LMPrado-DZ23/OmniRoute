"use client";

/**
 * Loop Engine page — "start a cycle" form: pattern input + submit. Owns the draft and
 * clears it once the server accepted the run.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";

interface StartRunFormProps {
  starting: boolean;
  onStart: (pattern: string) => Promise<boolean>;
}

export function StartRunForm({ starting, onStart }: StartRunFormProps) {
  const t = useTranslations("loopEngine");
  const [pattern, setPattern] = useState("");
  const trimmed = pattern.trim();

  const submit = async () => {
    if (!trimmed || starting) return;
    if (await onStart(trimmed)) setPattern("");
  };

  return (
    <div
      data-testid="loop-start-form"
      className="flex flex-col gap-2 rounded-xl border border-border bg-bg-subtle p-4 sm:flex-row sm:items-center"
    >
      <input
        type="text"
        data-testid="loop-pattern-input"
        aria-label={t("patternLabel")}
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder={t("patternPlaceholder")}
        className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
      />
      <button
        type="button"
        data-testid="loop-start-button"
        onClick={() => void submit()}
        disabled={starting || !trimmed}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {starting ? t("starting") : t("start")}
      </button>
    </div>
  );
}
