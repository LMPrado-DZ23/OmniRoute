// @vitest-environment jsdom
/**
 * Audit C H1 — webhook wizard: only valid events, new events selectable, readable errors,
 * and Cancel never leaves an enabled all-events webhook behind.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventChecklist } from "../components/shared/EventChecklist";
import { AddWebhookWizard } from "../components/AddWebhookWizard";
import type { WebhookItem } from "../components/WebhookCard";
import { WEBHOOK_EVENT_VALUES } from "@/lib/webhooks/eventDescriptions";

const LABELS: Record<string, string> = {
  "wizard.next": "Next",
  "wizard.back": "Back",
  "wizard.finish": "Finish",
  "wizard.cancel": "Cancel",
  "custom.endpointUrlPlaceholder": "https://api.yourdomain.com/webhook",
  allEvents: "All events",
  saveFailed: "Failed to save",
};
const t = (key: string): string => LABELS[key] ?? key;

const roots: Array<() => void> = [];

afterEach(() => {
  roots.forEach((unmount) => act(() => unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  roots.push(() => root.unmount());
  return container;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`button "${text}" not found`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };

function recordFetch(respond: (call: FetchCall) => { ok: boolean; status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const r = respond(call);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Drives a new Custom webhook to step 3. */
async function openCustomWizardAtStep3(onClose = vi.fn()) {
  render(<AddWebhookWizard isOpen onClose={onClose} onCreated={vi.fn()} t={t} />);
  await act(async () => {});
  const customCard = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("kinds.customDesc")
  );
  if (!customCard) throw new Error("custom integration card not found");
  await click(customCard);
  await click(button("Next"));
  const url = document.querySelector(
    'input[placeholder="https://api.yourdomain.com/webhook"]'
  ) as HTMLInputElement;
  await typeInto(url, "https://hooks.example.com/x");
  await click(button("Next"));
  return onClose;
}

function okResponder(call: FetchCall) {
  if (call.url === "/api/webhooks" && call.method === "POST") {
    return { ok: true, status: 201, body: { webhook: { id: "wh-draft-1" } } };
  }
  return { ok: true, status: 200, body: { valid: true, webhook: { id: "wh-draft-1" } } };
}

describe("EventChecklist — single source of truth", () => {
  it("offers exactly WEBHOOK_EVENT_VALUES (plus All events) and no removed events", () => {
    render(<EventChecklist selected={["*"]} onChange={vi.fn()} allEventsLabel="All events" />);
    const labels = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["All events", ...WEBHOOK_EVENT_VALUES]);
    for (const ghost of ["provider.error", "provider.recovered", "combo.switched"]) {
      expect(labels).not.toContain(ghost);
    }
  });

  it("lets the user select the new SLO / circuit / budget events", () => {
    const onChange = vi.fn();
    render(<EventChecklist selected={["*"]} onChange={onChange} />);
    for (const ev of [
      "slo.breached",
      "slo.recovered",
      "provider.circuit_open",
      "budget.threshold_reached",
    ]) {
      act(() => button(ev).click());
      expect(onChange).toHaveBeenLastCalledWith([ev]);
    }
  });

  it("exposes the selection with aria-pressed (not color only)", () => {
    render(<EventChecklist selected={["slo.breached"]} onChange={vi.fn()} groupLabel="Events" />);
    expect(button("slo.breached").getAttribute("aria-pressed")).toBe("true");
    expect(button("slo.recovered").getAttribute("aria-pressed")).toBe("false");
    expect(button("All events").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Events");
  });
});

describe("AddWebhookWizard — draft lifecycle", () => {
  it("creates the step-2 webhook disabled", async () => {
    const calls = recordFetch(okResponder);
    await openCustomWizardAtStep3();
    const created = calls.find((c) => c.url === "/api/webhooks" && c.method === "POST");
    expect(created?.body).toMatchObject({ kind: "custom", enabled: false });
  });

  it("Cancel after step 2 deletes the draft, so no enabled all-events webhook remains", async () => {
    const calls = recordFetch(okResponder);
    const onClose = await openCustomWizardAtStep3();
    await click(button("Cancel"));
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/webhooks/wh-draft-1")).toBe(
      true
    );
    const enabling = calls.filter((c) => c.method === "PUT" && c.body?.enabled === true);
    expect(enabling).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it("Finish enables the webhook with the chosen events and does not delete it", async () => {
    const calls = recordFetch(okResponder);
    await openCustomWizardAtStep3();
    await click(button("All events"));
    await click(button("slo.breached"));
    await click(button("Finish"));
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/webhooks/wh-draft-1");
    expect(put?.body).toMatchObject({ events: ["slo.breached"], enabled: true });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("shows a readable validation error instead of [object Object] when Finish fails", async () => {
    recordFetch((call) => {
      if (call.method === "PUT") {
        return {
          ok: false,
          status: 400,
          body: {
            error: {
              message: "Invalid request",
              details: [{ field: "events.0", message: "Invalid option" }],
            },
          },
        };
      }
      return okResponder(call);
    });
    await openCustomWizardAtStep3();
    await click(button("Finish"));
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Invalid request: events.0: Invalid option");
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("editing an existing webhook never deletes it on Cancel", async () => {
    const calls = recordFetch(okResponder);
    const existing: WebhookItem = {
      id: "wh-existing",
      url: "https://hooks.example.com/existing",
      events: ["*"],
      secret: null,
      enabled: true,
      description: "",
      kind: "custom",
      created_at: "2026-09-18T00:00:00Z",
      last_triggered_at: null,
      last_status: null,
      failure_count: 0,
    };
    render(
      <AddWebhookWizard
        isOpen
        onClose={vi.fn()}
        onCreated={vi.fn()}
        t={t}
        editingWebhook={existing}
      />
    );
    await act(async () => {});
    await click(button("Next"));
    await click(button("Next"));
    await click(button("Cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
