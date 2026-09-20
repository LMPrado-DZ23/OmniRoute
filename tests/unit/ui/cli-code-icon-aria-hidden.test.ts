import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Material Symbols renders its icon by LIGATURE: the element's text content is the literal
// word ("content_copy", "warning"), so an unhidden icon span is read out as that word. axe's
// `button-name` rule passes either way — a button whose accessible name is "content_copy"
// has a name — so no tool flags it. This surface was audited and is now at zero; the test
// is what keeps it there.
//
// KNOWN, WIDER GAP: repository-wide the same pattern appears 1630 times and 1138 of those
// still lack aria-hidden, across 279 files. That is pre-existing and far beyond this
// release; asserting it here would be a red that blocks a release rather than a guard.

const ROOT = new URL("../../../src/app/(dashboard)/dashboard/cli-code/", import.meta.url);

function tsxFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...tsxFiles(new URL(`${entry.name}/`, dir)));
    // fileURLToPath, not `.pathname`: on Windows the latter yields "/C:/…" and every
    // read then fails as "C:\C:\…" — which would make this scan find nothing and pass.
    else if (entry.name.endsWith(".tsx")) out.push(join(fileURLToPath(dir), entry.name));
  }
  return out;
}

const ICON_SPAN = /<span([^>]*?)className="[^"]*material-symbols-outlined[^"]*"([^>]*?)>/g;

test("every icon on the cli-code surface is hidden from the accessibility tree", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const file of tsxFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(ICON_SPAN)) {
      total += 1;
      if (!/aria-hidden/.test(match[1] + match[2])) {
        offenders.push(`${file.split(/cli-code[\/]/)[1]}: ${match[0].slice(0, 80)}`);
      }
    }
  }
  assert.ok(total > 100, `expected to find the icon spans, found ${total} — did the scan break?`);
  assert.deepEqual(
    offenders,
    [],
    `icon spans announced as their ligature text:\n${offenders.join("\n")}`
  );
});
