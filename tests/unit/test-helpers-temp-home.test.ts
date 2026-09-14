/**
 * tests/helpers/tempHome.ts must redirect os.homedir() on every platform (HOME on POSIX,
 * USERPROFILE on Windows) and restore both variables exactly, including deleting a variable that
 * was unset before (finding F-9).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redirectHome } from "../helpers/tempHome.ts";

test("redirectHome points os.homedir(), HOME and USERPROFILE at the directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-temp-home-"));
  const restore = redirectHome(dir);
  try {
    assert.equal(os.homedir(), dir);
    assert.equal(process.env.HOME, dir);
    assert.equal(process.env.USERPROFILE, dir);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore puts back the previous values and deletes variables that were unset", () => {
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-temp-home-"));
  try {
    process.env.HOME = "previous-home";
    delete process.env.USERPROFILE;

    const restore = redirectHome(dir);
    restore();

    assert.equal(process.env.HOME, "previous-home");
    assert.equal(
      "USERPROFILE" in process.env,
      false,
      "USERPROFILE must be deleted, not 'undefined'"
    );
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(os.homedir() === dir, false, "the real home is back after restoring");
});
