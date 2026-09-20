/**
 * A Material Symbols ligature is a glyph, not a label.
 *
 * The cli-code cards rendered 169 `<span className="material-symbols-outlined">` icons
 * and **not one** carried `aria-hidden`. The ligature text lands in the accessible name,
 * so the product audit read the copy controls as:
 *
 *   ["text:content_copy", "text:content_copy", "text:Select Model",
 *    "text:content_copyCopy", "text:content_copyCopy Config"]
 *
 * Two buttons whose entire accessible name is the string `content_copy`. No tool catches
 * it: axe's `button-name` rule **passes**, because there is text. The login page and
 * `ProviderKeySourceLink` already hide their icons, so this was an inconsistency rather
 * than house style.
 *
 * Hiding the glyph is only half the fix. A button that was announced badly becomes a
 * button announced as nothing, which axe *does* flag — so the icon-only copy buttons
 * carry an `aria-label`. Both halves are asserted here, because doing the first without
 * the second is a regression wearing a fix's clothes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(
  process.cwd(),
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "cli-code",
  "components"
);

const componentFiles = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

/** Opening `<span …>` tags whose className names the icon font. */
const ICON_SPAN =
  /<span\b(?<attrs>(?:[^<>]|\{[^{}]*\})*?className=(?:"[^"]*material-symbols-outlined[^"]*"|\{`[^`]*material-symbols-outlined[^`]*`\})(?:[^<>]|\{[^{}]*\})*?)>/gs;

/** A `<button …>` whose whole body is one icon span. */
const ICON_ONLY_BUTTON =
  /<button\b(?<attrs>(?:[^<>]|\{[^{}]*\})*?)>\s*<span[^>]*material-symbols-outlined[^>]*>\s*\{?[^<]*\}?\s*<\/span>\s*<\/button>/gs;

test("every decorative icon is hidden from the accessibility tree", () => {
  const exposed: string[] = [];
  let checked = 0;

  for (const file of componentFiles) {
    const source = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const match of source.matchAll(ICON_SPAN)) {
      checked += 1;
      if (!/aria-hidden/.test(match.groups?.attrs ?? "")) {
        exposed.push(`${file}: ${match[0].replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }

  assert.ok(
    checked > 100,
    `expected to find the cards' icon spans, found ${checked} — if the markup moved, ` +
      "point this test at it rather than letting it pass on an empty sweep"
  );
  assert.deepEqual(
    exposed,
    [],
    "an un-hidden ligature becomes part of the accessible name:\n" + exposed.join("\n")
  );
});

test("no icon-only button is left without a name", () => {
  const nameless: string[] = [];

  for (const file of componentFiles) {
    const source = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const match of source.matchAll(ICON_ONLY_BUTTON)) {
      const attrs = match.groups?.attrs ?? "";
      if (!/aria-label|aria-labelledby|title=/.test(attrs)) {
        nameless.push(`${file}: ${match[0].replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(
    nameless,
    [],
    "hiding the glyph without naming the button trades a bad name for no name:\n" +
      nameless.join("\n")
  );
});
