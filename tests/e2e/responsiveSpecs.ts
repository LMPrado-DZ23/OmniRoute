/**
 * Responsive Test Specs — T-39
 *
 * Test specifications for Playwright responsive testing.
 * These define the viewports and pages to test.
 *
 * Usage with Playwright:
 *   import { VIEWPORTS, PAGES, generateTestMatrix } from "./responsiveSpecs";
 *
 * @module tests/e2e/responsiveSpecs
 */

/**
 * Viewport definitions for responsive testing.
 */
export const VIEWPORTS = {
  mobile: { width: 375, height: 812, label: "Mobile (375px)" },
  tablet: { width: 768, height: 1024, label: "Tablet (768px)" },
  // 900/1024 sit below the `lg` (1024px) sidebar breakpoint and above `md`: the band
  // where the header and wizard cards used to overflow (audit C-09).
  smallLaptop: { width: 900, height: 800, label: "Small laptop (900px)" },
  laptop: { width: 1024, height: 768, label: "Laptop (1024px)" },
  desktop: { width: 1280, height: 800, label: "Desktop (1280px)" },
  wide: { width: 1440, height: 900, label: "Wide (1440px)" },
};

/**
 * Pages to test with responsive viewports.
 */
export const PAGES = [
  { path: "/login", name: "Login", requiresAuth: false },
  { path: "/dashboard", name: "Dashboard", requiresAuth: true },
  { path: "/dashboard/providers", name: "Providers", requiresAuth: true },
  { path: "/dashboard/settings", name: "Settings", requiresAuth: true },
];

/**
 * Accessibility checks to perform on each page.
 */
export const A11Y_CHECKS = [
  {
    id: "overflow-x",
    kind: "evaluate",
    // Returns the offending elements ([] = pass). The dashboard shell clips horizontal
    // overflow (`overflow-hidden` / `overflow-x-hidden`), so `body.scrollWidth` alone never
    // grows there: content is cut off instead. Any visible, non-fixed element crossing the
    // viewport edge counts unless it sits inside a real horizontal scroller.
    evaluate: () => {
      const viewportWidth = document.documentElement.clientWidth;
      const offenders: string[] = [];
      if (document.documentElement.scrollWidth > viewportWidth) {
        offenders.push(`document scrollWidth=${document.documentElement.scrollWidth}`);
      }
      const insideHorizontalScroller = (element: Element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
        }
        return false;
      };
      for (const element of document.querySelectorAll("body *")) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const crossesEdge =
          rect.width > 0 && rect.left < viewportWidth && rect.right > viewportWidth + 1;
        if (!crossesEdge || style.position === "fixed" || style.visibility === "hidden") continue;
        if (insideHorizontalScroller(element)) continue;
        offenders.push(`${element.tagName.toLowerCase()} right=${Math.round(rect.right)}`);
        if (offenders.length >= 5) break;
      }
      return offenders;
    },
    criteria: "No element crosses the right viewport edge outside a horizontal scroller",
    description: "No horizontal overflow",
  },
  {
    id: "touch-targets",
    kind: "manual",
    criteria: "Minimum 44px touch targets on mobile",
    description: "Touch targets ≥ 44px",
  },
  {
    id: "font-size",
    kind: "manual",
    criteria: "Minimum 16px base font on mobile",
    description: "Base font ≥ 16px",
  },
  {
    id: "viewport-meta",
    kind: "manual",
    criteria: "Viewport meta tag is present",
    description: "Viewport meta present",
  },
];

/**
 * Generate test matrix (viewport × page combinations).
 *
 * @returns {Array<{ viewport: typeof VIEWPORTS.mobile, page: typeof PAGES[0], testName: string }>}
 */
export function generateTestMatrix() {
  const matrix = [];

  for (const [vpKey, viewport] of Object.entries(VIEWPORTS)) {
    for (const page of PAGES) {
      matrix.push({
        viewport,
        page,
        testName: `${page.name} @ ${viewport.label}`,
      });
    }
  }

  return matrix;
}

/**
 * Get viewport names.
 * @returns {string[]}
 */
export function getViewportNames() {
  return Object.keys(VIEWPORTS);
}
