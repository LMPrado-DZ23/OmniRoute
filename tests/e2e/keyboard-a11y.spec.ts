/**
 * tests/e2e/keyboard-a11y.spec.ts
 *
 * Keyboard operability of the main flows (Fase 9): sign-in without a mouse, a visible
 * focus indicator, the skip link as the first dashboard tab stop, and the sidebar
 * section headers operable with Enter/Space.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

const E2E_PASSWORD =
  process.env.OMNIROUTE_E2E_PASSWORD || process.env.INITIAL_PASSWORD || "omniroute-e2e-password";

async function focusRingOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle}|${style.boxShadow}`;
  });
}

function hasVisibleFocusRing(ring: string): boolean {
  const [outlineStyle, boxShadow] = ring.split("|");
  return (
    (outlineStyle !== "none" && outlineStyle !== "") || (boxShadow !== "none" && boxShadow !== "")
  );
}

async function pressTabUntil(page: Page, target: Locator, maxSteps = 15) {
  for (let step = 0; step < maxSteps; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test.describe("Keyboard operability", () => {
  test("login can be completed with the keyboard and shows a visible focus ring", async ({
    page,
  }) => {
    await page.goto("/login");
    const password = page.getByLabel(/password/i).first();
    const hasPasswordForm = await password
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasPasswordForm, "Instance is not configured with password login.");

    await password.focus();
    await page.keyboard.type(E2E_PASSWORD);

    const submit = page.locator("form").getByRole("button").first();
    await pressTabUntil(page, submit);
    expect(hasVisibleFocusRing(await focusRingOf(submit))).toBe(true);

    await Promise.all([page.waitForURL(/\/dashboard(\/.*)?$/), page.keyboard.press("Enter")]);
  });

  test("the skip link is the first tab stop on the dashboard", async ({ page }) => {
    // Desktop width so the persistent sidebar is displayed (the skip link itself lives in the
    // root layout and is the only one on the page — audit C L9).
    await page.setViewportSize({ width: 1280, height: 800 });
    // `/home` directly: `/dashboard` redirects there client-side, racing the helper's auth probe.
    await gotoDashboardRoute(page, "/home");
    // Load the landing page directly: `/dashboard` redirects client-side to `/home`, which
    // would destroy the page mid-test. A fresh load also resets the sequential-focus
    // starting point to the document start (clicking first would move it past the link).
    await page.goto("/home", { waitUntil: "load" });
    await page.waitForURL(/\/home(\?.*)?$/);
    await page.locator("#main-content").waitFor({ state: "visible" });

    await page.keyboard.press("Tab");
    const skipLink = page.locator('a[href="#main-content"]').first();
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()} ${el.getAttribute("href") ?? ""}`.trim() : "none";
    });
    await expect(skipLink, `first Tab focused: ${focused}`).toBeFocused();
    const box = await skipLink.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(1);
    // Exactly one skip link (the sidebar used to render a second one), and activating it
    // moves focus into <main>, not just the scroll position.
    await expect(page.locator('a[href="#main-content"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("the login page has a main landmark the skip link can reach", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/login", { waitUntil: "load" });
    test.skip(!page.url().includes("/login"), "Instance does not require login.");
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await expect(page.locator('a[href="#main-content"]')).toHaveCount(1);
  });

  test("sidebar section headers toggle with Enter and Space", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // `/home` directly: `/dashboard` redirects there client-side, racing the helper's auth probe.
    await gotoDashboardRoute(page, "/home");

    const header = page.locator("nav button[aria-expanded]").first();
    await expect(header).toBeVisible();

    // The Sidebar restores the persisted expansion state once after hydration, and nothing
    // in the DOM signals when that has happened: a key press that lands earlier is
    // overwritten. Read the state right before each press and retry until the flip sticks.
    const pressFlips = async (key: "Enter" | "Space") => {
      await expect(async () => {
        const before = await header.getAttribute("aria-expanded");
        await header.focus();
        await page.keyboard.press(key);
        await expect(header).toHaveAttribute(
          "aria-expanded",
          before === "true" ? "false" : "true",
          { timeout: 2_000 }
        );
      }).toPass({ timeout: 30_000 });
    };

    await pressFlips("Enter");
    await pressFlips("Space");
  });
});
