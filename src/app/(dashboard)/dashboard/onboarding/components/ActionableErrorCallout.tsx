"use client";

import { useTranslations } from "next-intl";
import type { ActionableErrorGuide } from "@/shared/utils/actionableError";

interface ActionableErrorCalloutProps {
  /** What happened — the readable headline (announced via role="alert"). */
  message: string;
  guide: ActionableErrorGuide;
  onRetry?: () => void;
  /** Optional second action, e.g. "Back to provider" for a rejected credential. */
  secondaryAction?: { label: string; onClick: () => void };
}

/**
 * Error block of the first-use flow: what happened, why, how to fix it, whether trying
 * again can help, and a link to the guide. Only the headline carries role="alert" so
 * screen readers announce the failure once; the guidance stays readable below it.
 */
export function ActionableErrorCallout({
  message,
  guide,
  onRetry,
  secondaryAction,
}: ActionableErrorCalloutProps) {
  const t = useTranslations("onboarding");
  return (
    <div
      data-testid="actionable-error"
      data-error-kind={guide.kind}
      className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-left animate-in fade-in duration-200"
    >
      <p role="alert" className="text-sm font-medium text-error-strong break-words">
        {message}
      </p>
      <dl className="space-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-semibold text-text-main">{t("errorGuide.whyLabel")}: </dt>
          <dd className="inline">{t(`errorGuide.${guide.kind}.why`)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold text-text-main">{t("errorGuide.fixLabel")}: </dt>
          <dd className="inline">{t(`errorGuide.${guide.kind}.fix`)}</dd>
        </div>
      </dl>
      <p className="text-xs text-text-muted">
        {guide.retryable ? t("errorGuide.retryPossible") : t("errorGuide.retryAfterFix")}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs font-medium text-text-main underline cursor-pointer"
          >
            {t("retry")}
          </button>
        )}
        {secondaryAction && (
          <button
            type="button"
            onClick={secondaryAction.onClick}
            className="text-xs font-medium text-text-main underline cursor-pointer"
          >
            {secondaryAction.label}
          </button>
        )}
        <a
          href={guide.docsHref}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline"
        >
          {t("errorGuide.docsLink")}
        </a>
      </div>
    </div>
  );
}
