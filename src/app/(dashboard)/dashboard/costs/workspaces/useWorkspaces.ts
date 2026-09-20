"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import * as api from "./workspaceApi";

type Notify = (message: string) => unknown;

/** What the page reads: the visible workspaces, the API keys, and the selected workspace. */
function useWorkspaceData(selectedId: string | null, notifyError: Notify, loadErrorText: string) {
  const [workspaces, setWorkspaces] = useState<api.WorkspaceView[]>([]);
  const [apiKeys, setApiKeys] = useState<api.ApiKeyOption[]>([]);
  const [detail, setDetail] = useState<api.WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed load used to leave `workspaces` at [] with only a toast, and toasts
  // auto-dismiss after 8s — after which the page asserted, cheerfully, that the
  // account has no workspaces. "We could not reach the server" and "you have none"
  // are different facts and must not render the same.
  const [loadFailed, setLoadFailed] = useState(false);

  const reloadList = useCallback(async () => {
    try {
      const [list, keys] = await Promise.all([api.listWorkspaces(), api.listApiKeys()]);
      setWorkspaces(list);
      setApiKeys(keys);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      notifyError(loadErrorText);
    } finally {
      setLoading(false);
    }
  }, [loadErrorText, notifyError]);

  const reloadDetail = useCallback(
    async (workspaceId: string | null) => {
      if (!workspaceId) {
        setDetail(null);
        return;
      }
      try {
        setDetail(await api.getWorkspace(workspaceId));
      } catch {
        setDetail(null);
        notifyError(loadErrorText);
      }
    },
    [loadErrorText, notifyError]
  );

  useEffect(() => {
    void (async () => {
      await reloadList();
    })();
  }, [reloadList]);

  useEffect(() => {
    void (async () => {
      await reloadDetail(selectedId);
    })();
  }, [reloadDetail, selectedId]);

  return { workspaces, apiKeys, detail, loading, loadFailed, reloadList, reloadDetail };
}

interface RunnerDeps {
  reloadList: () => Promise<void>;
  reloadDetail: (workspaceId: string | null) => Promise<void>;
  selectedId: string | null;
  notifySuccess: Notify;
  notifyError: Notify;
  requestErrorText: (message: string) => string;
}

/** Runs one mutation: report it, refresh what it changed, resolve `true` on success. */
function useMutationRunner(deps: RunnerDeps) {
  const [busy, setBusy] = useState(false);
  const { reloadDetail, reloadList, selectedId, notifyError, notifySuccess, requestErrorText } =
    deps;

  const run = useCallback(
    async (action: () => Promise<unknown>, doneMessage: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        notifySuccess(doneMessage);
        await Promise.all([reloadList(), reloadDetail(selectedId)]);
        return true;
      } catch (error) {
        notifyError(requestErrorText(error instanceof Error ? error.message : String(error)));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notifyError, notifySuccess, reloadDetail, reloadList, requestErrorText, selectedId]
  );

  return { busy, run };
}

/** State and actions of the workspaces page. */
export function useWorkspaces() {
  const t = useTranslations("workspaces");
  const notifySuccess = useNotificationStore((state) => state.success);
  const notifyError = useNotificationStore((state) => state.error);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = useWorkspaceData(selectedId, notifyError, t("loadError"));
  const requestErrorText = useCallback((message: string) => t("requestError", { message }), [t]);
  const { busy, run } = useMutationRunner({
    reloadList: data.reloadList,
    reloadDetail: data.reloadDetail,
    selectedId,
    notifySuccess,
    notifyError,
    requestErrorText,
  });
  const workspace = () => selectedId ?? "";

  return {
    workspaces: data.workspaces,
    apiKeys: data.apiKeys,
    detail: data.detail,
    loading: data.loading,
    loadFailed: data.loadFailed,
    retryLoad: data.reloadList,
    selectedId,
    setSelectedId,
    busy,
    createWorkspace: (name: string, budget: api.Budget) =>
      run(() => api.createWorkspace(name, budget), t("createdMessage")),
    saveWorkspaceBudget: (budget: api.Budget) =>
      run(() => api.updateWorkspaceBudget(workspace(), budget), t("savedMessage")),
    deleteWorkspace: async () => {
      const ok = await run(() => api.deleteWorkspace(workspace()), t("deletedMessage"));
      if (ok) setSelectedId(null);
      return ok;
    },
    createProject: (name: string, budget: api.Budget) =>
      run(() => api.createProject(workspace(), name, budget), t("createdMessage")),
    saveProjectBudget: (projectId: string, budget: api.Budget) =>
      run(() => api.updateProjectBudget(workspace(), projectId, budget), t("savedMessage")),
    saveProjectKeys: (projectId: string, apiKeyIds: string[]) =>
      run(() => api.setProjectKeys(workspace(), projectId, apiKeyIds), t("savedMessage")),
    deleteProject: (projectId: string) =>
      run(() => api.deleteProject(workspace(), projectId), t("deletedMessage")),
  };
}
