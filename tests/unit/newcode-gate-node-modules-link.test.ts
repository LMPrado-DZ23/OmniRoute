/**
 * The new-code gates (complexity-ratchets, dead-code, file-size) lint the merge-base in a
 * throwaway git worktree, and link the repo's `node_modules` into it so the linter can
 * resolve imports.
 *
 * That link used to be a `"dir"` symlink, which on Windows needs
 * SeCreateSymbolicLinkPrivilege — an elevated shell or Developer Mode. Without it
 * `fs.symlinkSync` throws `EPERM` and the gate dies *before comparing anything*, so a
 * contributor on Windows cannot run those gates locally at all and only finds out about a
 * regression when CI says so. Three separate agents shipped new-code regressions in this
 * release line for exactly that reason, each believing their local run had passed.
 *
 * A **junction** is the same thing for this purpose and needs no privilege. So:
 *   - the behavioural test proves the link works on whatever platform is running it;
 *   - the static test guards the Windows branch, because CI runs on Linux and would
 *     otherwise never notice if `"junction"` were dropped again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { linkNodeModules } from "../../scripts/check/newCodeMode.mjs";

test("links node_modules into a base worktree on this platform", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-link-src-"));
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-link-dst-"));
  const target = path.join(box, "node_modules");
  fs.writeFileSync(path.join(src, "marker.txt"), "resolved", "utf8");

  try {
    linkNodeModules(src, target);
    // Reading through the link is the real assertion: a link that exists but does not
    // resolve would leave the linter unable to find any dependency.
    assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8"), "resolved");
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("reports an actionable error instead of a bare EPERM", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-link-src-"));
  try {
    // Target inside a directory that does not exist — the link cannot be created.
    assert.throws(
      () => linkNodeModules(src, path.join(src, "missing-parent", "node_modules")),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /could not link node_modules/);
        assert.match(message, /new-code gates/);
        return true;
      }
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("Windows uses a junction, which needs no elevation", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../scripts/check/newCodeMode.mjs", import.meta.url)),
    "utf8"
  );

  assert.match(
    source,
    /process\.platform === "win32" \? "junction" : "dir"/,
    'newCodeMode must pick "junction" on win32: a "dir" symlink throws EPERM without ' +
      "Developer Mode, which silently disables every new-code gate for Windows contributors. " +
      "CI runs on Linux and cannot catch this regression behaviourally."
  );
});
