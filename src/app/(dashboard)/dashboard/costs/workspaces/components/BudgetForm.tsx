"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Select } from "@/shared/components";
import type { Budget, BudgetInterval } from "../workspaceApi";

interface BudgetFormProps {
  initial?: Budget;
  /** Show a name field (create forms). */
  withName?: boolean;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (budget: Budget, name: string) => Promise<boolean>;
}

const DEFAULT_BUDGET: Budget = { limitUsd: null, interval: "monthly", warningThreshold: 0.8 };

function parseLimit(raw: string): number | null {
  const value = Number(raw);
  return raw.trim() === "" || !Number.isFinite(value) || value <= 0 ? null : value;
}

const INTERVALS: readonly BudgetInterval[] = ["daily", "weekly", "monthly"];

function toInterval(value: string): BudgetInterval {
  return INTERVALS.find((interval) => interval === value) ?? "monthly";
}

function parseThreshold(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_BUDGET.warningThreshold;
  return Math.min(100, Math.max(1, value)) / 100;
}

/** Name (optional) + budget limit, period and alert threshold. */
export function BudgetForm({ initial, withName, submitLabel, busy, onSubmit }: BudgetFormProps) {
  const t = useTranslations("workspaces");
  const start = initial ?? DEFAULT_BUDGET;
  const [name, setName] = useState("");
  const [limit, setLimit] = useState(start.limitUsd === null ? "" : String(start.limitUsd));
  const [period, setPeriod] = useState<BudgetInterval>(start.interval);
  const [threshold, setThreshold] = useState(String(Math.round(start.warningThreshold * 100)));

  const intervals = [
    { value: "daily", label: t("intervalDaily") },
    { value: "weekly", label: t("intervalWeekly") },
    { value: "monthly", label: t("intervalMonthly") },
  ];

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const budget = {
      limitUsd: parseLimit(limit),
      interval: period,
      warningThreshold: parseThreshold(threshold),
    };
    const ok = await onSubmit(budget, name.trim());
    if (ok && withName) {
      setName("");
      setLimit("");
    }
  };

  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      {withName && (
        <Input
          className="sm:col-span-2"
          label={t("nameLabel")}
          value={name}
          required
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      <Input
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        label={t("budgetLimitLabel")}
        hint={t("budgetLimitHint")}
        value={limit}
        onChange={(event) => setLimit(event.target.value)}
      />
      <Select
        label={t("intervalLabel")}
        options={intervals}
        value={period}
        onChange={(event) => setPeriod(toInterval(event.target.value))}
      />
      <Input
        type="number"
        min={1}
        max={100}
        step="1"
        label={t("thresholdLabel")}
        value={threshold}
        onChange={(event) => setThreshold(event.target.value)}
      />
      <div className="flex items-end">
        <Button type="submit" loading={busy} disabled={busy || (withName && !name.trim())}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
