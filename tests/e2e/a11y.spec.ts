/**
 * tests/e2e/a11y.spec.ts
 *
 * Accessibility gate using @axe-core/playwright (Task 13 — Fase 7, hardened in Fase 9).
 *
 * NIGHTLY: this suite is scheduled in the NIGHTLY CI job, not in the per-PR job,
 * because axe analysis adds ~10–20 s per page × width (see REQUIRE_AXE below).
 *
 * Two assertions per audited page:
 *   1. ZERO `critical` or `serious` violations at every responsive width in
 *      A11Y_WIDTHS (768 / 900 / 1024 / 1280 / 1440). A single blocking violation fails.
 *   2. Ratchet on the TOTAL violation count (any impact) at the 1280px desktop
 *      viewport: the count may never exceed VIOLATION_BASELINES. Lower the baseline
 *      whenever a violation is fixed; never raise it.
 *
 * Violations are fixed at the source, never silenced with `disableRules`.
 *
 * Graceful degradation:
 *   - If @axe-core/playwright is not installed the suite is skipped with a clear
 *     message instead of crashing the job (the meta-test fails when REQUIRE_AXE=1).
 *
 * Pages audited:
 *   /login                — public auth gate
 *   /dashboard            — main overview
 *   /dashboard/providers  — provider management (most complex UI surface)
 *   /dashboard/settings   — settings (ratchet only, default viewport)
 *
 * Run locally (requires the app running on the Playwright baseURL):
 *   REQUIRE_AXE=1 npx playwright test tests/e2e/a11y.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
// Type-only: erased at runtime, so the graceful skip below still works without the package.
import type AxeBuilderClass from "@axe-core/playwright";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";
import { VIEWPORTS } from "./responsiveSpecs";

// ---------------------------------------------------------------------------
// Conditional import — skip entire suite if @axe-core/playwright is absent.
// ---------------------------------------------------------------------------

type AxeResults = Awaited<ReturnType<AxeBuilderClass["analyze"]>>;
type AxeViolation = AxeResults["violations"][number];

let AxeBuilder: typeof AxeBuilderClass | null = null;

try {
  // Dynamic import so the module parse does not fail when the package is absent.
  const mod = await import("@axe-core/playwright");
  AxeBuilder = mod.default ?? null;
} catch {
  // Package not installed — suite will skip gracefully below.
  AxeBuilder = null;
}

// ---------------------------------------------------------------------------
// Frozen total-violation baselines (any impact) at the 1280px desktop viewport.
// Values can only go DOWN. Critical/serious are asserted to be zero separately.
// ---------------------------------------------------------------------------

// Phase 9 (2026-09-14): /login, /dashboard and /dashboard/providers measured 0 violations
// of any impact at 375/768/900/1024/1280/1440px (were 1 / 4 / 3). /dashboard/settings was
// not re-measured in that run and keeps its previous frozen value.
const VIOLATION_BASELINES: Record<string, number> = {
  "/login": 0,
  "/dashboard": 0,
  "/dashboard/providers": 0,
  "/dashboard/settings": 5,
};

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);
const RATCHET_WIDTH = VIEWPORTS.desktop.width;
const A11Y_VIEWPORTS = [
  VIEWPORTS.tablet,
  VIEWPORTS.smallLaptop,
  VIEWPORTS.laptop,
  VIEWPORTS.desktop,
  VIEWPORTS.wide,
];
// Each width reloads the page and runs a full axe pass.
const WIDTH_SWEEP_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipUnlessAxeRequired() {
  // Nightly-only: the real axe analysis runs in the nightly job (REQUIRE_AXE=1), NOT in
  // the per-PR e2e shards — a11y.spec.ts is matched by the per-PR `tests/e2e/*.spec.ts`
  // glob, so without this gate installing the package would flip axe on for every PR.
  test.skip(
    !AxeBuilder || process.env.REQUIRE_AXE !== "1",
    AxeBuilder
      ? "axe analysis runs in the nightly job only (set REQUIRE_AXE=1)"
      : "@axe-core/playwright not installed"
  );
}

async function runAxe(page: Page, label: string): Promise<AxeViolation[]> {
  if (!AxeBuilder) {
    throw new Error("@axe-core/playwright not available");
  }
  const builder = new AxeBuilder({ page });
  builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // Exclude third-party iframes / injected widgets that we don't control.
  builder.exclude("[data-axe-exclude]");
  const results = await builder.analyze();

  // Emit machine-parseable line for CI baseline tracking.
  console.log(`axeViolationCount page=${label} count=${results.violations.length}`);
  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) => `  [${v.impact ?? "unknown"}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`
      )
      .join("\n");
    console.log(`axeViolations page=${label}:\n${summary}`);
  }
  return results.violations;
}

function describeBlocking(violations: AxeViolation[]): string[] {
  return violations
    .filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""))
    .map((v) => {
      const targets = v.nodes
        .slice(0, 3)
        .map((node) => JSON.stringify(node.target))
        .join(", ");
      return `[${v.impact}] ${v.id} (${v.nodes.length} nodes: ${targets})`;
    });
}

async function openPage(page: Page, path: string) {
  if (path === "/login") {
    await page.goto(path);
    await page.locator('input[type="password"]').first().waitFor({ state: "visible" });
    return;
  }
  await gotoDashboardRoute(page, path);
  await page.locator("main, #main-content").first().waitFor({ state: "visible" });
}

/**
 * Audits `path` at every responsive width: zero critical/serious violations at each
 * width, and the total count at the desktop width may not exceed the frozen baseline.
 */
