import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The primary button paints `--color-on-primary` directly on `--grad-brand`. axe reports a
// gradient backdrop as `incomplete` rather than as a violation, so the production scan
// (axe-core 4.13.0) never measured it and the light theme shipped at 3.96:1 on the violet
// end — under AA for normal text. Nothing else measures this, so this test does.

const css = readFileSync(new URL("../../../src/app/globals.css", import.meta.url), "utf8");

/** WCAG 2.x relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a `--token: #rrggbb;` declaration out of a block of the stylesheet. */
function token(block: string, name: string): string {
  // Line-based rather than one RegExp over the block: a `\s` inside a template literal is
  // just `s`, which silently turns this into a pattern that never matches.
  const line = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(`--${name}:`));
  assert.ok(line, `--${name} must be declared in this block`);
  const m = /#[0-9a-fA-F]{6}/.exec(line as string);
  assert.ok(m, `--${name} must be a literal hex in this block, got: ${line}`);
  return m[0].toLowerCase();
}

const lightBlock = css.slice(0, css.indexOf(".dark {"));
const darkBlock = css.slice(css.indexOf(".dark {"));

/** Sample the sRGB interpolation of a two-stop gradient. */
function stops(from: string, to: string, steps = 20): string[] {
  const parse = (h: string) => {
    const n = Number.parseInt(h.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [a, b] = [parse(from), parse(to)];
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
    return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  });
}

test("light theme: text on the primary button clears AA at EVERY point of the gradient", () => {
  const onPrimary = token(lightBlock, "color-on-primary");
  const from = token(lightBlock, "color-primary");
  const to = token(lightBlock, "color-accent-on-primary");

  for (const stop of stops(from, to)) {
    const ratio = contrast(onPrimary, stop);
    assert.ok(
      ratio >= 4.5,
      `${onPrimary} on ${stop} is ${ratio.toFixed(2)}:1 — under AA (4.5:1) for normal text`
    );
  }
});

test("the brand accent itself is NOT what was changed", () => {
  // The fix darkens the END OF THE GRADIENT, not the brand colour. If someone later points
  // --color-accent-on-primary back at --color-accent-light in the light theme, the first
  // test catches it — this one records why the two tokens are separate at all.
  const accent = token(lightBlock, "color-accent-light");
  const onPrimary = token(lightBlock, "color-on-primary");
  const ratio = contrast(onPrimary, accent);
  assert.ok(
    ratio < 4.5,
    `the brand accent ${accent} now measures ${ratio.toFixed(2)}:1 against ${onPrimary}; ` +
      `if it genuinely clears AA, --color-accent-on-primary is no longer needed`
  );
});

test("dark theme keeps the undarkened accent, and still clears AA", () => {
  // Dark writes BLACK on the gradient, which the brand violet already clears — so it must
  // not inherit the light theme's darkened shade, and this proves it does not need to.
  assert.match(
    darkBlock,
    /--color-accent-on-primary:\s*var\(--color-accent-light\)/,
    "the dark theme must keep the brand accent"
  );
  const onPrimary = token(darkBlock, "color-on-primary");
  const from = token(darkBlock, "color-primary");
  const to = token(lightBlock, "color-accent-light");
  for (const stop of stops(from, to)) {
    const ratio = contrast(onPrimary, stop);
    assert.ok(ratio >= 4.5, `dark: ${onPrimary} on ${stop} is ${ratio.toFixed(2)}:1`);
  }
});

test("--grad-brand is what the primary button actually paints", () => {
  // The measurement above is only meaningful if the button still uses this token.
  const button = readFileSync(
    new URL("../../../src/shared/components/Button.tsx", import.meta.url),
    "utf8"
  );
  assert.match(button, /primary:[^\n]*var\(--grad-brand\)/);
  assert.match(button, /primary:[^\n]*text-on-primary/);
  // `.includes` on the one line, not a match over the whole file: `[^)]*` cannot cross
  // the `)` of `var(--color-primary)`, and a failed match here dumps 20k of stylesheet.
  const gradient = css
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("--grad-brand:"));
  assert.ok(gradient?.includes("--color-accent-on-primary"), `--grad-brand is: ${gradient}`);
});
