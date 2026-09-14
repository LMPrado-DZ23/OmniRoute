// @vitest-environment jsdom
/**
 * The traffic inspector's custom hosts dialog validates the host with Zod and showed the first
 * issue's message. It read `parsed.error.errors`, which Zod 4 no longer has (only `issues`), so an
 * invalid host threw a TypeError inside the Add handler: no message was shown and the operator got
 * no feedback. The validation message must be shown, and nothing must be posted.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomHostsManager } from "../../../src/app/(dashboard)/dashboard/tools/traffic-inspector/components/CustomHostsManager";

vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});

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

describe("CustomHostsManager host validation", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("shows the validation message for an invalid host and posts nothing", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ hosts: [] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<CustomHostsManager onClose={() => {}} />);
    });
    await flushEffects();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "bad host!"));
    const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("addHost")
    ) as HTMLButtonElement;
    await act(async () => addButton.click());
    await flushEffects();

    expect(container.textContent ?? "").toContain("invalidHostname");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
