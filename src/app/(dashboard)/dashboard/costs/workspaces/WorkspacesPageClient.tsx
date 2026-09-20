"use client";

import { useTranslations } from "next-intl";
import { Button, Card, EmptyState, Loading } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { BudgetForm } from "./components/BudgetForm";
import { ProjectPanel } from "./components/ProjectPanel";
import { SpendLine } from "./components/SpendLine";
import { useWorkspaces } from "./useWorkspaces";

type WorkspacesState = ReturnType<typeof useWorkspaces>;

function WorkspaceList({ state }: { state: WorkspacesState }) {
  const t = useTranslations("workspaces");
  if (state.workspaces.length === 0) {
    return (
      <EmptyState icon="workspaces" title={t("emptyTitle")} description={t("emptyDescription")} />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {state.workspaces.map((workspace) => {
        const selected = workspace.id === state.selectedId;
        return (
          <li key={workspace.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => state.setSelectedId(workspace.id)}
              className={cn(
                "w-full rounded-lg border px-3 py-2 text-left text-text-main transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                selected
                  ? "border-accent bg-accent/10"
                  : "border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
              )}
            >
              <span className="block font-medium">{workspace.name}</span>
              <SpendLine spend={workspace.spend} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceDetailPanel({ state }: { state: WorkspacesState }) {
  const t = useTranslations("workspaces");
  const detail = state.detail;
  if (!detail) return <p className="text-sm text-text-main">{t("selectPrompt")}</p>;
  const { workspace, projects } = detail;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-text-main">{workspace.name}</h2>
          <SpendLine spend={workspace.spend} />
        </div>
        <Button
          variant="danger"
          size="sm"
          disabled={state.busy}
          onClick={() => void state.deleteWorkspace()}
        >
          {t("deleteWorkspaceAction")}
        </Button>
      </div>
      <section aria-labelledby="workspace-budget-heading">
        <h3 id="workspace-budget-heading" className="mb-2 font-semibold text-text-main">
          {t("workspaceBudgetTitle")}
        </h3>
        <BudgetForm
          key={workspace.id}
          initial={workspace.budget}
          submitLabel={t("saveBudgetAction")}
          busy={state.busy}
          onSubmit={(budget) => state.saveWorkspaceBudget(budget)}
        />
      </section>
      <section aria-labelledby="workspace-projects-heading" className="flex flex-col gap-3">
        <h3 id="workspace-projects-heading" className="font-semibold text-text-main">
          {t("projectsTitle")}
        </h3>
        {projects.length === 0 && <p className="text-sm text-text-main">{t("noProjects")}</p>}
        {projects.map((project) => (
          <ProjectPanel
            key={project.id}
            project={project}
            apiKeys={state.apiKeys}
            busy={state.busy}
            onSaveBudget={(budget) => state.saveProjectBudget(project.id, budget)}
            onSaveKeys={(apiKeyIds) => state.saveProjectKeys(project.id, apiKeyIds)}
            onDelete={() => state.deleteProject(project.id)}
          />
        ))}
      </section>
      <section aria-labelledby="workspace-new-project-heading">
        <h3 id="workspace-new-project-heading" className="mb-2 font-semibold text-text-main">
          {t("createProjectTitle")}
        </h3>
        <BudgetForm
          key={`new-project-${workspace.id}`}
          withName
          submitLabel={t("createProjectAction")}
          busy={state.busy}
          onSubmit={(budget, name) => state.createProject(name, budget)}
        />
      </section>
    </div>
  );
}

/** /dashboard/costs/workspaces — workspaces, projects, key assignment and budgets. */
export function WorkspacesPageClient() {
  const t = useTranslations("workspaces");
  const state = useWorkspaces();
  if (state.loading) return <Loading />;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="text-lg font-semibold text-text-main">{t("title")}</h2>
        <p className="mt-1 text-sm text-text-main">{t("subtitle")}</p>
        <p className="mt-2 text-sm text-text-main">{t("rollupNote")}</p>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <section aria-labelledby="workspace-create-heading">
              <h2 id="workspace-create-heading" className="mb-3 font-semibold text-text-main">
                {t("createWorkspaceTitle")}
              </h2>
              <BudgetForm
                withName
                submitLabel={t("createWorkspaceAction")}
                busy={state.busy}
                onSubmit={(budget, name) => state.createWorkspace(name, budget)}
              />
            </section>
          </Card>
          <Card>
            <nav aria-labelledby="workspace-list-heading">
              <h2 id="workspace-list-heading" className="mb-3 font-semibold text-text-main">
                {t("listLabel")}
              </h2>
              <WorkspaceList state={state} />
            </nav>
          </Card>
        </div>
        <Card>
          <WorkspaceDetailPanel state={state} />
        </Card>
      </div>
    </div>
  );
}
