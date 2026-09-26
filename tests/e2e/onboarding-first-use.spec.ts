import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Phase 6 — first-use path through the onboarding wizard against the real app:
 * start → dashboard → authenticate → add provider → validate credential → choose model →
 * test request → copy client configuration → first request.
 *
 * Provider-side calls (create/test/list models/model test/call logs) are intercepted with
 * page.route: no real AI provider is ever contacted and no connection is persisted. The
 * settings/auth routes stay real, so the INITIAL_PASSWORD path that the Playwright server
 * runs with (scripts/dev/run-next-playwright.mjs, bootstrap mode "auth") is exercised for
 * real, including the one-time bootstrap fix (audit C-06).
 */

const CONNECTION = { id: "e2e-first-use-conn", provider: "openai", name: "OpenAI (e2e)" };
const OLDER_CONNECTION = { id: "e2e-older-conn", provider: "groq", name: "Older (e2e)" };
const MODEL = "gpt-4o-mini";
const E2E_PASSWORD =
  process.env.OMNIROUTE_E2E_PASSWORD || process.env.INITIAL_PASSWORD || "omniroute-e2e-password";

type Recorded = { method: string; path: string; body: unknown };

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function providerMocks(): Record<string, unknown> {
  return {
    "POST /api/providers": { status: 201, body: { connection: CONNECTION } },
    // An older connection is listed first: the wizard must test the one just added.
    "GET /api/providers": { status: 200, body: { connections: [OLDER_CONNECTION, CONNECTION] } },
    [`POST /api/providers/${CONNECTION.id}/test`]: { status: 200, body: { valid: true } },
    [`GET /api/providers/${CONNECTION.id}/models`]: {
      status: 200,
      body: { models: [{ id: MODEL }, { id: "gpt-4o" }] },
    },
    "POST /api/models/test": { status: 200, body: { status: "ok", latencyMs: 42 } },
    "GET /api/usage/call-logs": {
      status: 200,
      body: [
        {
          model: `${CONNECTION.provider}/${MODEL}`,
          status: 200,
          timestamp: new Date().toISOString(),
        },
      ],
    },
    // Only reached when the server runs without a password: never change the shared password.
    "POST /api/settings/require-login": { status: 200, body: { success: true } },
    "POST /api/auth/login": { status: 200, body: { success: true } },
  };
}

async function installProviderMocks(page: Page, recorded: Recorded[], overrides = {}) {
  const mocks: Record<string, unknown> = { ...providerMocks(), ...overrides };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const mock = mocks[key] as { status: number; body: unknown } | undefined;
    if (!mock) {
      await route.continue();
      return;
    }
    recorded.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    await fulfillJson(route, mock.body, mock.status);
  });
}

/** Step 3: sign in through the real login page when the server requires it. */
async function signIn(page: Page) {
  const state = (await (await page.request.get("/api/settings/require-login")).json()) as {
    authenticated?: boolean;
    requireLogin?: boolean;
    hasPassword?: boolean;
  };
  if (state.authenticated || state.requireLogin === false || !state.hasPassword) return;
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="password"]').first().fill(E2E_PASSWORD);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/login") && r.request().method() === "POST"
    ),
    page.locator("form").getByRole("button").first().click(),
  ]);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 300_000 });
}

async function openWizard(page: Page, recorded: Recorded[], overrides = {}) {
  // Authenticate first with the real auth routes (the Playwright server sets INITIAL_PASSWORD),
  // then intercept the provider-side calls and re-open the wizard.
  await signIn(page);
  await installProviderMocks(page, recorded, overrides);
  await page.goto("/dashboard/onboarding?rerun=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible({
    timeout: 120_000,
  });
}

async function passSecurityStep(page: Page) {
  const keep = page.getByRole("button", { name: "Keep current password" });
  if (await keep.isVisible()) {
    await expect(page.getByText(/A dashboard password is already set/)).toBeVisible();
    await expect(page.getByText("Skip password setup")).toHaveCount(0);
    await keep.click();
    return;
  }
  await page.getByLabel("Enter password").fill("e2e-first-use-password");
  await page.getByLabel("Confirm password").fill("e2e-first-use-password");
  await page.getByRole("button", { name: "Set Password" }).click();
}

