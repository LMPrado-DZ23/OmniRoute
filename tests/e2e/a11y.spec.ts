/**
 * tests/e2e/a11y.spec.ts
 *
 * Accessibility gate using @axe-core/playwright (Task 13 — Fase 7, hardened in Fase 9).
 *
 * NIGHTLY: this suite is scheduled in the NIGHTLY CI job, not in the per-PR job,
 * because axe analysis adds ~10–20 s per page × width (see REQUIRE_AXE below).
 *
 * Two assertions per audited page, in BOTH themes (light and dark):
 *   1. ZERO `critical` or `serious` violations at every responsive width in
 *      A11Y_WIDTHS (768 / 900 / 1024 / 1280 / 1440). A single blocking violation fails.
 *   2. Ratchet on the TOTAL violation count (any impact) at the 1280px desktop
 *      viewport: the count may never exceed VIOLATION_BASELINES. Lower the baseline
 *      whenever a violation is fixed; never raise it. The baselines hold for both themes.
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
 *   /dashboard/analytics?tab=route-trace — Route Trace tab (routing decision lookup card)
 *   /dashboard/settings   — settings (width sweep + ratchet)
 *   /dashboard/logs       — request log viewer (filter selects + status pills)
 *   /dashboard/onboarding?rerun=1 — the first-run wizard a brand-new user lands on
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
// Final audit follow-up (2026-09-18): /dashboard/settings (→ /general) measured 0 violations
// at 375/768/900/1024/1280/1440px after fixing color-contrast (success Badge, danger Button,
// integrity text) and the unlabelled storage inputs/selects (was 5 frozen; 3 measured).
// Final audit C M3 (2026-09-18): the Route Trace tab had one critical `select-name`
// violation (unlabelled "Request log" select) at every width; fixed at the source.
// Final audit NEW-MEDIUM-1/-6 (2026-09-19): /dashboard/logs was never in this list, so the
// gate never saw its five unlabelled filter selects (critical `select-name` x4) or its
// status/column pills (`color-contrast`, 4.44:1 x14). Both fixed at the source; the page
// is gated from now on. NEW-MEDIUM-4: the first-run onboarding wizard is a new surface in
// this release and was equally ungated — its amber/red/green copy used dark-theme-only
// literals that measured as low as 1.72:1 on the light card.
const ROUTE_TRACE_PATH = "/dashboard/analytics?tab=route-trace";
const LOGS_PATH = "/dashboard/logs";
// `?rerun=1` reopens the wizard after setup completed — the only way to reach the
// first-run surface on an already-configured instance.
const ONBOARDING_PATH = "/dashboard/onboarding?rerun=1";
const VIOLATION_BASELINES: Record<string, number> = {
  "/login": 0,
  "/dashboard": 0,
  "/dashboard/providers": 0,
  [ROUTE_TRACE_PATH]: 0,
  "/dashboard/settings": 0,
  [LOGS_PATH]: 0,
  [ONBOARDING_PATH]: 0,
};

// Dark-theme audit (2026-09-19): until now every page was audited in the LIGHT theme only
// (a fresh Playwright context has no persisted theme and prefers light), so the dark
// theme's white-on-brand-primary text (#ffffff on #e54d5e = 3.78:1) shipped unseen on
// /dashboard/providers, /dashboard/logs and the onboarding wizard. Every page now runs in
// both themes against the same zero baselines.
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
// Must match THEME_CONFIG.storageKey (src/shared/constants/appConfig.ts) — the zustand
// persist key the theme store rehydrates from on first paint.
const THEME_STORAGE_KEY = "theme";

// Surfaces added in 3.8.55.
const CLI_CODE_PATH = "/dashboard/cli-code";
const WORKSPACES_PATH = "/dashboard/costs/workspaces";

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);
const RATCHET_WIDTH = VIEWPORTS.desktop.width;
const A11Y_VIEWPORTS = [
  // 375 was never swept, so nothing the dashboard does only at phone width was ever
  // audited. The 3.8.55 audit found `select-name` violations that reproduce here.
  VIEWPORTS.mobile,
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

/**
 * Pins the theme for every document the page loads: the persisted theme store plus the
 * matching `prefers-color-scheme`, so neither a stale preference nor the OS setting can
 * silently turn a dark audit into a light one.
 */
async function pinTheme(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ state: { theme: value, colorTheme: "coral" }, version: 0 })
        );
      } catch {
        // Storage unavailable — prefers-color-scheme above still selects the theme.
      }
    },
    { key: THEME_STORAGE_KEY, value: theme }
  );
}

/** Waits until the theme store has applied `theme` to <html> (it runs after hydration). */
async function waitForTheme(page: Page, theme: Theme) {
  await page.waitForFunction(
    (isDark) => document.documentElement.classList.contains("dark") === isDark,
    theme === "dark"
  );
}

async function openPage(page: Page, path: string) {
  if (path === "/login") {
    await page.goto(path);
    await page.locator('input[type="password"]').first().waitFor({ state: "visible" });
    return;
  }
  if (path === ONBOARDING_PATH) {
    // gotoDashboardRoute() clicks "skip wizard" whenever it lands on the onboarding
    // route, so authenticate on an ordinary route first and open the wizard directly.
    await gotoDashboardRoute(page, "/dashboard");
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /get started/i }).waitFor({ state: "visible" });
    return;
  }
  await gotoDashboardRoute(page, path);
  await page.locator("main, #main-content").first().waitFor({ state: "visible" });
}

/**
 * Audits `path` at every responsive width: zero critical/serious violations at each
 * width, and the total count at the desktop width may not exceed the frozen baseline.
 */
async function auditAcrossWidths(page: Page, path: string, theme: Theme) {
  const blockingByWidth: string[] = [];
  let ratchetCount: number | null = null;

  await pinTheme(page, theme);
  for (const viewport of A11Y_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openPage(page, path);
    await waitForTheme(page, theme);
    const violations = await runAxe(page, `${path}@${viewport.width}[${theme}]`);
    for (const line of describeBlocking(violations)) {
      blockingByWidth.push(`${viewport.width}px ${line}`);
    }
    if (viewport.width === RATCHET_WIDTH) ratchetCount = violations.length;
  }

  expect(blockingByWidth, `Critical/serious a11y violations on ${path} (${theme})`).toEqual([]);
  const baseline = VIOLATION_BASELINES[path] ?? 0;
  expect(
    ratchetCount,
    `axe did not run at ${RATCHET_WIDTH}px on ${path} (${theme})`
  ).not.toBeNull();
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

  for (const path of [
    "/login",
    "/dashboard",
    "/dashboard/providers",
    "/dashboard/settings",
    ROUTE_TRACE_PATH,
    LOGS_PATH,
    ONBOARDING_PATH,
    // Added in 3.8.55. Neither was audited when it shipped, and /dashboard/cli-code
    // went out with two axe-critical `select-name` nodes and two serious
    // `color-contrast` nodes in both themes — the gate's coverage was the defect.
    CLI_CODE_PATH,
    WORKSPACES_PATH,
  ]) {
    for (const theme of THEMES) {
      test(`${path} [${theme}] — zero critical/serious violations at 375–1440px and total within baseline`, async ({
        page,
      }) => {
        skipUnlessAxeRequired();
        test.setTimeout(WIDTH_SWEEP_TIMEOUT_MS);
        await auditAcrossWidths(page, path, theme);
      });
    }
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
