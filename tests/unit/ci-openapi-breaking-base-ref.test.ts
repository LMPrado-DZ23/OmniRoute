import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// check-openapi-breaking.mjs resolves the base spec with
// `git show <BASE_REF>:docs/openapi.yaml`. On a pull_request checkout (refs/pull/N/merge)
// there is no LOCAL branch named `release/vX.Y.Z` — only the remote-tracking ref — so a
// bare `github.base_ref` does not resolve, the script SKIPs, and a skip exits 0 by design.
// The gate would report green while measuring nothing.

const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
) as {
  jobs: Record<string, { steps?: { name?: string; env?: Record<string, string>; run?: string }[] }>;
};

function stepsWithEnvKey(key: string): { name: string; value: string; run: string }[] {
  const out: { name: string; value: string; run: string }[] = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const value = step.env?.[key];
      if (typeof value === "string")
        out.push({ name: step.name ?? "", value, run: step.run ?? "" });
    }
  }
  return out;
}

test("every step that resolves BASE_REF as a GIT REF passes it origin-prefixed", () => {
  const consumers = stepsWithEnvKey("BASE_REF");
  assert.ok(
    consumers.length >= 2,
    `expected BASE_REF consumers in ci.yml, found ${consumers.length}`
  );

  // `check-pr-self-target.mjs` compares branch NAMES, not git refs — a bare ref is correct
  // there, and prefixing it would break the comparison. Everything that reaches git must
  // be prefixed. Split them by what the step actually runs rather than by step name.
  const NAME_ONLY = ["check-pr-self-target"];
  for (const step of consumers) {
    const comparesNamesOnly = NAME_ONLY.some((script) => step.run.includes(script));
    if (comparesNamesOnly) continue;
    assert.match(
      step.value,
      /format\('origin\/\{0\}'/,
      `"${step.name}" passes BASE_REF to git but not origin-prefixed — it would SKIP on a PR`
    );
  }
});

test("the name-only consumer is still name-only", () => {
  // If check-pr-self-target ever starts resolving a git ref, the exemption above becomes
  // wrong and this test is the place that says so.
  const script = readFileSync(
    new URL("../../scripts/check/check-pr-self-target.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    script,
    /git\s+show|execFileSync\(\s*"git"|rev-parse/,
    "check-pr-self-target resolves a git ref now — it must take an origin-prefixed BASE_REF"
  );
});
