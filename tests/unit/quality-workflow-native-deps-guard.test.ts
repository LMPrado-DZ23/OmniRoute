import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// check:native-deps used to run only as `prebuild`, inside a full `next build` that no PR job
// executes. When the runner's npm began enforcing `allowScripts` it dropped an optional package
// and still exited 0, and nothing reported it until a release tag's installer build failed.
// The guard is a cheap script over the installed tree; this pins that it runs in the PR gate.
//
// It runs INSIDE the aggregated, non-fail-fast gate loop, not as a step of its own. A standalone
// gate step that can fail aborts the job and reports every later gate as "skipped" — the #8542
// mechanism that tests/unit/repro-8542.test.ts forbids. My first version was a standalone step
// and that test caught it, so this one pins the shape that survives.

type Step = { name?: string; uses?: string; run?: string; "continue-on-error"?: unknown };
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/quality.yml", import.meta.url), "utf8")
) as { jobs: Record<string, { steps?: Step[] }> };

const steps = workflow.jobs["fast-gates"]?.steps ?? [];
const loopStep = steps.find((s) => (s.name ?? "").startsWith("Quality gates"));

/** The entries of the `gates=( … )` bash array, comments removed. */
function gateList(run: string): string[] {
  const m = /gates=\(\n([\s\S]*?)\n\s*\)\n\s*ratchet_gates=/.exec(run);
  assert.ok(m, "could not find the gates=( … ) array in the Quality gates step");
  return m[1]
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/\s+/));
}

test("fast-gates runs native-deps inside the aggregated gate loop", () => {
  assert.ok(loopStep?.run, "the `Quality gates (all, non-fail-fast)` step must still exist");
  const gates = gateList(loopStep.run as string);
  assert.ok(
    gates.includes("native-deps"),
    `native-deps is not in the gate list: ${gates.join(" ")}`
  );
});

test("it is the FIRST gate, so a dropped package is the first thing the log reports", () => {
  const gates = gateList((loopStep?.run as string) ?? "");
  assert.equal(gates[0], "native-deps");
});

test("it is NOT a standalone step — that would fail-fast into every later gate (#8542)", () => {
  const standalone = steps.filter(
    (s) => s !== loopStep && (s.run ?? "").includes("check:native-deps")
  );
  assert.deepEqual(
    standalone.map((s) => s.name),
    [],
    "a separate step that can fail masks all later gates; add it to the gates=( ) list instead"
  );
});

test("the loop runs each gate as `npm run check:<name>` without swallowing the exit code", () => {
  const run = (loopStep?.run as string) ?? "";
  assert.match(run, /npm run "check:\$g"/);
  assert.match(run, /failed\+=\("\$g"\)/, "failures must be collected, not dropped");
  // Not `|| true`: exiting 0 is precisely how the original drop went unnoticed.
  assert.doesNotMatch(run, /check:native-deps[^\n]*\|\|\s*true/);
});

test("the script it runs is still wired to the same npm script", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts["check:native-deps"], /check-native-deps\.mjs/);
  assert.match(pkg.scripts.prebuild, /check:native-deps/);
});
