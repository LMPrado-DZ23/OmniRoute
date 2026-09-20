/**
 * A fork PR must never execute on the maintainer's self-hosted LAN runner.
 *
 * `quality.yml` states that rule in its own comments, and `ci.yml`'s build job
 * implements it — but `quality.yml`'s `lint-guard` job selected the `omni-light`
 * pool with no fork clause at all:
 *
 *   runs-on: ${{ (vars.USE_VPS_RUNNER == 'true' && fromJSON('["self-hosted","omni-light"]')) || 'ubuntu-latest' }}
 *
 * It triggers on `pull_request` against `release/**`, and it runs `npm ci` without
 * `--ignore-scripts` against the fork's own lockfile — arbitrary code execution on a
 * persistent machine that keeps state between jobs. The very next line sets
 * `continue-on-error` for forks, so it would have gone green.
 *
 * A security audit found it by reading the two selectors side by side. Nothing
 * compared them automatically, so this does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WORKFLOWS_DIR = path.join(process.cwd(), ".github", "workflows");
const FORK_GUARD = "head.repo.full_name == github.repository";

/** The `on:` block of a workflow, as raw text. */
function triggerBlock(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Za-z]/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

test("every self-hosted runner in a pull_request workflow carries the fork guard", () => {
  const offenders: string[] = [];
  let selectorsChecked = 0;

  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"))) {
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    if (!triggerBlock(source).includes("pull_request")) continue;

    source.split("\n").forEach((line, index) => {
      if (!/^\s*runs-on:/.test(line) || !line.includes("self-hosted")) return;
      selectorsChecked += 1;
      if (!line.includes(FORK_GUARD)) {
        offenders.push(`${file}:${index + 1} — ${line.trim()}`);
      }
    });
  }

  // If this drops to 0 the test has stopped testing anything — the selectors were
  // renamed or moved, and the guard needs re-locating rather than silently passing.
  assert.ok(
    selectorsChecked > 0,
    "expected at least one self-hosted runs-on in a pull_request workflow; " +
      "if the pools moved, point this test at them"
  );

  assert.deepEqual(
    offenders,
    [],
    "a fork PR would run on the maintainer's persistent LAN runner:\n" + offenders.join("\n")
  );
});
