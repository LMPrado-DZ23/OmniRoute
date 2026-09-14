// @vitest-environment jsdom
/**
 * ProviderParamFilterSection (#6625) reported load, save and reset outcomes through
 * `notify.notify(...)`, but the notification store has no `notify` method: every call threw.
 * A failed load therefore left the skeleton on screen forever, and save/reset never showed a
 * toast. It also subscribed to the whole store, so any unrelated toast re-ran the load effect,
 * refetching the config and overwriting the operator's unsaved draft.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProviderParamFilterSection from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/ProviderParamFilterSection";
import { useNotificationStore } from "../../../src/store/notificationStore";

vi.mock("next-intl", () => {
  const t = Object.assign((key: string) => key, { rich: (key: string) => key });
  return { useTranslations: () => t };
});

const API_PATH = "/api/providers/openai/param-filters";

let container: HTMLDivElement;
let root: Root;

async function flushEffects(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function getCalls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url) === API_PATH && ((init?.method as string | undefined) ?? "GET") === method
  );
}

function notificationsOfType(type: string) {
  return useNotificationStore.getState().notifications.filter((n) => n.type === type);
}

async function renderSection() {
  await act(async () => {
    root.render(<ProviderParamFilterSection providerId="openai" />);
  });
  await flushEffects();
}

describe("ProviderParamFilterSection notifications", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useNotificationStore.setState({ notifications: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    useNotificationStore.setState({ notifications: [] });
  });

  it("shows one error toast and renders the form when loading the config fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderSection();

    expect(notificationsOfType("error")).toHaveLength(1);
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
    expect(getCalls(fetchMock, "GET")).toHaveLength(1);
  });

  it("shows a success toast after saving", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return { ok: true, json: async () => ({}) } as Response;
      return {
        ok: true,
        json: async () => ({ block: [], allow: [], autoLearn: false }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderSection();
    const blockInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => setInputValue(blockInput, "temperature"));
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("paramFiltersSaveChanges")
    ) as HTMLButtonElement;
    await act(async () => saveButton.click());
    await flushEffects();

    expect(getCalls(fetchMock, "PUT")).toHaveLength(1);
    expect(notificationsOfType("success")).toHaveLength(1);
    expect(notificationsOfType("error")).toHaveLength(0);
  });

  it("does not reload or discard the draft when an unrelated toast appears", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ block: ["seed"], allow: [], autoLearn: false }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderSection();
    const blockInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => setInputValue(blockInput, "draft-value"));

    await act(async () => {
      useNotificationStore.getState().info("unrelated toast");
    });
    await flushEffects();

    expect(getCalls(fetchMock, "GET")).toHaveLength(1);
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(
      "draft-value"
    );
  });
});
