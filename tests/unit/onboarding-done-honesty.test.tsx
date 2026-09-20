// @vitest-environment jsdom
/**
 * The wizard's final step must not claim the instance can route when it cannot.
 *
 * The product audit walked the first-run wizard and skipped the provider step. Step 5
 * correctly reported "No provider found". Step 6 then said:
 *
 *   "You're all set! Your OmniRoute instance is configured and ready to proxy AI
 *    requests."
 *
 * …and printed an endpoint and an API-key block. `onboarding.doneDesc` was rendered
 * unconditionally, so the wizard contradicted itself one step apart and sent the user
 * off to debug a gateway that had nothing to route to.
 *
 * `clientModelId` is null in exactly that state — no connection, or no model chosen —
 * so the honest branch already had its signal.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { FirstUseDone } from "@/app/(dashboard)/dashboard/onboarding/steps/FirstUseDone";

const READY =
  "You're all set! Your OmniRoute instance is configured and ready to proxy AI requests.";
const NO_PROVIDER = "No provider found. You can add one from the dashboard later.";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({ doneDesc: READY, noProviderFound: NO_PROVIDER })[key] ?? key,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(modelId: string | null) {
  root = createRoot(container);
  await act(async () => {
    root.render(<FirstUseDone apiEndpoint="http://127.0.0.1:20128/v1" modelId={modelId} />);
  });
}

test("with no routable model it says no provider was found, not that it is ready", async () => {
  await render(null);

  expect(container.textContent).toContain(NO_PROVIDER);
  expect(
    container.textContent,
    "the wizard must not declare the instance ready one step after reporting no provider"
  ).not.toContain(READY);
});

test("with a model it still congratulates the user", async () => {
  await render("openai/gpt-4o-mini");

  expect(container.textContent).toContain(READY);
  expect(container.textContent).not.toContain(NO_PROVIDER);
});
