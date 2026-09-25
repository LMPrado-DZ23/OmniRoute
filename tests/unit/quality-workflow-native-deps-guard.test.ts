import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// check:native-deps used to run only as `prebuild`, inside a full `next build` that no PR job
// executes. When the runner's npm began enforcing `allowScripts` it dropped an optional package
// and still exited 0, and nothing reported it until a release tag's installer build failed.
// The guard is a cheap script over the installed tree; this pins that it runs in the PR gate,
// right after the install — where it can catch a lockfile change before a release does.

type Step = { name?: string; uses?: string; run?: string };
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/quality.yml", import.meta.url), "utf8")
) as { jobs: Record<string, { steps?: Step[] }> };

const steps = workflow.jobs["fast-gates"]?.steps ?? [];

test("fast-gates runs check:native-deps in the PR gate", () => {
  assert.ok(steps.length > 0, "fast-gates must still exist and have steps");
  const guard = steps.findIndex((s) => (s.run ?? "").includes("check:native-deps"));
  assert.ok(guard >= 0, "fast-gates no longer runs check:native-deps");
});

test("it runs immediately after the install, before any other gate can hide a drop", () => {
  const install = steps.findIndex((s) => (s.uses ?? "").includes("npm-ci-retry"));
  const guard = steps.findIndex((s) => (s.run ?? "").includes("check:native-deps"));
  assert.ok(install >= 0, "fast-gates must install dependencies with npm-ci-retry");
  assert.equal(
    guard,
    install + 1,
    "check:native-deps must be the step directly after the install — anything between the two " +
      "runs against a tree that may already be missing a package"
  );
});

test("it is a hard gate: not advisory and not continue-on-error", () => {
  const guard = steps.find((s) => (s.run ?? "").includes("check:native-deps")) as
    (Step & { "continue-on-error"?: unknown }) | undefined;
  assert.ok(guard);
  assert.equal(
    guard["continue-on-error"],
    undefined,
    "a native-deps drop must fail the job — exiting 0 is precisely how it went unnoticed"
  );
  // The escape hatch must not be set for this step.
  assert.ok(!(guard.run ?? "").includes("OMNIROUTE_SKIP_NATIVE_DEP_CHECK"));
});

test("the script it runs is still wired to the same npm script", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["check:native-deps"], /check-native-deps\.mjs/);
  assert.match(pkg.scripts.prebuild, /check:native-deps/);
});
