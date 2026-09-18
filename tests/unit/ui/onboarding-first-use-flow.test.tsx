// @vitest-environment jsdom
/**
 * Phase 6 first-use flow in the onboarding wizard: the test step validates the connection
 * the user JUST added (it used to test `connections[0]`), lists the provider's models, sends
 * a test request through /api/models/test, and the done step shows the client configuration
 * and the first request from the call logs. Every failure renders what/why/fix/retry/docs.
 */
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${JSON.stringify(values)})` : key;
    t.has = (key: string) => key.startsWith("apiErrors.");
    return t;
  },
}));
vi.mock("@/shared/hooks", () => ({
  useDisplayBaseUrl: () => "https://gw.example.com",
}));
vi.mock(
  "../../../src/app/(dashboard)/dashboard/onboarding/steps/FreeProviderOnboardingCard",
  () => ({ FreeProviderOnboardingCard: () => null })
);

const { default: OnboardingWizard } =
  await import("../../../src/app/(dashboard)/dashboard/onboarding/page");

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let handlers: Record<string, Handler>;
let calls: Array<{ url: string; method: string; body: unknown }>;

function reply(status: number, body: unknown) {
  return () => ({ status, body });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const waitForText = (text: string) =>
  waitFor(() => Boolean(container.textContent?.includes(text)), text);

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
  await tick();
}

async function typeInto(selector: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Input not found: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function errorKinds(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="actionable-error"]')
  ).map((el) => el.dataset.errorKind ?? "");
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  pushMock.mockReset();
  replaceMock.mockReset();
  calls = [];
  handlers = {
    "GET /api/settings": reply(200, { setupComplete: false }),
    "GET /api/settings/require-login": reply(200, { hasPassword: false }),
    "POST /api/settings/require-login": reply(200, { success: true }),
    "POST /api/auth/login": reply(200, { success: true }),
    "POST /api/providers": reply(201, {
      connection: { id: "conn-new", provider: "openai", name: "OpenAI" },
    }),
    // An OLDER connection is listed first: the wizard must still test the new one.
    "GET /api/providers": reply(200, {
      connections: [
        { id: "conn-old", provider: "groq", name: "Old Groq" },
        { id: "conn-new", provider: "openai", name: "OpenAI" },
      ],
    }),
    "POST /api/providers/conn-new/test": reply(200, { valid: true, error: null }),
    "GET /api/providers/conn-new/models?chatOnly=true&excludeHidden=true": reply(200, {
      models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
    }),
    "POST /api/models/test": reply(200, { status: "ok", latencyMs: 321, responseText: "hi" }),
    "GET /api/usage/call-logs?limit=5": reply(200, [
      { model: "openai/gpt-4o-mini", status: 200, timestamp: "2026-09-18T10:00:00Z" },
    ]),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      const handler = handlers[`${method} ${url}`];
      if (!handler) throw new Error(`Unexpected request: ${method} ${url}`);
      const { status, body: payload } = handler(init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      } as Response;
    })
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

async function reachProviderStep(): Promise<void> {
  await act(async () => {
    root.render(<OnboardingWizard />);
  });
  await waitForText("getStarted");
  await click("getStarted");
  await click("continue");
  await typeInto('input[aria-label="enterPassword"]', "hunter22!");
  await typeInto('input[aria-label="confirmPasswordPlaceholder"]', "hunter22!");
  await click("setPassword");
  await waitForText("providerDesc");
}

async function addProviderAndOpenTest(): Promise<void> {
  await reachProviderStep();
  await click("OpenAI");
  await typeInto('input[aria-label="apiKeyRequired"]', "sk-test-not-a-real-key");
  await click("addProvider");
  await waitForText("runTest");
}

it("walks validate → choose model → test request → client config → first request", async () => {
  await addProviderAndOpenTest();
  await click("runTest");
  await waitForText("connectionSuccessful");

  expect(calls.some((c) => c.url === "/api/providers/conn-new/test")).toBe(true);
  expect(calls.some((c) => c.url === "/api/providers/conn-old/test")).toBe(false);

  await waitForText("chooseModelTitle");
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="modelLabel"]');
  expect(Array.from(select?.options ?? []).map((o) => o.value)).toEqual(["gpt-4o-mini", "gpt-4o"]);

  await click("sendTestRequest");
  await waitForText("testRequestOk");
  const trial = calls.find((c) => c.url === "/api/models/test");
  expect(trial?.body).toEqual({
    providerId: "openai",
    modelId: "gpt-4o-mini",
    connectionId: "conn-new",
  });
  expect(container.textContent).toContain('testRequestOk({"ms":321})');

  await click("continue");
  await waitForText("clientConfigTitle");
  expect(container.textContent).toContain("https://gw.example.com/api/v1");
  expect(container.textContent).toContain("openai/gpt-4o-mini");
  expect(container.textContent).toContain("sk-your-omniroute-key");

  await click("copyConfig");
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    "Base URL: https://gw.example.com/api/v1\nAPI key:  sk-your-omniroute-key\nModel:    openai/gpt-4o-mini\n"
  );
  await waitForText("copied");

  await waitFor(
    () => Boolean(container.querySelector('[data-testid="first-request"]')),
    "first request row"
  );
  expect(container.querySelector('[data-testid="first-request"]')?.textContent).toContain(
    '"model":"openai/gpt-4o-mini"'
  );
  const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
  expect(hrefs).toEqual(
    expect.arrayContaining([
      "/dashboard/logs",
      "/dashboard/api-manager",
      "/docs/getting-started/first_10_minutes",
    ])
  );
});

it("a rejected credential explains why and how to fix, and leads back to the provider step", async () => {
  handlers["POST /api/providers/conn-new/test"] = reply(200, {
    valid: false,
    error: "Invalid API key",
    diagnosis: { type: "upstream_auth_error", code: "401", message: "Invalid API key" },
  });
  await addProviderAndOpenTest();
  await click("runTest");
  await waitForText("Invalid API key");

  expect(errorKinds()).toEqual(["credential"]);
  expect(container.textContent).toContain("errorGuide.credential.why");
  expect(container.textContent).toContain("errorGuide.credential.fix");
  expect(container.textContent).toContain("errorGuide.retryAfterFix");
  const docs = container.querySelector('[data-testid="actionable-error"] a');
  expect(docs?.getAttribute("href")).toBe("/docs/getting-started/providers-guide");
  expect(container.textContent).not.toContain("chooseModelTitle");

  await click("backToProvider");
  await waitForText("providerDesc");
});

it("a transport failure is retryable and the retry re-runs the probe", async () => {
  let attempts = 0;
  handlers["POST /api/providers/conn-new/test"] = () => {
    attempts += 1;
    return attempts === 1
      ? {
          status: 200,
          body: {
            valid: false,
            error: "Could not connect to api.openai.com",
            diagnosis: { type: "network_error", code: "UPSTREAM_UNREACHABLE" },
          },
        }
      : { status: 200, body: { valid: true } };
  };
  await addProviderAndOpenTest();
  await click("runTest");
  await waitFor(() => errorKinds().includes("unreachable"), "unreachable guidance");
  expect(container.textContent).toContain("errorGuide.retryPossible");

  await click("retry");
  await waitForText("connectionSuccessful");
  expect(attempts).toBe(2);
});

it("a blocked paid model and an empty model list get their own guidance", async () => {
  handlers["GET /api/providers/conn-new/models?chatOnly=true&excludeHidden=true"] = reply(200, {
    models: [],
  });
  handlers["POST /api/models/test"] = reply(403, {
    status: "error",
    error: "Paid model blocked while hidePaidModels is enabled",
  });
  await addProviderAndOpenTest();
  await click("runTest");
  await waitFor(() => errorKinds().includes("noModels"), "noModels guidance");

  // No listed model: the user can still type an id.
  await typeInto('input[aria-label="modelLabel"]', "gpt-4o");
  await click("sendTestRequest");
  await waitFor(() => errorKinds().includes("paidModelBlocked"), "paid model guidance");
  expect(container.textContent).toContain("Paid model blocked while hidePaidModels is enabled");
});

it("an existing password (INITIAL_PASSWORD) is kept without the skip-and-disable-login option", async () => {
  handlers["GET /api/settings/require-login"] = reply(200, { hasPassword: true });
  await act(async () => {
    root.render(<OnboardingWizard />);
  });
  await waitForText("getStarted");
  await click("getStarted");
  await click("continue");
  await waitForText("passwordAlreadySet");

  expect(container.textContent).not.toContain("skipPassword");
  await click("keepPassword");
  await waitForText("providerDesc");
  expect(calls.some((c) => c.url === "/api/settings/require-login" && c.method === "POST")).toBe(
    false
  );
});

it("?rerun=1 opens the wizard even when setup is already complete", async () => {
  handlers["GET /api/settings"] = reply(200, { setupComplete: true });
  window.history.replaceState(null, "", "/dashboard/onboarding?rerun=1");
  await act(async () => {
    root.render(<OnboardingWizard />);
  });
  await waitForText("getStarted");
  expect(replaceMock).not.toHaveBeenCalled();
});

it("without ?rerun=1 a completed setup still redirects to the dashboard", async () => {
  handlers["GET /api/settings"] = reply(200, { setupComplete: true });
  await act(async () => {
    root.render(<OnboardingWizard />);
  });
  await waitFor(() => replaceMock.mock.calls.length > 0, "redirect");
  expect(replaceMock).toHaveBeenCalledWith("/dashboard");
});

it("a failed provider save shows guidance; a network failure says the server is unreachable", async () => {
  handlers["POST /api/providers"] = reply(400, { error: "Invalid provider" });
  await reachProviderStep();
  await click("OpenAI");
  await typeInto('input[aria-label="apiKeyRequired"]', "sk-test-not-a-real-key");
  await click("addProvider");
  await waitForText("Invalid provider");
  expect(errorKinds()).toEqual(["invalidInput"]);

  handlers["POST /api/providers"] = () => {
    throw new TypeError("Failed to fetch");
  };
  await click("addProvider");
  await waitFor(() => errorKinds().includes("network"), "network guidance");
  expect(container.textContent).toContain("connectionError");
});
