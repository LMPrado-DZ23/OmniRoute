"use client";

import { useLocale, useTranslations } from "next-intl";
import type { LevelSpend } from "../workspaceApi";

const DOT_CLASS: Record<LevelSpend["decision"], string> = {
  allow: "bg-green-600",
  warn: "bg-amber-500",
  deny: "bg-red-600",
};

/** "$x spent of $y this period" plus a status word (never color alone). */
export function SpendLine({ spend }: { spend: LevelSpend }) {
  const t = useTranslations("workspaces");
  const locale = useLocale();
  const money = (value: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
  const status =
    spend.decision === "deny"
      ? t("statusBlocked")
      : spend.decision === "warn"
        ? t("statusWarning")
        : t("statusOk");
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-text-main">
      <span>
        {spend.limitUsd === null
          ? t("spendNoLimit", { spent: money(spend.spendUsd) })
          : t("spendWithLimit", { spent: money(spend.spendUsd), limit: money(spend.limitUsd) })}
      </span>
      {spend.limitUsd !== null && (
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${DOT_CLASS[spend.decision]}`}
          />
          {status}
        </span>
      )}
    </span>
  );
}
