// @vitest-environment jsdom
/**
 * Audit C L6 — every text input of the webhook wizard (step 2 forms, step 3 name) is
 * programmatically labelled, and the event chips form a labelled group.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackConfigForm } from "../components/steps/integrations/SlackConfigForm";
import { DiscordConfigForm } from "../components/steps/integrations/DiscordConfigForm";
import { TelegramConfigForm } from "../components/steps/integrations/TelegramConfigForm";
import { CustomConfigForm } from "../components/steps/integrations/CustomConfigForm";
import { Step3EventsAndTest } from "../components/steps/Step3EventsAndTest";

const t = (key: string): string => `label:${key}`;

const roots: Array<() => void> = [];

afterEach(() => {
  roots.forEach((unmount) => act(() => unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function render(element: React.ReactElement) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ valid: true }) }))
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  roots.push(() => root.unmount());
  return container;
}

/** The text of the <label> associated with the input via htmlFor/id. */
function labelTextsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("input:not([type=checkbox])")).map((input) => {
    const el = input as HTMLInputElement;
    const labels = Array.from(el.labels ?? []);
    return labels.map((l) => l.textContent?.trim() ?? "").join(" ");
  });
}

describe("webhook wizard inputs have accessible names", () => {
  it("Slack", () => {
    const c = render(<SlackConfigForm value={{ webhookUrl: "" }} onChange={vi.fn()} t={t} />);
    expect(labelTextsOf(c)).toEqual(["label:slack.webhookUrl"]);
  });

  it("Discord", () => {
    const c = render(<DiscordConfigForm value={{ webhookUrl: "" }} onChange={vi.fn()} t={t} />);
    expect(labelTextsOf(c)).toEqual(["label:discord.webhookUrl"]);
  });

  it("Telegram", () => {
    const c = render(
      <TelegramConfigForm value={{ botToken: "", chatId: "" }} onChange={vi.fn()} t={t} />
    );
    expect(labelTextsOf(c)).toEqual(["label:telegram.botToken", "label:telegram.chatId"]);
  });

  it("Custom", () => {
    const c = render(
      <CustomConfigForm value={{ endpointUrl: "", secretKey: "" }} onChange={vi.fn()} t={t} />
    );
    expect(labelTextsOf(c)).toEqual(["label:custom.endpointUrl", "label:custom.secretKey"]);
  });

  it("Step 3 name input and the events group", () => {
    const c = render(
      <Step3EventsAndTest
        events={["*"]}
        enabled
        description=""
        onChangeEvents={vi.fn()}
        onChangeEnabled={vi.fn()}
        onChangeDescription={vi.fn()}
        t={t}
      />
    );
    expect(labelTextsOf(c)).toEqual(["label:name"]);
    expect(c.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("label:events");
  });
});
