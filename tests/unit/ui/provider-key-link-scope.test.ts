import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The release note for #50 said the Add API Key dialog "links to the page that issues the
// key". It does — for 16 of the 355 providers. The other 339 get the provider's own site,
// which the dialog labels correctly; only the note overstated it. This pins the claim to
// the catalog so the corrected sentence cannot quietly become wrong again.

const catalogDir = fileURLToPath(
  new URL("../../../src/shared/constants/providers/", import.meta.url)
);

function providerSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...providerSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = providerSources(catalogDir).map((f) => readFileSync(f, "utf8"));
assert.ok(sources.length > 0, "the provider catalog must be readable");

const keyUrls = sources.reduce((n, src) => n + [...src.matchAll(/apiKeyUrl/g)].length, 0);
const providers = sources.reduce((n, src) => n + [...src.matchAll(/^\s*id: "/gm)].length, 0);

test("the catalog still matches the number the release note states", () => {
  assert.equal(providers, 355, `the note says 355 providers; the catalog has ${providers}`);
  assert.equal(keyUrls, 16, `the note says 16 key-issuing links; the catalog has ${keyUrls}`);
});

test("the changelog does not claim the key page for every provider", () => {
  const changelog = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
  assert.ok(
    !changelog.includes("links to the page that issues the key. It asked for a credential"),
    "the unqualified claim is back in CHANGELOG.md"
  );
  assert.match(changelog, /\*\*16 of the 355\*\* providers the link is the exact key-issuing page/);
});

test("the dialog itself distinguishes the two links", () => {
  // The component was never the problem — it reports which of the two it is showing. If
  // that ever stops being true, the qualified sentence above becomes a lie as well.
  const component = readFileSync(
    new URL(
      "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/ProviderKeySourceLink.tsx",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(component, /isKeyPage/);
  assert.match(component, /entry\.notice\?\.apiKeyUrl/);
  assert.match(component, /entry\.website/);
});
