/**
 * Every `omniroute …` command in `docs/guides/COST_TRACKING.md` must exist in the CLI.
 *
 * #54 repointed 39 CLI commands and removed 12 whose endpoints the server never
 * implemented. `380e5a3d7` chased the documentation afterwards and fixed `skills/` and
 * `DATABASE_GUIDE.md` — but missed this file, which kept advertising four commands:
 *
 *   usage budget get [scope]                       -> get <apiKeyId>
 *   usage budget set <amount> [--scope global]     -> set <apiKeyId> --daily/--weekly/…
 *   usage budget reset [scope]                     -> removed; clear <apiKeyId>
 *   pricing defaults set [--input …]               -> removed
 *
 * `check:fabricated-docs` did not catch it: it validates the top-level command
 * (`omniroute usage` exists) and stops there, so a fabricated *subcommand* reads as
 * fine. This closes that gap for the file where it actually happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOC = path.join(ROOT, "docs", "guides", "COST_TRACKING.md");

/** Subcommand names declared in a CLI command module, e.g. `.command("get <apiKeyId>")`. */
function declaredSubcommands(moduleRelPath: string): Set<string> {
  const source = fs.readFileSync(path.join(ROOT, moduleRelPath), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/\.command\(\s*["'`]([^"'`]+)["'`]/g)) {
    // `.command("set <apiKeyId>")` declares the command `set`.
    names.add(match[1].split(/\s+/)[0]);
  }
  return names;
}

/** The `omniroute …` invocations inside fenced code blocks, as word arrays. */
function documentedInvocations(): string[][] {
  const doc = fs.readFileSync(DOC, "utf8");
  const invocations: string[][] = [];
  let inFence = false;
  for (const raw of doc.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.trim();
    if (!line.startsWith("omniroute ")) continue;
    // Stop at the first option/placeholder — only the command path is checked here.
    const words: string[] = [];
    for (const word of line.split(/\s+/).slice(1)) {
      if (word.startsWith("-") || word.startsWith("<") || word.startsWith("[")) break;
      words.push(word);
    }
    if (words.length) invocations.push(words);
  }
  return invocations;
}

const GROUPS: Record<string, { module: string; parents: string[] }> = {
  "usage budget": { module: "bin/cli/commands/usage.mjs", parents: ["usage", "budget"] },
  "pricing defaults": { module: "bin/cli/commands/pricing.mjs", parents: ["pricing", "defaults"] },
};

test("COST_TRACKING.md documents no command the CLI does not have", () => {
  const invocations = documentedInvocations();
  assert.ok(
    invocations.length > 0,
    "found no `omniroute …` lines in COST_TRACKING.md — the extraction broke, " +
      "and a test that checks nothing passes for the wrong reason"
  );

  const missing: string[] = [];
  let checked = 0;

  for (const [prefix, { module, parents }] of Object.entries(GROUPS)) {
    const declared = declaredSubcommands(module);
    for (const words of invocations) {
      if (words.slice(0, parents.length).join(" ") !== parents.join(" ")) continue;
      const sub = words[parents.length];
      if (!sub) continue; // `omniroute usage budget` on its own is the group itself
      checked += 1;
      if (!declared.has(sub)) missing.push(`omniroute ${prefix} ${sub}`);
    }
  }

  assert.ok(
    checked > 0,
    `no documented "${Object.keys(GROUPS).join('" / "')}" commands were found`
  );
  assert.deepEqual(
    missing,
    [],
    "documented commands that do not exist — a reader who copies them gets an error:\n" +
      missing.join("\n")
  );
});
