// @vitest-environment jsdom
/**
 * The onboarding tier diagram served the LIGHT asset in dark mode, and told screen
 * readers a different number than the image showed.
 *
 * Two defects in one small component, both found by the product audit:
 *
 *   1. It picked its src from `next-themes`' `resolvedTheme` — the only `next-themes`
 *      import in the whole `src/` tree, with no `ThemeProvider` from that library
 *      anywhere. `resolvedTheme` was always `undefined`, so the ternary always chose
 *      light: a white card in a dark UI, while `tier-flow-dark.svg` shipped unused.
 *   2. `tierFlowDiagramAlt` said "3-tier" in all 42 locales while both SVGs read
 *      "4-tier fallback: Tier 1 Subscription, Tier 2 API, Tier 3 Cheap, Tier 4 Free" —
 *      so a screen-reader user was given a different count than a sighted one.
 *
 * The theme now comes from a `dark:` CSS variant, which reads the `dark` class the app's
 * own zustand store puts on `<html>` and cannot drift from it.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ALT = "OmniRoute 4-tier fallback diagram";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({ tierFlowDiagramAlt: ALT, flowCaption: "caption" })[key] ?? key,
}));

vi.mock("next/image", () => ({
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- this IS the next/image stub;
    // the rule's advice (use next/image) is what the component under test already does.
    <img src={src} alt={alt} className={className} />
  ),
}));

const { TierFlowDiagram } =
  await import("@/app/(dashboard)/dashboard/onboarding/components/TierFlowDiagram");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  root = createRoot(container);
  act(() => {
    root.render(<TierFlowDiagram />);
  });
  return [...container.querySelectorAll("img")];
}

test("both theme assets are rendered, each gated by a dark: variant", () => {
  const images = render();

  const light = images.find((i) => i.getAttribute("src")?.includes("tier-flow-light.svg"));
  const dark = images.find((i) => i.getAttribute("src")?.includes("tier-flow-dark.svg"));

  expect(light, "the light asset must be present").toBeTruthy();
  expect(dark, "the dark asset shipped and was never served").toBeTruthy();

  expect(light?.className).toContain("dark:hidden");
  expect(dark?.className).toContain("dark:block");
  expect(dark?.className).toContain("hidden");
});

test("the component does not resolve the theme in JavaScript", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "src/app/(dashboard)/dashboard/onboarding/components/TierFlowDiagram.tsx"
    ),
    "utf8"
  );

  // The docstring names the library to explain the history, so match the IMPORT,
  // not the word.
  expect(
    /from\s+["']next-themes["']/.test(source),
    "next-themes has no provider in this app; resolvedTheme is always undefined"
  ).toBe(false);
  // …and nothing reads a JS-resolved theme value either. Matching a call/property
  // access rather than the bare word, which the docstring above also uses.
  expect(
    /\bresolvedTheme\s*[=.)]|useTheme\s*\(/.test(source),
    "nothing should be resolving the theme in JS here"
  ).toBe(false);
});

test("every locale's alt text agrees with the four tiers the SVG draws", () => {
  const svg = fs.readFileSync(
    path.join(process.cwd(), "public/images/tier-flow-light.svg"),
    "utf8"
  );
  expect(svg, "the image itself must still describe four tiers").toContain("4-tier fallback");

  const dir = path.join(process.cwd(), "src/i18n/messages");
  const wrong: string[] = [];

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const messages = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const alt: string | undefined = messages?.onboarding?.tierFlowDiagramAlt;
    if (alt === undefined) continue;
    // Either the digit, or the spelled-out numeral the three locales that write it use.
    if (!/4|رباعي|Čtyř|Четырех/.test(alt)) wrong.push(`${file}: ${alt}`);
  }

  expect(
    wrong,
    "a screen reader must not be told a different tier count than the image shows"
  ).toEqual([]);
});
