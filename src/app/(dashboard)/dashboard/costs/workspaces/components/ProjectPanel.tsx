"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Checkbox } from "@/shared/components";
import type { ApiKeyOption, Budget, ProjectView } from "../workspaceApi";
import { BudgetForm } from "./BudgetForm";
import { SpendLine } from "./SpendLine";

interface ProjectPanelProps {
  project: ProjectView;
  apiKeys: ApiKeyOption[];
  busy: boolean;
  onSaveBudget: (budget: Budget) => Promise<boolean>;
  onSaveKeys: (apiKeyIds: string[]) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

/** One project: spend, budget, the keys assigned to it, delete. */
export function ProjectPanel({
  project,
  apiKeys,
  busy,
  onSaveBudget,
  onSaveKeys,
  onDelete,
}: ProjectPanelProps) {
  const t = useTranslations("workspaces");
  const [selected, setSelected] = useState<string[]>(project.apiKeyIds);
  const headingId = `project-${project.id}-heading`;

  const toggle = (apiKeyId: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, apiKeyId] : current.filter((id) => id !== apiKeyId)
    );

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-black/10 p-4 dark:border-white/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="text-base font-semibold text-text-main">
          {project.name}
        </h4>
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void onDelete()}>
          {t("deleteProjectAction")}
        </Button>
      </div>
      <SpendLine spend={project.spend} />
      <div className="mt-3">
        <BudgetForm
          initial={project.budget}
          submitLabel={t("saveBudgetAction")}
          busy={busy}
          onSubmit={(budget) => onSaveBudget(budget)}
        />
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-text-main">{t("keysLegend")}</legend>
        {apiKeys.length === 0 ? (
          <p className="mt-2 text-sm text-text-main">{t("keysEmpty")}</p>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {apiKeys.map((key) => {
              const elsewhere = key.projectId !== null && key.projectId !== project.id;
              return (
                <Checkbox
                  key={key.id}
                  label={elsewhere ? t("keyAssignedElsewhere", { name: key.name }) : key.name}
                  checked={selected.includes(key.id)}
                  disabled={busy || elsewhere}
                  onChange={(event) => toggle(key.id, event.target.checked)}
                />
              );
            })}
          </div>
        )}
        <Button
          className="mt-3"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void onSaveKeys(selected)}
        >
          {t("saveKeysAction")}
        </Button>
      </fieldset>
    </section>
  );
}
