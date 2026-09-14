// @vitest-environment jsdom
/**
 * Finding F-8: every privileged Electron IPC channel resolves to `{ success: false, error }`
 * when the main process refuses the sender (a remote dashboard in Remote Server mode —
 * electron/lib/ipcOriginGuard.js). That object is truthy and is not the value the caller asked
 * for, so it must never be read as "autostart applied" or as the data-directory path.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAutostart, useDataDir } from "../useElectron";

const denied = (channel: string) => ({
  success: false,
  error: `${channel} is not available from a remote context`,
});

function installElectronApi(api: Record<string, unknown>) {
  Object.defineProperty(window, "electronAPI", {
    value: { isElectron: true, ...api },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "electronAPI");
});

describe("requestAutostart", () => {
  it("reports the change as applied only when the main process answers true", async () => {
    const enableAutostart = vi.fn().mockResolvedValue(true);
    const disableAutostart = vi.fn().mockResolvedValue(true);
    installElectronApi({ enableAutostart, disableAutostart });

    expect(await requestAutostart(true)).toBe(true);
    expect(await requestAutostart(false)).toBe(true);
    expect(enableAutostart).toHaveBeenCalledTimes(1);
    expect(disableAutostart).toHaveBeenCalledTimes(1);
  });

  it("does not report a refused remote sender as applied", async () => {
    installElectronApi({
      enableAutostart: vi.fn().mockResolvedValue(denied("enable-autostart")),
      disableAutostart: vi.fn().mockResolvedValue(denied("disable-autostart")),
    });

    expect(await requestAutostart(true)).toBe(false);
    expect(await requestAutostart(false)).toBe(false);
  });

  it("does not report a failed OS call as applied", async () => {
    installElectronApi({
      enableAutostart: vi.fn().mockResolvedValue(false),
      disableAutostart: vi.fn().mockResolvedValue(false),
    });

    expect(await requestAutostart(true)).toBe(false);
    expect(await requestAutostart(false)).toBe(false);
  });

  it("does nothing outside Electron", async () => {
    expect(await requestAutostart(true)).toBe(false);
  });
});

describe("useDataDir", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function renderDataDir() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    function Probe() {
      const { dataDir, loading, error } = useDataDir();
      return (
        <span data-testid="state">
          {JSON.stringify({ dataDir, loading, error: error ? error.message : null })}
        </span>
      );
    }

    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {});
    return JSON.parse(container.querySelector('[data-testid="state"]')?.textContent ?? "null");
  }

  it("exposes the directory the main process returns", async () => {
    installElectronApi({ getDataDir: vi.fn().mockResolvedValue("C:\\Users\\me\\.omniroute") });

    expect(await renderDataDir()).toEqual({
      dataDir: "C:\\Users\\me\\.omniroute",
      loading: false,
      error: null,
    });
  });

  it("surfaces a refused remote sender as an error instead of a data directory", async () => {
    installElectronApi({ getDataDir: vi.fn().mockResolvedValue(denied("get-data-dir")) });

    expect(await renderDataDir()).toEqual({
      dataDir: null,
      loading: false,
      error: "get-data-dir is not available from a remote context",
    });
  });
});
