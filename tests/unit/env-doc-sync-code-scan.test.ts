/**
 * `check:env-doc-sync` compares the env vars referenced in code against the ones
 * documented in `.env.example` and `ENVIRONMENT.md`. It collected the code side by
 * shelling out to:
 *
 *   grep -rhoE 'process\.env\.[A-Z][A-Z0-9_]+' src/ open-sse/ … 2>/dev/null || true
 *
 * There is no `grep` on a stock Windows box. The command failed, `2>/dev/null ||
 * true` swallowed it, and the gate compared an **empty** set of code references
 * against the documented ones — every "in code but missing from .env.example"
 * check trivially passed. A gate reporting a clean contract while measuring
 * nothing is worse than no gate, because it is believed.
 *
 * The scan is pure Node now. These tests pin both halves: that it finds
 * references at all (the assertion that would have caught the original), and that
 * it finds the right ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCodeVars } from "../../scripts/check/check-env-doc-sync.mjs";

test("the scan finds references in the real tree, on whatever platform runs it", () => {
  const vars = scanCodeVars();

  // The exact count drifts with the codebase; zero is the failure that matters,
  // and a handful would mean the walk stopped early.
  assert.ok(
    vars.size > 100,
    `expected the scan to find the repo's process.env references, got ${vars.size}. ` +
      "An empty or tiny set means the gate is comparing nothing and passing."
  );
  // A var every checkout has, from a path the walk must reach.
  assert.ok(vars.has("DATA_DIR"), "DATA_DIR is referenced across src/ and open-sse/");
});

test("it reads nested files and ignores node_modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-envscan-"));
  try {
    fs.mkdirSync(path.join(root, "src", "deep", "deeper"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "top.ts"), "const a = process.env.TOP_LEVEL_VAR;");
    fs.writeFileSync(
      path.join(root, "src", "deep", "deeper", "nested.ts"),
      "export const b = process.env.NESTED_VAR ?? '';"
    );
    fs.writeFileSync(
      path.join(root, "src", "node_modules", "pkg", "index.js"),
      "process.env.DEPENDENCY_VAR"
    );

    const vars = scanCodeVars({ cwd: root });

    assert.ok(vars.has("TOP_LEVEL_VAR"));
    assert.ok(vars.has("NESTED_VAR"), "the walk must recurse, not just read the top level");
    assert.ok(
      !vars.has("DEPENDENCY_VAR"),
      "a dependency's env vars are not this repo's contract to document"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a target that does not exist in the checkout is skipped, not thrown on", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-envscan-empty-"));
  try {
    // None of the scanned roots exist here — electron/ and bin/ are genuinely
    // absent from some checkouts, and the gate must not crash on them.
    assert.deepEqual([...scanCodeVars({ cwd: root })], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
