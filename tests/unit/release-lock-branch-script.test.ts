/**
 * Guards the fallback that stands in for `lock-released-branch.yml` while the
 * `BRANCH_LOCK_TOKEN` secret does not exist.
 *
 * The bug this script exists to prevent is a SILENT one: in the v3.8.3 incident six
 * commits landed on an already-shipped version because the lock had not applied and
 * nobody checked. So the behaviour worth testing is not "does it send a PUT" — it is
 * "does it refuse to report success when GitHub says the branch is not locked".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  branchForVersion,
  protectionPath,
  readLockState,
  PROTECTION,
} from "../../scripts/release/lock-released-branch.mjs";

test("a version is accepted however the operator happens to write it", () => {
  for (const input of ["3.8.54", "v3.8.54", "release/v3.8.54", " v3.8.54 "]) {
    assert.equal(branchForVersion(input), "release/v3.8.54", `for ${JSON.stringify(input)}`);
  }
});

test("anything that is not a version is refused instead of guessed at", () => {
  for (const bad of ["", "   ", "latest", "next", "3.8", "main", "release/main", "v3.8.x"]) {
    assert.throws(() => branchForVersion(bad), `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("the branch slash is encoded, or GitHub reads it as a nested path", () => {
  assert.equal(
    protectionPath("owner/name", "release/v3.8.54"),
    "repos/owner/name/branches/release%2Fv3.8.54/protection"
  );
});

test("the payload locks the branch and binds admins to it", () => {
  assert.equal(PROTECTION.lock_branch, true);
  assert.equal(PROTECTION.enforce_admins, true);
  assert.equal(PROTECTION.allow_force_pushes, false);
  assert.equal(PROTECTION.allow_deletions, false);
});

test("a locked branch is reported as locked", () => {
  const state = readLockState("owner/name", "release/v3.8.54", () =>
    JSON.stringify({ lock: true, admins: true })
  );
  assert.deepEqual(state, { lock: true, admins: true });
});

test("a branch GitHub says is unlocked is never reported as locked", () => {
  const state = readLockState("owner/name", "release/v3.8.54", () =>
    JSON.stringify({ lock: false, admins: true })
  );
  assert.notEqual(state.lock, true, "an unlocked branch must not read back as locked");
});

test("the read-back asks GitHub, it does not echo what was sent", () => {
  const calls: string[][] = [];
  readLockState("owner/name", "release/v3.8.54", (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ lock: true, admins: true });
  });
  assert.equal(calls.length, 1, "expected exactly one API read");
  assert.ok(calls[0].includes("api"), "expected a gh api call");
  assert.ok(
    calls[0].some((a) => a.includes("release%2Fv3.8.54/protection")),
    "expected the read to target the branch's protection endpoint"
  );
});
