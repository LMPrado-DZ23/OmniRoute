/**
 * OmniRoute Electron Types
 *
 * TypeScript definitions for the Electron API exposed to the renderer process.
 * Must list exactly the members electron/preload.js exposes
 * (tests/unit/electron-api-types-contract.test.ts).
 *
 * Updated to reflect:
 * - Fix #6: onServerStatus/onPortChanged return disposer functions
 * - Removed removeServerStatusListener/removePortChangedListener (replaced by disposers)
 */

export interface AppInfo {
  name: string;
  version: string;
  platform: "win32" | "darwin" | "linux";
  isDev: boolean;
  port: number;
  /** Set when Remote Server Mode is active (tray → Remote Server → Connect…). */
  remoteServerUrl: string | null;
}

export interface ServerStatus {
  status: "starting" | "running" | "stopped" | "restarting" | "error";
  port: number;
  /** Present only while connected to a remote server instead of the embedded one. */
  remoteUrl?: string;
}

/**
 * Failure result of an invoke channel. Every privileged channel resolves to this when
 * withPrivilegedSender (electron/lib/ipcOriginGuard.js) denies a non-local sender, e.g. a
 * remote dashboard loaded in Remote Server mode, and the update handlers also use it for errors.
 */
export interface IpcFailure {
  success: false;
  error: string;
}

/** `update-status` events forwarded from electron-updater (electron/main.js). */
export type UpdateStatus =
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "not-available"; version: string }
  | { status: "downloading"; percent: number; transferred: number; total: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

/** `login:status` events from electron/loginManager.js, plus `persisted` from electron/main.js. */
export interface LoginStatus {
  providerId: string;
  status:
    | "starting"
    | "navigating"
    | "waiting"
    | "detected"
    | "complete"
    | "cancelled"
    | "error"
    | "persisted";
  message: string;
}

/**
 * Result of `login:start`. Extracted credentials are persisted in the main process and never
 * returned to the renderer; `credentialsPersisted` says whether that happened.
 */
export interface StartLoginResult {
  success: boolean;
  error?: string;
  credentialsPersisted?: boolean;
}

export interface ElectronAPI {
  // ── Invoke (async) ─────────────────────────────────────
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  getDataDir(): Promise<string>;
  restartServer(): Promise<{ success: boolean }>;
  getAppVersion(): Promise<string>;

  // ── Auto-update ────────────────────────────────────────
  checkForUpdates(): Promise<{ success: true } | IpcFailure>;
  downloadUpdate(): Promise<{ success: true } | IpcFailure>;
  /** Quits and installs; the handler itself returns nothing. */
  installUpdate(): Promise<void | IpcFailure>;

  // ── Autostart ──────────────────────────────────────────
  getAutostartStatus(): Promise<boolean>;
  enableAutostart(): Promise<boolean | IpcFailure>;
  disableAutostart(): Promise<boolean | IpcFailure>;

  // ── Web-cookie login ───────────────────────────────────
  startLogin(
    providerId: string,
    options?: { timeout?: number }
  ): Promise<StartLoginResult | IpcFailure>;
  cancelLogin(): Promise<{ success: true } | IpcFailure>;
  getLoginStatus(): Promise<{ active: boolean }>;

  // ── Send (fire-and-forget) ─────────────────────────────
  minimizeWindow(): void;
  maximizeWindow(): void;
  closeWindow(): void;

  // ── Receive (returns disposer for cleanup) ─────────────
  onServerStatus(callback: (data: ServerStatus) => void): () => void;
  onPortChanged(callback: (port: number) => void): () => void;
  onUpdateStatus(callback: (data: UpdateStatus) => void): () => void;
  onLoginStatus(callback: (status: LoginStatus) => void): () => void;

  // ── Static Properties ──────────────────────────────────
  isElectron: boolean;
  platform: "win32" | "darwin" | "linux";
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
