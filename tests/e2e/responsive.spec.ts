import { test, expect, type Page } from "@playwright/test";

import { gotoDashboardRoute } from "./helpers/dashboardAuth";
import { A11Y_CHECKS, generateTestMatrix, PAGES } from "./responsiveSpecs";

const executableChecks = A11Y_CHECKS.filter((check) => check.kind === "evaluate");

async function waitForSettledPage(page: Page, requiresAuth: boolean) {
  await page.waitForLoadState("load");
  await page.locator(requiresAuth ? "#main-content" : "body").waitFor({ state: "visible" });
}

function isContextDestroyed(error: unknown): boolean {
  return String(error).includes("Execution context was destroyed");
}

async function openResponsivePage(page: Page, pageSpec: (typeof PAGES)[number]) {
  if (!pageSpec.requiresAuth) {
    await page.goto(pageSpec.path);
  } else {
    try {
      await gotoDashboardRoute(page, pageSpec.path);
    } catch (error) {
      // The `/dashboard` -> `/home` client redirect can land while the shared helper is
      // evaluating its auth probe. The session is already established at that point.
      if (!isContextDestroyed(error)) throw error;
    }
  }
  await waitForSettledPage(page, pageSpec.requiresAuth);
}

/**
 * `/dashboard` redirects client-side (to `/home`) after load, which can destroy the
 * execution context mid-evaluate. Retry once after the new page settles.
 */
async function evaluateOnSettledPage<T>(
  page: Page,
  pageSpec: (typeof PAGES)[number],
  fn: () => T
): Promise<T> {
  try {
    return await page.evaluate(fn);
  } catch (error) {
    if (!isContextDestroyed(error)) throw error;
    await waitForSettledPage(page, pageSpec.requiresAuth);
    return await page.evaluate(fn);
  }
}

test.describe("Responsive matrix", () => {
  for (const { viewport, page: pageSpec, testName } of generateTestMatrix()) {
    test(`${testName} has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openResponsivePage(page, pageSpec);

      for (const check of executableChecks) {
        if (!check.evaluate) continue;
        const offenders = await evaluateOnSettledPage(page, pageSpec, check.evaluate);
        expect(offenders, check.criteria).toEqual([]);
      }
    });
  }
});
