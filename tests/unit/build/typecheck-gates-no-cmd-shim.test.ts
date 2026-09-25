import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  planBuildToolSpawn,
  resolveLocalBinEntry,
  runBuildTool,
} from "../../../scripts/build/buildToolRunner.mjs";

// The dashboard, open-sse and api typecheck gates spawned `npx.cmd` on Windows. Since
// CVE-2024-27980 Node >= 20 refuses to spawn a `.cmd` without a shell (EINVAL), so on Windows
// they crashed with a stack dump and exit 1 instead of running or skipping — three of the four
// typecheck scripts in package.json were unusable there, and nothing said so because CI is
// Linux. They now go through the shared runner, which executes typescript's own JS entry with
// this Node binary: no shim, no shell, the same behaviour on every platform.

const GATES = [
  "scripts/check/check-api-typecheck.mjs",
  "scripts/check/check-dashboard-typecheck.mjs",
  "scripts/check/check-open-sse-typecheck.mjs",
];

const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

/**
 * Source with block and line comments removed. The comments that explain this fix mention
 * `npx.cmd` on purpose; only CODE handing it to a spawn call is the defect, so that is all
 * these assertions should see. Line comments are stripped only when `//` is not part of a
 * URL (`https://`), which none of these scripts contain in code.
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

for (const gate of GATES) {
  test(`${gate} never spawns npx.cmd`, () => {
    const source = code(gate);
    // Comments are already stripped, so any remaining mention is code.
    assert.doesNotMatch(
      source,
      /(?:npx|npm)\.cmd/,
      "a .cmd shim is EINVAL on Node >= 20 / Windows — use runBuildTool"
    );
    assert.doesNotMatch(
      source,
      /execFileSync\s*\(/,
      "spawning must go through the shared runner, not a raw execFileSync"
    );
    assert.match(source, /runBuildTool\(\s*"typescript",\s*"tsc"/);
    assert.match(source, /from "\.\.\/build\/buildToolRunner\.mjs"/);
  });
}

test("the windows plan for tsc is Node running typescript's JS entry, with no shell", () => {
  // Asserted from any platform: the platform is injected, so a Linux runner can pin the
  // decision that was wrong on Windows.
  const entry = resolveLocalBinEntry("typescript", "tsc");
  assert.ok(entry, "typescript must be installed and expose a `tsc` bin");

  const plan = planBuildToolSpawn({
    binName: "tsc",
    args: ["--noEmit", "-p", "tsconfig.json"],
    entryPath: entry,
    entryIsNative: false,
    platform: "win32",
  });
  assert.equal(plan.file, process.execPath);
  assert.equal(plan.shell, false, "a shell would disable argument escaping (DEP0190)");
  assert.deepEqual(plan.args, [entry, "--noEmit", "-p", "tsconfig.json"]);
});

test("runBuildTool RETURNS the tool's stdout — the gates parse tsc's report", () => {
  // It used to discard the result (`@returns {void}`), which is why the gates could not use
  // it. A real spawn is the only conclusive check.
  const out = runBuildTool("typescript", "tsc", ["--version"], { encoding: "utf8" });
  assert.equal(typeof out, "string");
  assert.match(String(out), /Version \d+\.\d+/);
});

test("a non-zero tsc exit still carries stdout on the thrown error", () => {
  // The gates rely on this: tsc exits 1 when there are type errors, and the report they
  // parse is in the error's stdout, not the return value.
  let caught: (Error & { stdout?: string }) | undefined;
  try {
    runBuildTool("typescript", "tsc", ["--definitely-not-a-flag"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    caught = err as Error & { stdout?: string };
  }
  assert.ok(caught, "an unknown flag makes tsc exit non-zero");
  assert.equal(typeof caught.stdout, "string", "the report must survive on err.stdout");
  assert.match(caught.stdout ?? "", /error TS5023|Unknown compiler option/i);
});
