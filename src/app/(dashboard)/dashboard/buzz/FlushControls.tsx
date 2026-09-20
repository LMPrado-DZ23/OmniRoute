"use client";

/**
 * Buzz Hub page — "Publish pending" action. Disabled while the flag is off (nothing can
 * reach a relay) with the reason in the tooltip; the last flush outcome is announced
 * next to it as a polite status.
 */
import { useTranslations } from "next-intl";

interface FlushControlsProps {
  enabled: boolean;
  flushing: boolean;
  message: string | null;
  onFlush: () => void;
}

export function FlushControls({ enabled, flushing, message, onFlush }: FlushControlsProps) {
  const t = useTranslations("buzzHub");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        data-testid="buzz-flush"
        onClick={onFlush}
        disabled={flushing || !enabled}
        title={enabled ? undefined : t("flushDisabledHint")}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      >
        {flushing ? t("flushing") : t("flush")}
      </button>
      {message && (
        <span
          role="status"
          aria-live="polite"
          data-testid="buzz-flush-message"
          className="text-sm text-text-muted"
        >
          {message}
        </span>
      )}
    </div>
  );
}
