"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";

// Audit C-07: dismissal used to live in component state only, so the banner came back on
// every reload. Persist it the same way the sponsor banners do (KimiSponsorBanner.tsx):
// a versioned localStorage key + a same-tab event, read through useSyncExternalStore so
// SSR (no localStorage) renders it visible and the client reconciles after hydration.
// localStorage is scoped to the origin (host:port), so each OmniRoute instance remembers
// its own dismissal.
const DISMISS_STORAGE_KEY = "omniroute-zero-config-banner-dismissed-v1";
const DISMISS_EVENT = "omniroute:zero-config-banner-dismissed";

function isNotDismissed(): boolean {
  try {
    return !localStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return true;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener(DISMISS_EVENT, callback);
  return () => window.removeEventListener(DISMISS_EVENT, callback);
}

function getServerSnapshot() {
  return true;
}

type ServerEnvPathState =
  { status: "loading" } | { status: "ready"; path: string } | { status: "unavailable" };

/**
 * Derive the `server.env` location from the /api/storage/health payload. Prefers the
 * server's explicit `serverEnvPath`; older servers only report `dataDir`, in which case
 * the file name is joined with the separator the server itself used (a Windows data dir
 * contains backslashes; anything else is POSIX). Nothing here looks at the BROWSER's
 * platform — the server, not the client, decides where its files live.
 */
export function deriveServerEnvPath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { serverEnvPath, dataDir } = payload as { serverEnvPath?: unknown; dataDir?: unknown };
  if (typeof serverEnvPath === "string" && serverEnvPath.trim()) return serverEnvPath;
  if (typeof dataDir !== "string" || !dataDir.trim()) return null;
  const separator = dataDir.includes("\\") && !dataDir.includes("/") ? "\\" : "/";
  const base = dataDir.endsWith(separator) ? dataDir.slice(0, -1) : dataDir;
  return `${base}${separator}server.env`;
}

/**
 * Shown when OmniRoute was started with auto-generated secrets (zero-config mode).
 * The `server.env` path comes from the server (management-session route
 * /api/storage/health) — it is never guessed from the browser. Until it arrives the
 * banner shows a loading placeholder, and dismissal is remembered per instance.
 */
export default function BootstrapBanner() {
  const t = useTranslations("common");
  const visible = useSyncExternalStore(subscribe, isNotDismissed, getServerSnapshot);
  const [pathState, setPathState] = useState<ServerEnvPathState>({ status: "loading" });

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      let next: ServerEnvPathState = { status: "unavailable" };
      try {
        const res = await fetch("/api/storage/health");
        if (res.ok) {
          const derived = deriveServerEnvPath(await res.json());
          if (derived) next = { status: "ready", path: derived };
        }
      } catch (err) {
        console.error("Failed to resolve server.env location:", err);
      }
      if (!cancelled) setPathState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, "true");
    } catch {
      // ignore — worst case the banner reappears next visit
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  };

  const code = (chunks: ReactNode) => (
    <code className="font-mono bg-amber-200/50 dark:bg-amber-500/20 px-1 rounded text-xs">
      {chunks}
    </code>
  );

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 mb-4"
    >
      <span className="text-amber-500 dark:text-amber-400 text-base shrink-0 mt-0.5">⚠️</span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-amber-900 dark:text-amber-300">
          {t("zeroConfigBannerTitle")}
        </p>
        <p
          className="mt-0.5 text-amber-800 dark:text-amber-200"
          aria-busy={pathState.status === "loading" ? "true" : undefined}
        >
          {pathState.status === "unavailable"
            ? t.rich("zeroConfigBannerBodyPathUnavailable", { code })
            : t.rich("zeroConfigBannerBody", {
                dataDir: pathState.status === "ready" ? pathState.path : "…",
                code,
              })}
        </p>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 text-amber-600/60 hover:text-amber-700 dark:text-amber-400/60 dark:hover:text-amber-300 transition-colors ml-1"
        aria-label={t("bootstrapBannerDismiss")}
      >
        ✕
      </button>
    </div>
  );
}