async function auditAcrossWidths(page: Page, path: string) {
  const blockingByWidth: string[] = [];
  let ratchetCount: number | null = null;

  for (const viewport of A11Y_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openPage(page, path);
    const violations = await runAxe(page, `${path}@${viewport.width}`);
    for (const line of describeBlocking(violations)) {
      blockingByWidth.push(`${viewport.width}px ${line}`);
    }
    if (viewport.width === RATCHET_WIDTH) ratchetCount = violations.length;
  }

  expect(blockingByWidth, `Critical/serious a11y violations on ${path}`).toEqual([]);
  const baseline = VIOLATION_BASELINES[path] ?? 0;
  expect(ratchetCount, `axe did not run at ${RATCHET_WIDTH}px on ${path}`).not.toBeNull();
  expect(ratchetCount ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(baseline);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("A11y — Dashboard key surfaces (@axe-core, nightly)", () => {
  test.beforeAll(() => {
    if (!AxeBuilder) {
      console.log(
        "[a11y.spec.ts] SKIP: @axe-core/playwright is not installed.\n" +
          "Install with: npm install --save-dev @axe-core/playwright"
      );
    }
  });

  for (const path of ["/login", "/dashboard", "/dashboard/providers"]) {
    test(`${path} — zero critical/serious violations at 768–1440px and total within baseline`, async ({
      page,
    }) => {
      skipUnlessAxeRequired();
      test.setTimeout(WIDTH_SWEEP_TIMEOUT_MS);
      await auditAcrossWidths(page, path);
    });
  }

  test("/dashboard/settings — axe violations must not exceed baseline", async ({ page }) => {
    skipUnlessAxeRequired();

    // The settings route redirects to /dashboard/settings/general; follow it.
    await gotoDashboardRoute(page, "/dashboard/settings");

    const violations = await runAxe(page, "/dashboard/settings");
    const baseline = VIOLATION_BASELINES["/dashboard/settings"] ?? 0;

    expect(violations.length).toBeLessThanOrEqual(baseline);
  });

  // -------------------------------------------------------------------------
  // Regression guard: suite is skippable but the skip reason must be explicit.
  // This test always runs (no AxeBuilder check) and verifies the skip is
  // legitimate (package absent) and not an infrastructure failure.
  // -------------------------------------------------------------------------
  test("axe package availability is declared (meta-test)", async () => {
    if (AxeBuilder !== null) {
      expect(AxeBuilder).toBeTruthy();
      return;
    }
    if (process.env.REQUIRE_AXE === "1") {
      throw new Error(
        "REQUIRE_AXE=1 but @axe-core/playwright is not installed. " +
          "Add it as a devDependency and run npm install."
      );
    }
    test.skip(true, "@axe-core/playwright not installed — advisory skip in PR context");
  });
});
