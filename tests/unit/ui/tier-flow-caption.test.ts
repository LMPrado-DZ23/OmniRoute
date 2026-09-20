import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The diagram is titled "OmniRoute 4-tier fallback" and its alt text says "4-tier", but the
// caption under it enumerated only three hops — it collapsed Tier 2 (your own pay-as-you-go
// API keys) into Tier 3 and left the reader counting three. Nothing compared the two.

const en = JSON.parse(
  readFileSync(new URL("../../../src/i18n/messages/en.json", import.meta.url), "utf8")
) as { onboarding: { tierFlowDiagramAlt: string; tier: { flowCaption: string } } };

const svg = readFileSync(
  new URL("../../../public/images/tier-flow-light.svg", import.meta.url),
  "utf8"
);

test("the SVG really does show four tiers", () => {
  // The premise of the test below. If the diagram is ever redrawn with a different number
  // of tiers, this fails first and says so, instead of the caption test looking wrong.
  for (const n of [1, 2, 3, 4]) {
    assert.ok(svg.includes(`Tier ${n} —`), `the diagram must label Tier ${n}`);
  }
  assert.ok(!svg.includes("Tier 5 —"), "a fifth tier would make the caption stale again");
});

test("the English caption names every tier the diagram draws", () => {
  const caption = en.onboarding.tier.flowCaption.toLowerCase();
  // One phrase per tier, matched loosely enough to survive a rewording but not a deletion.
  const tiers: [string, RegExp][] = [
    ["Tier 1 — subscription", /subscription/],
    ["Tier 2 — your own API keys", /api key/],
    ["Tier 3 — cheap pay-per-token", /per-token|per token/],
    ["Tier 4 — free", /free/],
  ];
  for (const [label, pattern] of tiers) {
    assert.match(caption, pattern, `the caption never mentions ${label}`);
  }
});

test("the alt text and the diagram agree on the count", () => {
  assert.match(en.onboarding.tierFlowDiagramAlt, /4-tier/);
  assert.ok(svg.includes("4-tier"), "the diagram states its own tier count");
});
