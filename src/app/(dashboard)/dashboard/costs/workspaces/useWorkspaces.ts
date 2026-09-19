"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import * as api from "./workspaceApi";

/** State and actions of the workspaces page. Every action reloads what it changed. */
export function useWorkspaces() {
  const t = useTranslations("workspaces");
  const notifySuccess = useNotificationStore((state) => state.success);
  const notifyError = useNotificationStore((state) => state.error);
  const [workspaces, setWorkspaces] = useState<api.WorkspaceView[]>([]);
  const [apiKeys, setApiKeys] = useState<api.ApiKeyOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<api.WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const [list, keys] = await Promise.all([api.listWorkspaces(), api.listApiKeys()]);
      setWorkspaces(list);
      setApiKeys(keys);
    } catch {
      notifyError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [notifyError, t]);

  const loadDetail = useCallback(
    async (workspaceId: string | null) => {
      if (!workspaceId) {
        setDetail(null);
        return;
      }
      try {
        setDetail(await api.getWorkspace(workspaceId));
      } catch {
        setDetail(null);
        notifyError(t("loadError"));
      }
    },
    [notifyError, t]
  );

  useEffect(() => {
    void (async () => {
      await loadList();
    })();
  }, [loadList]);

  useEffect(() => {
    void (async () => {
      await loadDetail(selectedId);
    })();
  }, [loadDetail, selectedId]);

  /** Run a mutation, report it, refresh. Resolves `true` on success. */
  const run = useCallback(
    async (action: () => Promise<unknown>, doneMessage: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        notifySuccess(doneMessage);
        await Promise.all([loadList(), loadDetail(selectedId)]);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyError(t("requestError", { message }));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadDetail, loadList, notifyError, notifySuccess, selectedId, t]
  );

  return {
    workspaces,
    apiKeys,
    selectedId,
    setSelectedId,
    detail,
    loading,
    busy,
    createWorkspace: (name: string, budget: api.Budget) =>
      run(() => api.createWorkspace(name, budget), t("createdMessage")),
    saveWorkspaceBudget: (budget: api.Budget) =>
      run(() => api.updateWorkspaceBudget(selectedId ?? "", budget), t("savedMessage")),
    deleteWorkspace: async () => {
      const ok = await run(() => api.deleteWorkspace(selectedId ?? ""), t("deletedMessage"));
      if (ok) setSelectedId(null);
      return ok;
    },
    createProject: (name: string, budget: api.Budget) =>
      run(() => api.createProject(selectedId ?? "", name, budget), t("createdMessage")),
    saveProjectBudget: (projectId: string, budget: api.Budget) =>
      run(() => api.updateProjectBudget(selectedId ?? "", projectId, budget), t("savedMessage")),
    saveProjectKeys: (projectId: string, apiKeyIds: string[]) =>
      run(() => api.setProjectKeys(selectedId ?? "", projectId, apiKeyIds), t("savedMessage")),
    deleteProject: (projectId: string) =>
      run(() => api.deleteProject(selectedId ?? "", projectId), t("deletedMessage")),
  };
}