async function reachTestStep(page: Page) {
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await passSecurityStep(page);
  await expect(page.getByText("Connect your first AI provider.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.getByLabel("API Key (required)").fill("sk-e2e-fake-key-not-real");
  await page.getByRole("button", { name: "Add your first provider" }).click();
  await expect(page.getByRole("button", { name: "Run Connection Test" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, `horizontal overflow at ${label}`).toBeLessThanOrEqual(1);
}

test.describe("Onboarding first use", () => {
  test("validate → choose model → test request → client config → first request", async ({
    page,
    context,
  }) => {
    const recorded: Recorded[] = [];
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openWizard(page, recorded);
    await reachTestStep(page);

    const created = recorded.find((r) => r.method === "POST" && r.path === "/api/providers");
    expect(created?.body).toMatchObject({ provider: "openai", apiKey: "sk-e2e-fake-key-not-real" });

    // 5. validate the credential of the connection just added
    await page.getByRole("button", { name: "Run Connection Test" }).click();
    await expect(page.getByText("Connection successful! Your provider is ready.")).toBeVisible();
    const tested = recorded.filter((r) => r.path.endsWith("/test") && r.method === "POST");
    expect(tested.map((r) => r.path)).toEqual([`/api/providers/${CONNECTION.id}/test`]);

    // 6. choose an available model, 7. run a test request
    await expect(page.getByRole("heading", { name: "Choose a model" })).toBeVisible();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue(MODEL);
    await page.getByRole("button", { name: "Send test request" }).click();
    await expect(page.getByText("The model answered in 42 ms.")).toBeVisible();
    expect(recorded.find((r) => r.path === "/api/models/test")?.body).toEqual({
      providerId: CONNECTION.provider,
      modelId: MODEL,
      connectionId: CONNECTION.id,
    });

    // 8. copy the client configuration
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Client configuration" })).toBeVisible();
    await expect(page.getByText(`${CONNECTION.provider}/${MODEL}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Copy configuration" }).click();
    await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // The OS clipboard may turn \n into \r\n (Windows).
    expect(clipboard).toMatch(/^Base URL: http:\/\/\S+\/api\/v1\r?\n/);
    expect(clipboard).toContain(`Model:    ${CONNECTION.provider}/${MODEL}`);

    // 9. see the first request
    await expect(page.getByTestId("first-request")).toContainText(
      `${CONNECTION.provider}/${MODEL}`
    );
    await expect(page.getByRole("link", { name: "Open request logs" })).toHaveAttribute(
      "href",
      "/dashboard/logs"
    );
    const guideHref = await page
      .getByRole("link", { name: "Guide: your first 10 minutes" })
      .getAttribute("href");
    expect(guideHref).toBe("/docs/getting-started/first_10_minutes");
    const guide = await page.request.get(guideHref as string);
    expect(guide.status(), "the docs link must resolve").toBe(200);

    await page.getByRole("button", { name: /Go to Dashboard/ }).click();
    await page.waitForURL(/\/dashboard\/?$/);
  });

  test("a rejected credential explains why, how to fix, and links to the guide", async ({
    page,
  }) => {
    const recorded: Recorded[] = [];
    await openWizard(page, recorded, {
      [`POST /api/providers/${CONNECTION.id}/test`]: {
        status: 200,
        body: {
          valid: false,
          error: "Invalid API key provided",
          diagnosis: { type: "upstream_auth_error", code: "401", message: "Invalid API key" },
        },
      },
    });
    await reachTestStep(page);
    await page.getByRole("button", { name: "Run Connection Test" }).click();

    const callout = page.getByTestId("actionable-error");
    await expect(callout).toHaveAttribute("data-error-kind", "credential");
    await expect(callout.getByRole("alert")).toHaveText("Invalid API key provided");
    await expect(callout).toContainText("The provider rejected the credential");
    await expect(callout).toContainText("Create or copy a valid key");
    await expect(callout).toContainText("Trying again will not help");
    await expect(callout.getByRole("link", { name: "Open the guide" })).toHaveAttribute(
      "href",
      "/docs/getting-started/providers-guide"
    );
    await expect(callout.getByRole("button", { name: "Retry" })).toBeVisible();
    await callout.getByRole("button", { name: "Back to provider" }).click();
    await expect(page.getByRole("button", { name: "Add your first provider" })).toBeVisible();
  });

  test("INITIAL_PASSWORD bootstrap is one-time: setupComplete=false reopens the wizard", async ({
    page,
  }) => {
    await signIn(page);
    try {
      const patch = await page.request.patch("/api/settings", { data: { setupComplete: false } });
      expect(patch.ok(), `PATCH /api/settings -> ${patch.status()}`).toBeTruthy();
      const settings = (await (await page.request.get("/api/settings")).json()) as {
        setupComplete?: boolean;
      };
      expect(settings.setupComplete, "not re-forced on the next read").toBe(false);

      // The first navigation can be interrupted by a redirect to /home (run 36234258639: "Navigation to
      // /dashboard/onboarding is interrupted by another navigation to /home") when the settings the
      // redirect reads have not caught up with the PATCH yet; a second attempt lands on the wizard.
      // Retry the navigation together with its check instead of failing on the first race.
      await expect(async () => {
        await page.goto("/dashboard/onboarding", { waitUntil: "domcontentloaded" }).catch(() => {});
        await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible({
          timeout: 10_000,
        });
      }).toPass({ timeout: 120_000 });
      await page.getByRole("button", { name: "Skip wizard entirely" }).click();
      await page.waitForURL(/\/dashboard\/?$/);
      const after = (await (await page.request.get("/api/settings")).json()) as {
        setupComplete?: boolean;
      };
      expect(after.setupComplete).toBe(true);
    } finally {
      await page.request.patch("/api/settings", { data: { setupComplete: true } });
    }
  });

  test("the wizard never scrolls horizontally at 375/768/900/1024 px", async ({ page }) => {
    const recorded: Recorded[] = [];
    for (const width of [375, 768, 900, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await openWizard(page, recorded);
      await expectNoHorizontalOverflow(page, `${width}px welcome`);
      await reachTestStep(page);
      await expectNoHorizontalOverflow(page, `${width}px test`);
      await page.getByRole("button", { name: "Run Connection Test" }).click();
      await expect(page.getByRole("heading", { name: "Choose a model" })).toBeVisible();
      await expectNoHorizontalOverflow(page, `${width}px model`);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "Client configuration" })).toBeVisible();
      await expectNoHorizontalOverflow(page, `${width}px done`);
    }
  });
});
