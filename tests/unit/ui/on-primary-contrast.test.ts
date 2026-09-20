import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getContrastRatio } from "../../../src/shared/utils/a11yAudit.ts";

// Static guards for text on SOLID brand-primary surfaces (buttons, active pills, badges).
// The dark theme shipped #ffffff on #e54d5e (3.78:1, under WCAG AA 4.5:1); the fix keeps
// the brand fill and routes the foreground through the theme-aware --color-on-primary token.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const globalsCss = fs.readFileSync(path.join(repoRoot, "src/app/globals.css"), "utf8");

/** The top-level `selector { ... }` block that defines the palette (has --color-primary). */
function block(selector: string): string {
  let start = globalsCss.indexOf(`\n${selector} {`);
  while (start >= 0) {
    const body = globalsCss.slice(start, globalsCss.indexOf("\n}", start));
    if (body.includes("--color-primary:")) return body;
    start = globalsCss.indexOf(`\n${selector} {`, start + 1);
  }
  assert.fail(`no ${selector} block defines --color-primary`);
}

function token(css: string, name: string): string {
  const match = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(css);
  assert.ok(match, `${name} is defined`);
  return match[1].trim();
}

function toHex(channels: number[]): string {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** Resolves `color-mix(in srgb, var(--color-primary) N%, #hex)` against `primary`. */
function resolve(value: string, primary: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const mix = /^color-mix\(in srgb, var\(--color-primary\) (\d+)%, (#[0-9a-f]{6})\)$/i.exec(value);
  assert.ok(mix, `unsupported token value: ${value}`);
  const weight = Number(mix[1]) / 100;
  const other = channels(mix[2]);
  return toHex(channels(primary).map((c, i) => c * weight + other[i] * (1 - weight)));
}

/** Composites `fill` at `alpha` over `backdrop` (Tailwind `bg-primary/90`). */
function over(fill: string, alpha: number, backdrop: string): string {
  const bg = channels(backdrop);
  return toHex(channels(fill).map((c, i) => c * alpha + bg[i] * (1 - alpha)));
}

const light = block(":root");
const dark = block(".dark");

test("the brand colour is unchanged: the dark theme still paints #e54d5e", () => {
  assert.equal(token(dark, "--color-primary"), "#e54d5e");
});

test("text on a primary surface meets AA in both themes, at rest and on hover", () => {
  for (const [theme, css] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    const primary = token(css, "--color-primary");
    const onPrimary = token(css, "--color-on-primary");
    const hover = resolve(token(css, "--color-primary-hover"), primary);
    const surfaces = [token(css, "--color-bg"), token(css, "--color-card")];

    assert.ok(getContrastRatio(onPrimary, primary) >= 4.5, `${theme}: on-primary at rest`);
    assert.ok(getContrastRatio(onPrimary, hover) >= 4.5, `${theme}: on-primary on hover shade`);
    for (const surface of surfaces) {
      const faded = over(primary, 0.9, surface);
      assert.ok(
        getContrastRatio(onPrimary, faded) >= 4.5,
        `${theme}: on-primary over bg-primary/90 on ${surface} (${faded})`
      );
    }
  }
});

test("each theme's primary-tint text falls back to its own preset override", () => {
  assert.match(
    light,
    /--color-primary-on-tint: var\(\s*--preset-primary-on-tint-light,\s*color-mix\(in srgb, var\(--color-primary\) 80%, #000000\)\s*\);/
  );
  assert.match(
    dark,
    /--color-primary-on-tint: var\(\s*--preset-primary-on-tint-dark,\s*color-mix\(in srgb, var\(--color-primary\) 80%, #ffffff\)\s*\);/
  );
});

test("--color-on-primary is exposed to Tailwind (text-on-primary, text-primary-foreground)", () => {
  assert.match(globalsCss, /@theme inline \{[\s\S]*--color-on-primary: var\(--color-on-primary\);/);
  assert.match(globalsCss, /--color-primary-foreground: var\(--color-on-primary\);/);
});

test("no call site paints text-white on a solid bg-primary surface", () => {
  // `git grep -l` narrows the scan to files that mention text-white at all; exit code 1
  // (no match anywhere) is a pass, not an error.
  let listing = "";
  try {
    listing = execFileSync("git", ["grep", "-l", "text-white", "--", "src"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (status !== 1) throw error;
  }
  const files = listing.split("\n").filter((file) => /\.(tsx|ts|jsx)$/.test(file));
  const solidPrimary = /(^|[\s"'`:])(bg-primary|from-primary)(?![\w/-])/;
  const white = /(^|[\s"'`])text-white(?![\w-])/;
  const offenders: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(repoRoot, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (solidPrimary.test(line) && white.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use text-on-primary on brand-primary surfaces");
});

test("the axe e2e gate audits the dark theme as well as the light one", () => {
  const spec = fs.readFileSync(path.join(repoRoot, "tests/e2e/a11y.spec.ts"), "utf8");
  assert.match(spec, /const THEMES = \["light", "dark"\] as const;/);
  assert.match(spec, /for \(const theme of THEMES\)/);
  assert.match(spec, /await auditAcrossWidths\(page, path, theme\);/);
});
