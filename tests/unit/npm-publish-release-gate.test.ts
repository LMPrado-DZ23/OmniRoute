/**
 * Policy guard: a GitHub Release must not be able to publish to npm on its own.
 *
 * This fork does not own the `omniroute` name on npm — upstream publishes it. The
 * README says so, and publishing is outside the authorisation this repository operates
 * under.
 *
 * The incident this guards against happened on v3.8.54. Publishing the GitHub Release
 * started `npm-publish.yml` through its own `release: [released]` trigger, and the run
 * went for `npm publish` of `omniroute`. It was cancelled by hand with the publish job
 * already queued.
 *
 * Two brakes existed and neither held:
 *
 *   1. The resolve step's skip-if-already-published check. It only skips when the
 *      version is ALREADY on npm. This fork runs ahead of upstream (3.8.54 here versus
 *      3.8.50 there), so every release resolves skip=false and proceeds. The brake is
 *      backwards for a fork.
 *
 *   2. `electron-release.yml`'s `vars.ENABLE_NPM_PUBLISH == 'true'` guard. Correct, but
 *      it only covers the `workflow_call` path INTO this workflow. A Release published
 *      by hand — or by any other workflow — enters through `release:` and never meets
 *      it.
 *
 * So the gate now lives in `npm-publish.yml` itself, as a `gate` job every publishing
 * job depends on. This test fails if a publishing job stops depending on it, or if a
 * new publishing job is added without it — which is exactly how the hole appeared the
 * first time: the guard was put on the caller instead of the thing being guarded.
 *
 * `workflow_dispatch` is deliberately NOT gated: it is already an explicit human action
 * and is the emergency route if the repository variable is ever wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../..");
const WORKFLOW = join(ROOT, ".github/workflows/npm-publish.yml");

/** The repository variable that authorises an npm publish from a release. */
const GATE_VARIABLE = "ENABLE_NPM_PUBLISH";
/** The job every publishing job must depend on. */
const GATE_JOB = "gate";

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
}

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function needsOf(job: WorkflowJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

test("the gate job exists and decides on the ENABLE_NPM_PUBLISH repository variable", () => {
  const workflow = loadWorkflow();
  const gate = workflow.jobs[GATE_JOB];

  assert.ok(gate, `npm-publish.yml must define a '${GATE_JOB}' job that authorises publishing`);

  const raw = readFileSync(WORKFLOW, "utf-8");
  assert.match(
    raw,
    new RegExp(`vars\\.${GATE_VARIABLE}`),
    `the '${GATE_JOB}' job must read the ${GATE_VARIABLE} repository variable — ` +
      `without it the gate cannot tell an authorised release from an accidental one`
  );
});

test("every publishing job depends on the gate and honours its answer", () => {
  const workflow = loadWorkflow();
  const offenders: string[] = [];

  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === GATE_JOB) continue;

    if (!needsOf(job).includes(GATE_JOB)) {
      offenders.push(`${name}: does not 'needs: ${GATE_JOB}'`);
      continue;
    }
    if (!String(job.if ?? "").includes(`needs.${GATE_JOB}.outputs.allowed`)) {
      offenders.push(`${name}: 'needs: ${GATE_JOB}' but its 'if:' never reads the gate's answer`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `job(s) in npm-publish.yml can publish without passing the authorisation gate:\n  ` +
      `${offenders.join("\n  ")}\n` +
      `A 'needs:' without an 'if:' does NOT stop a job — it only orders it. Both are required.\n` +
      `This fork does not own the 'omniroute' name on npm; a release must not publish it ` +
      `unless ${GATE_VARIABLE} is set to 'true'.`
  );
});

test("the release trigger is the one the gate is there to catch", () => {
  const workflow = loadWorkflow();

  assert.ok(
    workflow.on && "release" in workflow.on,
    "this guard assumes npm-publish.yml is reachable from a 'release' event; " +
      "if that trigger is removed, revisit whether the gate is still the right shape"
  );
});
