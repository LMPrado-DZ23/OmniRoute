/**
 * A curated URL in a field nothing reads is worse than no URL at all: it looks done,
 * it survives review, and the user still ends up on a search engine.
 *
 * `ProviderNotice.apiKeyUrl` is the one place the product reads a "where this key comes
 * from" link — `ProviderPageHeader` and `ProviderKeySourceLink` both resolve
 * `notice.apiKeyUrl`, then fall back to `website`. `ProviderCatalogMetadata` does **not**
 * declare `apiKeyUrl` at the top level, but the provider data files are wide enough to
 * accept one there without a type error.
 *
 * That is exactly what happened to `dahl`: it carried
 * `apiKeyUrl: "https://inference.dahl.global/tokens"` as a sibling of `website`, so the
 * dialog offered the generic site link instead of the page that actually mints the token.
 * Nothing failed — it simply never rendered. Moved into `notice` in the same commit as
 * this test.
 *
 * So this asserts placement, not content: a key URL must live inside `notice`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../src/shared/constants/providers/apikey/", import.meta.url));

function providerDataFiles(): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
}

/**
 * Lines holding `apiKeyUrl:` at the entry's own indentation (4 spaces) are siblings of
 * `website`; the ones the product reads sit inside `notice` at 6 spaces.
 */
function topLevelApiKeyUrlLines(text: string): number[] {
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^ {4}apiKeyUrl:/.test(line)) out.push(i + 1);
  });
  return out;
}

test("no provider carries apiKeyUrl outside its notice, where nothing reads it", () => {
  const offenders: string[] = [];

  for (const file of providerDataFiles()) {
    const text = readFileSync(dir + file, "utf8");
    for (const line of topLevelApiKeyUrlLines(text)) {
      offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `apiKeyUrl found as a sibling of 'website' instead of inside 'notice':\n  ` +
      `${offenders.join("\n  ")}\n` +
      `Only 'notice.apiKeyUrl' is read — by ProviderPageHeader and ProviderKeySourceLink. ` +
      `A key URL placed at the top level silently does nothing, and the provider falls back ` +
      `to its generic site link.`
  );
});

test("the notice key URLs that exist are absolute https", () => {
  const bad: string[] = [];

  for (const file of providerDataFiles()) {
    const text = readFileSync(dir + file, "utf8");
    for (const m of text.matchAll(/^ {6}(apiKeyUrl|signupUrl): "([^"]*)"/gm)) {
      const [, field, value] = m;
      let parsed: URL | null = null;
      try {
        parsed = new URL(value);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.protocol !== "https:") {
        bad.push(`${file} → ${field}: ${value}`);
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    `notice URLs must be absolute https — the link renders next to a credential field, ` +
      `and a non-https destination walks the user to an API console over a cleartext hop:\n  ` +
      `${bad.join("\n  ")}`
  );
});
